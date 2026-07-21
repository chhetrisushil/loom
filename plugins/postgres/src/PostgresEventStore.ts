import type { EventEnvelope } from "@loom/core";
import { StaleFenceError, fenceOf } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { Client, type Notification, Pool, type PoolConfig } from "pg";
import { type PgConfig, nextSenderId, toPool } from "./pool";
import { NOTIFY_CHANNEL, migrate } from "./schema";

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
  private readonly subscribers = new Map<string, Set<(event: EventEnvelope) => void>>();
  private readonly senderId = nextSenderId();
  private readonly connConfig: PgConfig;
  private listener: Client | undefined;
  private listenerReady: Promise<void> | undefined;

  constructor(config: PgConfig) {
    this.connConfig = config;
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
        NOTIFY_CHANNEL,
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
    let handlers = this.subscribers.get(executionId);
    if (handlers === undefined) {
      handlers = new Set();
      this.subscribers.set(executionId, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.subscribers.delete(executionId);
    };
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

  private notifyLocal(executionId: string, event: EventEnvelope): void {
    const handlers = this.subscribers.get(executionId);
    if (handlers === undefined) return;
    for (const handler of handlers) handler(event);
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
      await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
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
    if (!this.subscribers.has(executionId)) return;
    const { rows } = await this.pool.query<EventRow>(
      "SELECT * FROM events WHERE execution_id = $1 AND sequence = $2 LIMIT 1",
      [executionId, sequence]
    );
    const row = rows[0];
    if (row !== undefined) this.notifyLocal(executionId, rowToEnvelope(row));
  }
}
