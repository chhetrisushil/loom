import type { EventEnvelope } from "@loom/core";
import {
  DuplicateEnvelopeIdError,
  DuplicateSequenceError,
  StaleFenceError,
  SubscriberRegistry,
  bucketOf,
  fenceOf,
} from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { Client, type Notification } from "pg";
import { type PgConfig, type PoolLike, nextSenderId, toClientConfig, toPool } from "./pool";
import { NOTIFY_CHANNEL, migrate } from "./schema";

export interface PostgresEventStoreOptions {
  /**
   * How many NOTIFY channels to spread executions over (ADR 0074 D4 — interest-filtered
   * delivery). A node LISTENs only on buckets it actually holds subscriptions for, instead
   * of receiving every event in the database and discarding what it does not want.
   *
   * Measured: the unfiltered broadcast costs the WRITER 2.07–2.19x throughput at four
   * subscriber nodes, with delivery of exactly one notification per node per event.
   *
   * **Every node sharing a database must use the same value** — publisher and listener
   * derive the channel from it independently. `1` is the escape hatch: it publishes on the
   * legacy `loom_events` channel, byte-identical to pre-0074 behaviour, for a rolling
   * upgrade or a deployment that wants the old semantics. Default 16.
   */
  notifyBuckets?: number;
  /**
   * L10 — the lock wait bound for the one-time `events.execution_id` collation conversion
   * (see `MigrateOptions.lockTimeoutMs`). Only takes effect if this store is the first to
   * migrate its pool. Default 2000 ms.
   */
  migrationLockTimeoutMs?: number;
}

/**
 * Every NOTIFY channel name for a store built with `notifyBuckets` buckets (ADR 0074 D4).
 * Module-private: the one caller that needs the whole list is
 * {@link PostgresEventStore.notifyChannels}, an INSTANCE method, not this free function —
 * an instance is the only thing that actually knows its own configured `notifyBuckets`.
 * (An earlier version exported this as a free function taking `notifyBuckets` by hand; its
 * one external caller, `tools/bench-throughput`, had to keep its own copy of the default in
 * sync with {@link PostgresEventStoreOptions.notifyBuckets}'s default, which is exactly the
 * two-sources-of-truth bug this instance method exists to close.) `notifyBuckets <= 1`
 * returns the single legacy channel, byte-identical to what `channelFor` (below) computes
 * per envelope in that mode.
 */
function computeNotifyChannels(notifyBuckets: number): string[] {
  const buckets = Math.max(1, notifyBuckets);
  return buckets === 1
    ? [NOTIFY_CHANNEL]
    : Array.from({ length: buckets }, (_, bucket) => `${NOTIFY_CHANNEL}_${bucket}`);
}

/**
 * #306 — normalize the `UNIQUE (execution_id, sequence)` violation (SQLSTATE 23505) to the
 * portable {@link DuplicateSequenceError}, so a caller need not know which backend it is
 * talking to (or match on driver text) to recognise a lost sequence race.
 *
 * Narrowed by CONSTRAINT NAME, which node-postgres surfaces on the error: the table also
 * has a primary key on `id`, and a duplicate id is a different bug (a re-used envelope id)
 * that must not be reported as a sequence conflict. Postgres auto-names the unnamed table
 * constraint `events_execution_id_sequence_key`; the check reads the columns out of it
 * rather than pinning the whole generated name.
 */
function isDuplicateSequenceViolation(err: unknown): boolean {
  const constraint = uniqueViolationConstraint(err);
  return constraint?.includes("execution_id") === true && constraint.includes("sequence");
}

/**
 * #309 — the table's OTHER key: `id TEXT NOT NULL PRIMARY KEY`, which Postgres names
 * `events_pkey`. Distinguished from the sequence constraint by name, so each maps to its
 * own error and neither is reported as the other.
 */
function isDuplicateIdViolation(err: unknown): boolean {
  return uniqueViolationConstraint(err)?.endsWith("_pkey") === true;
}

/** The constraint a 23505 (unique_violation) names, or `undefined` for anything else. */
function uniqueViolationConstraint(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  if (code !== "23505" || typeof constraint !== "string") return undefined;
  return constraint;
}

interface EventRow {
  id: string;
  workflow_id: string;
  execution_id: string;
  event_type: string;
  sequence: string; // BIGINT → string from node-postgres
  timestamp: string; // BIGINT → string
  payload: unknown; // JSONB → parsed object
  metadata: unknown | null; // JSONB → parsed object
}

function rowToEnvelope(row: EventRow): EventEnvelope {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    executionId: row.execution_id,
    eventType: row.event_type,
    sequence: Number(row.sequence),
    timestamp: Number(row.timestamp),
    payload: row.payload,
    ...(row.metadata !== null && { metadata: row.metadata as Record<string, unknown> }),
  };
}

/**
 * Postgres-backed {@link EventStore}. The network backend that lets many workers on
 * many machines share one durable log — the horizontal-scale path the SQLite store
 * can't provide. Preserves the single-writer-per-execution invariant (D3): sequences
 * are still allocated by the in-process ExecutionJournal, so append never needs a
 * read-then-write and the UNIQUE(execution_id, sequence) constraint catches any
 * accidental double-writer.
 *
 * Live `subscribe` works both in-process (synchronous, like the SQLite store) and
 * ACROSS processes via LISTEN/NOTIFY: an append NOTIFYs a channel, and every store's
 * listener connection fans the event out to its local subscribers — skipping the
 * notifications it published itself to avoid double delivery.
 */
export class PostgresEventStore implements EventStore {
  private readonly pool: PoolLike;
  private readonly ownsPool: boolean;
  private readonly ready: Promise<void>;
  private readonly subscribers: SubscriberRegistry;
  private readonly senderId = nextSenderId();
  private readonly connConfig: PgConfig;
  private listener: Client | undefined;
  private listenerReady: Promise<void> | undefined;
  private readonly notifyBuckets: number;
  /** Executions subscribed per bucket, so we LISTEN on first and UNLISTEN on last. */
  private readonly bucketRefs = new Map<number, number>();
  /** Serializes LISTEN/UNLISTEN, which are async but triggered from a sync callback. */
  private channelWork: Promise<void> = Promise.resolve();

  constructor(config: PgConfig, options: PostgresEventStoreOptions = {}) {
    this.connConfig = config;
    this.notifyBuckets = Math.max(1, options.notifyBuckets ?? 16);
    this.subscribers = new SubscriberRegistry({
      onInterestChange: (executionId, kind) => this.onInterestChange(executionId, kind),
    });
    const { pool, owned } = toPool(config);
    this.pool = pool;
    this.ownsPool = owned;
    this.ready = migrate(this.pool, {
      ...(options.migrationLockTimeoutMs !== undefined && {
        lockTimeoutMs: options.migrationLockTimeoutMs,
      }),
    });
  }

  async append(envelope: EventEnvelope): Promise<void> {
    await this.ready;
    // K9.4 — fence-guarded insert, atomic in one statement: the row lands only if
    // the execution has no fence, or the envelope's token (0 when absent) is at
    // least the current one. A conditional zero-row insert means a zombie write.
    const fence = fenceOf(envelope) ?? 0;
    // Cross-process delivery tag: a JSON-encoded [senderId, executionId, sequence], so our
    // own listener ignores what we deliver locally. The pg_notify is folded into the insert
    // as a CTE so it fires in the SAME round-trip and ONLY when a row actually landed —
    // halving DB round-trips on the hottest write path. On a fence rejection the CTE inserts
    // 0 rows, the outer SELECT returns 0 rows, pg_notify is never called, and rowCount === 0
    // still signals the stale fence exactly as before.
    const notifyTag = JSON.stringify([this.senderId, envelope.executionId, envelope.sequence]);
    const result = await this.pool
      .query(
        `WITH ins AS (
         INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload, metadata)
         SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb
         WHERE COALESCE((SELECT fence FROM fences WHERE execution_id = $3), $9::bigint) <= $9::bigint
         RETURNING execution_id
       )
       SELECT pg_notify($10, $11) FROM ins`,
        [
          envelope.id,
          envelope.workflowId,
          envelope.executionId,
          envelope.eventType,
          envelope.sequence,
          envelope.timestamp,
          JSON.stringify(envelope.payload),
          envelope.metadata !== undefined ? JSON.stringify(envelope.metadata) : null,
          fence,
          this.channelFor(envelope.executionId),
          notifyTag,
        ]
      )
      .catch((err: unknown) => {
        // #306 — the slot was taken. Distinct from the fence rejection below, which is a
        // zero-row insert rather than a constraint violation.
        if (isDuplicateSequenceViolation(err)) {
          throw new DuplicateSequenceError(envelope.executionId, envelope.sequence, err);
        }
        if (isDuplicateIdViolation(err)) {
          throw new DuplicateEnvelopeIdError(envelope.id, envelope.executionId, err);
        }
        throw err;
      });
    if (result.rowCount === 0) {
      const { rows } = await this.pool.query<{ fence: string }>(
        "SELECT fence FROM fences WHERE execution_id = $1",
        [envelope.executionId]
      );
      throw new StaleFenceError(
        envelope.executionId,
        fenceOf(envelope),
        Number(rows[0]?.fence ?? 0)
      );
    }

    // Same-process subscribers fire synchronously (matches the SQLite contract).
    this.notifyLocal(envelope.executionId, envelope);
  }

  /**
   * ADR 0074 D1 — bulk append in ONE round-trip and ONE statement.
   *
   * One JSON-array bind parameter (`jsonb_array_elements`) keeps it a single parameter
   * regardless of batch size. The fence check is a JOIN rather than the scalar subquery
   * `append` uses, because a batch may span executions (that is exactly what
   * `CoalescingEventStore` produces) and each envelope must be checked against its OWN
   * execution's fence.
   *
   * Atomicity comes from the statement itself: the CTE inserts all qualifying rows or the
   * statement fails, so no execution is left with a hole. If any envelope is fenced out
   * the insert count is short of the batch and we throw — a caller must never read a
   * partial write as success.
   *
   * One `pg_notify` per DISTINCT execution in the batch, on that execution's bucket
   * channel, since a cross-execution flush has to wake each execution's subscribers.
   */
  async appendBatch(envelopes: readonly EventEnvelope[]): Promise<void> {
    if (envelopes.length === 0) return;
    await this.ready;
    const rows = envelopes.map((e) => ({
      id: e.id,
      workflow_id: e.workflowId,
      execution_id: e.executionId,
      event_type: e.eventType,
      sequence: e.sequence,
      timestamp: e.timestamp,
      payload: e.payload,
      metadata: e.metadata ?? null,
      fence: fenceOf(e) ?? 0,
      // Resolved per row, since a batch may span executions and therefore buckets.
      channel: this.channelFor(e.executionId),
    }));
    // Everything in one statement: the insert, the all-or-nothing fence guard, and one
    // notification per envelope.
    //
    // `payload` is read as `e->'payload'`, NOT as a typed recordset column: the
    // `jsonb_to_record(set)` family maps a JSON `null` field to SQL NULL, which the
    // `payload JSONB NOT NULL` column rejects — so the kernel's status-only
    // `EXECUTION_RESUMED` (payload `null`, ADR 0104) failed here while `append` stored it.
    // `->` keeps JSON `null` as the jsonb value `null` and yields SQL NULL only for an
    // ABSENT key (a JS `undefined` payload), which fails exactly as it does in `append`.
    //
    // The `rejected` CTE is what makes it atomic. Filtering the INSERT to only the
    // qualifying rows would COMMIT the good ones and leave us throwing afterwards, with the
    // statement already succeeded — exactly the hole the SPI forbids. With the NOT EXISTS
    // guard, one fenced envelope means zero rows land.
    //
    // Notifying per ENVELOPE rather than per execution tip keeps delivery identical to
    // per-event `append`: a cross-node subscriber sees every event, not just the last of a
    // batch. It costs nothing extra — `pg_notify` is transactional, so these are delivered
    // only if the statement commits, and they ride the same round-trip.
    const { rows: notified } = await this.pool
      .query<{ inserted: number }>(
        `WITH batch AS (
         SELECT x.id, x.workflow_id, x.execution_id, x.event_type, x."sequence", x."timestamp",
                e->'payload' AS payload, x.metadata, x.fence, x.channel
         FROM jsonb_array_elements($1::jsonb) AS e,
              LATERAL jsonb_to_record(e) AS x(
                id text, workflow_id text, execution_id text, event_type text,
                "sequence" bigint, "timestamp" bigint, metadata jsonb,
                fence bigint, channel text
              )
       ), rejected AS (
         SELECT 1 FROM batch b
         LEFT JOIN fences f ON f.execution_id = b.execution_id
         WHERE COALESCE(f.fence, b.fence) > b.fence
         LIMIT 1
       ), ins AS (
         INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload, metadata)
         SELECT b.id, b.workflow_id, b.execution_id, b.event_type, b."sequence", b."timestamp",
                b.payload, b.metadata
         FROM batch b
         WHERE NOT EXISTS (SELECT 1 FROM rejected)
         RETURNING execution_id
       )
       SELECT (SELECT count(*)::int FROM ins) AS inserted,
              pg_notify(b.channel, json_build_array($2::text, b.execution_id, b."sequence")::text)
       FROM batch b
       WHERE NOT EXISTS (SELECT 1 FROM rejected)`,
        [JSON.stringify(rows), this.senderId]
      )
      .catch(async (err: unknown) => {
        // #306 — a taken slot, in the batch or already in the log. The statement is atomic,
        // so nothing landed; locate the offender for an error that names the actual conflict
        // rather than the constraint. Failure path only, so the extra round-trip is free.
        if (isDuplicateSequenceViolation(err) || isDuplicateIdViolation(err)) {
          throw await this.duplicateIn(envelopes, err);
        }
        throw err;
      });
    if (notified.length !== envelopes.length || notified[0]?.inserted !== envelopes.length) {
      // Nothing landed. Identify the offending envelope for a useful error — this is the
      // failure path, so an extra round-trip is fine.
      const executionIds = [...new Set(envelopes.map((e) => e.executionId))];
      const { rows: fenceRows } = await this.pool.query<{ execution_id: string; fence: string }>(
        "SELECT execution_id, fence FROM fences WHERE execution_id = ANY($1)",
        [executionIds]
      );
      const current = new Map(fenceRows.map((r) => [r.execution_id, Number(r.fence)]));
      const offender = envelopes.find((e) => {
        const stored = current.get(e.executionId);
        return stored !== undefined && stored > (fenceOf(e) ?? 0);
      });
      const target = offender ?? (envelopes[0] as EventEnvelope);
      throw new StaleFenceError(
        target.executionId,
        fenceOf(target),
        current.get(target.executionId) ?? 0
      );
    }
    // Same-process subscribers fire synchronously, matching `append`'s contract.
    for (const envelope of envelopes) this.notifyLocal(envelope.executionId, envelope);
  }

  /**
   * Which envelope in a rejected batch claimed something already taken — a
   * `(executionId, sequence)` slot or an envelope `id`, either because the log already held
   * it or because another envelope in the SAME batch did. One query for the whole batch;
   * the statement rolled back, so anything occupied now was occupied before. Slot reported
   * before id, so a writer that lost a sequence race is told THAT rather than told about
   * the id its own naming convention derived from the sequence it lost.
   */
  private async duplicateIn(envelopes: readonly EventEnvelope[], cause: unknown): Promise<Error> {
    const { rows } = await this.pool.query<{
      execution_id: string;
      sequence: string;
      id: string;
    }>(
      `SELECT e.execution_id, e.sequence, e.id FROM events e
         JOIN jsonb_to_recordset($1::jsonb) AS c(execution_id text, "sequence" bigint, id text)
           ON (c.execution_id = e.execution_id AND c."sequence" = e.sequence) OR c.id = e.id`,
      [
        JSON.stringify(
          envelopes.map((e) => ({ execution_id: e.executionId, sequence: e.sequence, id: e.id }))
        ),
      ]
    );
    const occupiedSlots = new Set(rows.map((r) => `${r.execution_id} ${Number(r.sequence)}`));
    const occupiedIds = new Set(rows.map((r) => r.id));
    const claimedSlots = new Set<string>();
    const claimedIds = new Set<string>();
    for (const e of envelopes) {
      const slot = `${e.executionId} ${e.sequence}`;
      if (occupiedSlots.has(slot) || claimedSlots.has(slot)) {
        return new DuplicateSequenceError(e.executionId, e.sequence, cause);
      }
      if (occupiedIds.has(e.id) || claimedIds.has(e.id)) {
        return new DuplicateEnvelopeIdError(e.id, e.executionId, cause);
      }
      claimedSlots.add(slot);
      claimedIds.add(e.id);
    }
    return cause instanceof Error ? cause : new Error(String(cause));
  }

  async read(executionId: string): Promise<EventEnvelope[]> {
    await this.ready;
    const { rows } = await this.pool.query<EventRow>(
      "SELECT * FROM events WHERE execution_id = $1 ORDER BY sequence ASC",
      [executionId]
    );
    return rows.map(rowToEnvelope);
  }

  async readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    await this.ready;
    const { rows } = await this.pool.query<EventRow>(
      "SELECT * FROM events WHERE execution_id = $1 AND sequence >= $2 ORDER BY sequence ASC",
      [executionId, fromSequence]
    );
    return rows.map(rowToEnvelope);
  }

  async head(executionId: string): Promise<number | null> {
    await this.ready;
    const { rows } = await this.pool.query<{ tip: string | number | null }>(
      "SELECT MAX(sequence) AS tip FROM events WHERE execution_id = $1",
      [executionId]
    );
    const tip = rows[0]?.tip;
    // `MAX(bigint)` comes back as a string through node-postgres.
    return tip === null || tip === undefined ? null : Number(tip);
  }

  async readRange(
    executionId: string,
    fromSequence: number,
    toSequence: number
  ): Promise<EventEnvelope[]> {
    if (toSequence < fromSequence) return [];
    await this.ready;
    const { rows } = await this.pool.query<EventRow>(
      "SELECT * FROM events WHERE execution_id = $1 AND sequence >= $2 AND sequence <= $3 ORDER BY sequence ASC",
      [executionId, fromSequence, toSequence]
    );
    return rows.map(rowToEnvelope);
  }

  async copyPrefix(
    fromExecutionId: string,
    toExecutionId: string,
    throughSequence: number,
    metadata: Record<string, unknown>
  ): Promise<void> {
    await this.ready;
    // Copy the prefix entirely inside Postgres — payload JSONB stays server-side (no
    // JS round-trip), id/execution_id are re-stamped, and provenance metadata is
    // merged with the JSONB concat operator (`||`, right-hand wins, like SQLite's
    // json_patch). O(P) rows, zero JS (de)serialization.
    await this.pool.query(
      `INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload, metadata)
       SELECT $1 || '-' || sequence, workflow_id, $2, event_type, sequence, timestamp, payload,
              COALESCE(metadata, '{}'::jsonb) || $3::jsonb
       FROM events WHERE execution_id = $4 AND sequence <= $5`,
      [toExecutionId, toExecutionId, JSON.stringify(metadata), fromExecutionId, throughSequence]
    );
  }

  async acquireFence(executionId: string): Promise<number> {
    await this.ready;
    // Atomic increment-and-return; the upsert makes concurrent acquirers strictly
    // ordered, so two nodes can never hold the same token.
    const { rows } = await this.pool.query<{ fence: string }>(
      `INSERT INTO fences (execution_id, fence) VALUES ($1, 1)
       ON CONFLICT (execution_id) DO UPDATE SET fence = fences.fence + 1
       RETURNING fence`,
      [executionId]
    );
    return Number(rows[0]?.fence ?? 1);
  }

  async subscribe(
    executionId: string,
    handler: (event: EventEnvelope) => void
  ): Promise<() => void> {
    await this.ready;
    await this.ensureListener();
    const unsubscribe = this.subscribers.add(executionId, handler);
    // `add` fires onInterestChange synchronously, which queues a LISTEN. Await it so the
    // caller cannot append-then-miss its own subscription's first cross-node event.
    await this.channelWork;
    return unsubscribe;
  }

  async deleteExecution(executionId: string): Promise<void> {
    await this.ready;
    await this.pool.query("DELETE FROM events WHERE execution_id = $1", [executionId]);
  }

  async truncatePrefix(executionId: string, throughSequence: number): Promise<void> {
    await this.ready;
    // Preserve sequence 0 (bootstrap anchor); drop (0..throughSequence].
    await this.pool.query(
      "DELETE FROM events WHERE execution_id = $1 AND sequence > 0 AND sequence <= $2",
      [executionId, throughSequence]
    );
  }

  async truncatePrefixKeeping(
    executionId: string,
    throughSequence: number,
    keepEventTypes: readonly string[]
  ): Promise<void> {
    await this.ready;
    // ADR 0106 — one statement: sequence 0 and every kept-type event survive in place.
    await this.pool.query(
      "DELETE FROM events WHERE execution_id = $1 AND sequence > 0 AND sequence <= $2 AND event_type <> ALL($3::text[])",
      [executionId, throughSequence, [...keepEventTypes]]
    );
  }

  async listExecutions(): Promise<string[]> {
    await this.ready;
    const { rows } = await this.pool.query<{ execution_id: string }>(
      "SELECT DISTINCT execution_id FROM events"
    );
    return rows.map((r) => r.execution_id);
  }

  async listExecutionsPage(opts?: {
    cursor?: string;
    limit?: number;
  }): Promise<{ executionIds: string[]; nextCursor?: string }> {
    // SP-1 (SPI 1.2.0) — keyset over idx_events_exec, bounded memory. SPI 1.6.0 (L10): in
    // code point order, i.e. `COLLATE "C"`, NOT the database's collation — `ShardedEventStore`
    // merges shard pages in code point order and resumes every shard from the merged page's
    // last id, so a shard paging in `en_US.UTF-8` order skipped ids. The column is declared
    // `COLLATE "C"` (schema.ts), so idx_events_exec serves this; the explicit clause keeps the
    // ORDER correct even on a schema whose column predates that.
    await this.ready;
    const limit = opts?.limit ?? 1000;
    const { rows } =
      opts?.cursor === undefined
        ? await this.pool.query<{ execution_id: string }>(
            'SELECT DISTINCT execution_id COLLATE "C" AS execution_id FROM events ORDER BY 1 LIMIT $1',
            [limit + 1]
          )
        : await this.pool.query<{ execution_id: string }>(
            'SELECT DISTINCT execution_id COLLATE "C" AS execution_id FROM events WHERE execution_id COLLATE "C" > $1 ORDER BY 1 LIMIT $2',
            [opts.cursor, limit + 1]
          );
    const executionIds = rows.slice(0, limit).map((r) => r.execution_id);
    const last = executionIds[executionIds.length - 1];
    return {
      executionIds,
      ...(rows.length > limit && last !== undefined && { nextCursor: last }),
    };
  }

  async close(): Promise<void> {
    if (this.listener !== undefined) {
      await this.listener.end();
      this.listener = undefined;
    }
    if (this.ownsPool) await this.pool.end();
  }

  private notifyLocal(_executionId: string, event: EventEnvelope): void {
    this.subscribers.emit(event);
  }

  /**
   * Every NOTIFY channel THIS instance publishes and LISTENs across (ADR 0074 D4) — read
   * off the instance's own configured `notifyBuckets`, not a caller's guess at the default.
   * The single source of truth for an external LISTENer (a bring-your-own subscriber, a
   * conformance check, or `tools/bench-throughput`'s fan-out scenarios) that wants to
   * subscribe to everything this store fires: it asks the instance it is actually paired
   * with, rather than hard-coding a bucket count that could silently drift out of sync with
   * whatever this instance was actually constructed with.
   */
  notifyChannels(): string[] {
    return computeNotifyChannels(this.notifyBuckets);
  }

  /** The channel an execution's notifications travel on. */
  private channelFor(executionId: string): string {
    // One bucket ⇒ the legacy channel name verbatim, so `notifyBuckets: 1` stays
    // wire-compatible with pre-ADR-0074 nodes.
    return this.notifyBuckets === 1
      ? NOTIFY_CHANNEL
      : `${NOTIFY_CHANNEL}_${bucketOf(executionId, this.notifyBuckets)}`;
  }

  /**
   * Track per-bucket interest and LISTEN/UNLISTEN as it appears and disappears. This is
   * the whole point of bucketing: a node asks the database only for the buckets it holds
   * subscriptions for, instead of receiving every event and filtering client-side.
   */
  private onInterestChange(executionId: string, kind: "first" | "last"): void {
    const channel = this.channelFor(executionId);
    const bucket = this.notifyBuckets === 1 ? 0 : bucketOf(executionId, this.notifyBuckets);
    const refs = this.bucketRefs.get(bucket) ?? 0;
    if (kind === "first") {
      this.bucketRefs.set(bucket, refs + 1);
      if (refs === 0) this.queueChannel(`LISTEN "${channel}"`);
    } else {
      const next = refs - 1;
      if (next <= 0) {
        this.bucketRefs.delete(bucket);
        this.queueChannel(`UNLISTEN "${channel}"`);
      } else {
        this.bucketRefs.set(bucket, next);
      }
    }
  }

  /** Chain LISTEN/UNLISTEN so they apply in interest order on the one listener session. */
  private queueChannel(sql: string): void {
    this.channelWork = this.channelWork
      .then(async () => {
        await this.ensureListener();
        await this.listener?.query(sql);
      })
      .catch(() => {
        // A failed LISTEN degrades cross-node delivery to nothing for that bucket; it must
        // not reject an unrelated append or subscribe. The log stays authoritative.
      });
  }

  // Lazily open a dedicated LISTEN connection (a pooled client can't hold LISTEN).
  private ensureListener(): Promise<void> {
    if (this.listenerReady !== undefined) return this.listenerReady;
    const clientConfig = toClientConfig(this.connConfig);
    if (clientConfig === undefined) {
      // A pool-like that exposes no `options`, so there are no connection parameters to
      // open a second session with. Everything else keeps working — the log stays
      // authoritative and same-process subscribers are still served synchronously; only
      // cross-node NOTIFY delivery is unavailable. Memoize the give-up so we do not
      // re-derive it on every interest change, and let `queueChannel`'s optional call
      // on `this.listener` no-op.
      this.listenerReady = Promise.resolve();
      return this.listenerReady;
    }
    const client =
      typeof clientConfig === "string"
        ? new Client({ connectionString: clientConfig })
        : new Client(clientConfig);
    this.listener = client;
    this.listenerReady = (async () => {
      await client.connect();
      client.on("notification", (msg: Notification) => {
        if (msg.payload === undefined) return;
        // Safe to leave unawaited: `onNotify` is documented never to reject.
        void this.onNotify(msg.payload);
      });
      // No blanket LISTEN. Channels are subscribed per bucket, on demand, by
      // `onInterestChange` — receiving only what this node has interest in is the point.
    })();
    return this.listenerReady;
  }

  /**
   * Handle one NOTIFY. **Never rejects** — the guarantee lives here rather than at the call
   * site because the only caller is an emitter callback that cannot await it: an escaping
   * rejection would be UNHANDLED, and Node terminates the process by default. A database
   * blip on the cross-node delivery path would take the node down.
   *
   * Swallowing is the right degradation, and the one this file already applies to a failed
   * LISTEN: the log is authoritative, so a dropped notification costs a subscriber its live
   * wake-up, not correctness — the event is read on the next delivery or fold.
   */
  private async onNotify(raw: string): Promise<void> {
    try {
      await this.deliverNotified(raw);
    } catch {
      // Intentionally silent; see above.
    }
  }

  private async deliverNotified(raw: string): Promise<void> {
    let sender: string;
    let executionId: string;
    let sequence: number;
    try {
      [sender, executionId, sequence] = JSON.parse(raw) as [string, string, number];
    } catch {
      return;
    }
    // Skip our own appends — already delivered synchronously to local subscribers.
    if (sender === this.senderId) return;
    // A bucket carries several executions; keep the local interest check.
    if (!this.subscribers.has(executionId)) return;
    const { rows } = await this.pool.query<EventRow>(
      "SELECT * FROM events WHERE execution_id = $1 AND sequence = $2 LIMIT 1",
      [executionId, sequence]
    );
    const row = rows[0];
    if (row !== undefined) this.notifyLocal(executionId, rowToEnvelope(row));
  }
}
