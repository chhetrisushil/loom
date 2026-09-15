import type { PoolLike } from "./pool";

// Advisory-lock key for the migration, as the two-int form: ("LOOM" as ASCII, 1).
// Application-defined and namespaced to this library, so it cannot collide with an
// application's own advisory locks unless it picks the same pair deliberately.
const MIGRATION_LOCK_NAMESPACE = 0x4c4f4f4d; // "LOOM"
const MIGRATION_LOCK_ID = 1;

// One in-flight/completed migration per Pool. Every store constructor calls migrate()
// on its own pool, so without this a process sharing one pool across six stores would
// issue the DDL six times. Keyed weakly so a discarded pool is not retained.
const migrations = new WeakMap<PoolLike, Promise<void>>();

/**
 * One idempotent migration for all Loom store tables, mirroring the SQLite schema
 * (packages/event-runtime/src/schema.ts + snapshot-runtime). JSONB for payload /
 * metadata / state; BIGINT for sequence / timestamps (parsed back to JS numbers in
 * the row mappers, since node-postgres returns int8 as a string). Any of the stores
 * can bootstrap the full schema, so they compose on one database.
 *
 * **Concurrency-safe.** `CREATE TABLE IF NOT EXISTS` is NOT atomic in Postgres: two
 * sessions can both pass the catalog check and both attempt the create, and the loser
 * fails on `pg_type_typname_nsp_index` (duplicate key, SQLSTATE 23505) — or on
 * `CREATE INDEX IF NOT EXISTS` with 42P07. That is reachable from the shipped happy
 * path: every store constructor migrates, and `postgresStorage({ url })` builds a
 * SEPARATE pool per store, so wiring Postgres against a fresh database fires several
 * concurrent migrations by construction.
 *
 * Two layers, because they cover different cases:
 *  - a transaction-scoped **advisory lock** serializes migration across sessions,
 *    connections, and PROCESSES (the case that matters when a deployment scales out
 *    and many nodes boot at once). The `_xact_` form releases on commit/rollback and
 *    on a dropped connection, so a crashed migrator cannot wedge the lock.
 *  - a per-Pool **memo** skips redundant DDL round-trips for stores sharing a pool.
 *
 * The memo is deliberately NOT sufficient on its own — the shipped preset uses
 * distinct pools — and the lock is not made redundant by it.
 */
export async function migrate(pool: PoolLike): Promise<void> {
  const inFlight = migrations.get(pool);
  if (inFlight !== undefined) return inFlight;

  const run = runMigration(pool);
  migrations.set(pool, run);
  // Never cache a rejection: a migration that failed (transient connection loss, a
  // database not yet accepting connections) must be retryable by the next caller.
  // The catch here only evicts — callers still observe the rejection via `run`.
  run.catch(() => {
    if (migrations.get(pool) === run) migrations.delete(pool);
  });
  return run;
}

async function runMigration(pool: PoolLike): Promise<void> {
  // A dedicated client, not `pool.query`: the advisory lock and the DDL must run in
  // ONE session and one transaction, which a pooled per-query checkout cannot promise.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      MIGRATION_LOCK_NAMESPACE,
      MIGRATION_LOCK_ID,
    ]);
    await client.query(DDL);
    await client.query("COMMIT");
  } catch (err) {
    // Best-effort rollback; the original error is what the caller needs to see.
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const DDL = `
    CREATE TABLE IF NOT EXISTS events (
      id TEXT NOT NULL PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      sequence BIGINT NOT NULL,
      timestamp BIGINT NOT NULL,
      payload JSONB NOT NULL,
      metadata JSONB,
      UNIQUE (execution_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_events_exec ON events (execution_id, sequence ASC);

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT NOT NULL PRIMARY KEY,
      execution_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      sequence BIGINT NOT NULL,
      state JSONB NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_exec ON snapshots (execution_id, sequence DESC);

    CREATE TABLE IF NOT EXISTS refs (
      name TEXT NOT NULL PRIMARY KEY,
      execution_id TEXT NOT NULL,
      tip BIGINT NOT NULL,
      parent_execution_id TEXT,
      fork_sequence BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lineage (
      execution_id TEXT NOT NULL PRIMARY KEY,
      parent_execution_id TEXT NOT NULL,
      fork_sequence BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lineage_parent ON lineage (parent_execution_id);

    -- K9.4 fencing: the current monotonic fence token per execution. A row exists
    -- only once a dispatcher/worker acquires a fence; executions that never fence
    -- pay nothing. Appends carrying a stale/missing token are rejected in append().
    CREATE TABLE IF NOT EXISTS fences (
      execution_id TEXT NOT NULL PRIMARY KEY,
      fence BIGINT NOT NULL
    );

    -- T1 durable timers: pending wakes for suspended executions, in the same
    -- database as the event log so one backup captures the full kernel state.
    CREATE TABLE IF NOT EXISTS timers (
      execution_id TEXT NOT NULL,
      wake_at BIGINT NOT NULL,
      PRIMARY KEY (execution_id, wake_at)
    );
    CREATE INDEX IF NOT EXISTS idx_timers_wake ON timers (wake_at ASC);

    -- #380 — durable ownership of a RUNNING execution. One row per execution: a lease is
    -- exclusive by definition, so the primary key is the mutual exclusion.
    CREATE TABLE IF NOT EXISTS leases (
      execution_id TEXT NOT NULL PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leases_expiry ON leases (expires_at ASC);

    -- ADR 0051 D2 (@loom/plugin-durable-state): typed keyed carry state for
    -- schedule-driven agents, revisioned for compare-and-set. The contract
    -- (schemas, migrations) lives above the SPI; this is a dumb CAS store.
    CREATE TABLE IF NOT EXISTS durable_state (
      key TEXT NOT NULL PRIMARY KEY,
      contract_version BIGINT NOT NULL,
      revision BIGINT NOT NULL,
      payload JSONB NOT NULL
    );

    -- RM (@loom/plugin-read-model, issue #183): durable cross-execution event
    -- index. Idempotent rows (PK model_id,row_id) + monotonic per-execution
    -- watermarks; a read model is a rebuildable cache of the log, never an
    -- authority. GIN on fields serves the @> equality queries.
    CREATE TABLE IF NOT EXISTS read_model_rows (
      model_id TEXT NOT NULL,
      row_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      sequence BIGINT NOT NULL,
      timestamp BIGINT NOT NULL,
      kind TEXT NOT NULL,
      fields JSONB NOT NULL,
      value JSONB NOT NULL,
      PRIMARY KEY (model_id, row_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rm_rows_order
      ON read_model_rows (model_id, kind, timestamp, sequence);
    CREATE INDEX IF NOT EXISTS idx_rm_rows_fields
      ON read_model_rows USING GIN (fields jsonb_path_ops);
    CREATE TABLE IF NOT EXISTS read_model_watermarks (
      model_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      sequence BIGINT NOT NULL,
      PRIMARY KEY (model_id, execution_id)
    );

    -- @loom/memory: durable agent memory. A key (\`memoryId::scope\`) names an
    -- ORDERED LIST of entries, so the table carries its own insertion key --
    -- entries routinely share a timestamp and ordering by it would reshuffle a
    -- conversation. TTL/size policy lives above the SPI, in MemoryRuntime.
    CREATE TABLE IF NOT EXISTS memory_entries (
      seq BIGSERIAL PRIMARY KEY,
      key TEXT NOT NULL,
      entry JSONB NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entries_key ON memory_entries (key, seq ASC);
    -- Relevance search over searchableText(entry). The 'simple' configuration neither
    -- stems nor drops stopwords, which keeps it language-neutral and close to how SQLite's
    -- unicode61 tokenizer and @loom/memory's own tokenize() split text -- three backends
    -- that agree on what a term is. An expression index, so the column stays the source.
    CREATE INDEX IF NOT EXISTS idx_memory_entries_fts
      ON memory_entries USING GIN (to_tsvector('simple', text));
    -- Removal by entry id (ADR 0091). An EXPRESSION index over the stored JSON, not a
    -- column: the entry is already persisted whole, so an id round-trips with no schema
    -- change and no migration of existing rows -- and a column would be a second copy
    -- able to disagree with the one the SPI actually reads back. Partial, because only
    -- corpus entries carry an id and indexing the NULLs would be most of the table.
    CREATE INDEX IF NOT EXISTS idx_memory_entries_id
      ON memory_entries (key, (entry->>'id')) WHERE entry->>'id' IS NOT NULL;
  `;

// The channel every EventStore instance LISTENs on for cross-node subscribe.
export const NOTIFY_CHANNEL = "loom_events";
