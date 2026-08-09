import type { EventEnvelope } from "@loom/core";
import { StaleFenceError, SubscriberRegistry, bucketOf, fenceOf } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { Client, type Notification, Pool, type PoolConfig } from "pg";
import { type PgConfig, nextSenderId, toPool } from "./pool";
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
  private readonly pool: Pool;
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
    this.ready = migrate(this.pool);
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
    const result = await this.pool.query(
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
    );
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
   * `jsonb_to_recordset` keeps it a single bind parameter regardless of batch size. The
   * fence check is a JOIN rather than the scalar subquery `append` uses, because a batch
   * may span executions (that is exactly what `CoalescingEventStore` produces) and each
   * envelope must be checked against its OWN execution's fence.
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
    // The `rejected` CTE is what makes it atomic. Filtering the INSERT to only the
    // qualifying rows would COMMIT the good ones and leave us throwing afterwards, with the
    // statement already succeeded — exactly the hole the SPI forbids. With the NOT EXISTS
    // guard, one fenced envelope means zero rows land.
    //
    // Notifying per ENVELOPE rather than per execution tip keeps delivery identical to
    // per-event `append`: a cross-node subscriber sees every event, not just the last of a
    // batch. It costs nothing extra — `pg_notify` is transactional, so these are delivered
    // only if the statement commits, and they ride the same round-trip.
    const { rows: notified } = await this.pool.query<{ inserted: number }>(
      `WITH batch AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
           id text, workflow_id text, execution_id text, event_type text,
           "sequence" bigint, "timestamp" bigint, payload jsonb, metadata jsonb,
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
    );
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
    // SP-1 (SPI 1.2.0) — keyset over idx_events_exec: lexicographic, bounded memory.
    await this.ready;
    const limit = opts?.limit ?? 1000;
    const { rows } =
      opts?.cursor === undefined
        ? await this.pool.query<{ execution_id: string }>(
            "SELECT DISTINCT execution_id FROM events ORDER BY execution_id LIMIT $1",
            [limit + 1]
          )
        : await this.pool.query<{ execution_id: string }>(
            "SELECT DISTINCT execution_id FROM events WHERE execution_id > $1 ORDER BY execution_id LIMIT $2",
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
    const cfg = this.connConfig;
    const clientConfig: string | PoolConfig =
      typeof cfg === "string"
        ? cfg
        : cfg instanceof Pool
          ? (cfg.options as PoolConfig)
          : (cfg as PoolConfig);
    const client =
      typeof clientConfig === "string"
        ? new Client({ connectionString: clientConfig })
        : new Client(clientConfig);
    this.listener = client;
    this.listenerReady = (async () => {
      await client.connect();
      client.on("notification", (msg: Notification) => {
        if (msg.payload === undefined) return;
        void this.onNotify(msg.payload);
      });
      // No blanket LISTEN. Channels are subscribed per bucket, on demand, by
      // `onInterestChange` — receiving only what this node has interest in is the point.
    })();
    return this.listenerReady;
  }

  private async onNotify(raw: string): Promise<void> {
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
