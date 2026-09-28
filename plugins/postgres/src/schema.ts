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
export interface MigrateOptions {
  /**
   * L10 — how long the one-time `events.execution_id` collation conversion may WAIT for its
   * table lock before giving up (with a WARNING; boot continues). Short on purpose: while
   * the ALTER waits, every append queues behind it. Default 2000 ms. The migration runs once
   * per pool, so the first caller's value wins — pass it to `migratePostgresStores` before
   * constructing stores, or via `PostgresEventStoreOptions.migrationLockTimeoutMs`.
   */
  lockTimeoutMs?: number;
}

export async function migrate(pool: PoolLike, options: MigrateOptions = {}): Promise<void> {
  const inFlight = migrations.get(pool);
  if (inFlight !== undefined) return inFlight;

  const lockTimeoutMs = options.lockTimeoutMs ?? 2000;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs <= 0) {
    throw new RangeError(
      `migrate: lockTimeoutMs must be a positive integer (got ${lockTimeoutMs})`
    );
  }
  const run = runMigration(pool, lockTimeoutMs);
  migrations.set(pool, run);
  // Never cache a rejection: a migration that failed (transient connection loss, a
  // database not yet accepting connections) must be retryable by the next caller.
  // The catch here only evicts — callers still observe the rejection via `run`.
  run.catch(() => {
    if (migrations.get(pool) === run) migrations.delete(pool);
  });
  return run;
}

async function runMigration(pool: PoolLike, lockTimeoutMs: number): Promise<void> {
  // A dedicated client, not `pool.query`: the advisory lock and the DDL must run in
  // ONE session and one transaction, which a pooled per-query checkout cannot promise.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      MIGRATION_LOCK_NAMESPACE,
      MIGRATION_LOCK_ID,
    ]);
    // Read by the L10 DO block; transaction-local, so it never leaks into the pooled session.
    await client.query("SELECT set_config('loom.l10_lock_timeout', $1, true)", [
      `${lockTimeoutMs}ms`,
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
      execution_id TEXT COLLATE "C" NOT NULL,
      event_type TEXT NOT NULL,
      sequence BIGINT NOT NULL,
      timestamp BIGINT NOT NULL,
      payload JSONB NOT NULL,
      metadata JSONB,
      UNIQUE (execution_id, sequence)
    );
    -- L10 (EventStore SPI 2.0.0, ADR 0108): execution ids page in code point order, which is
    -- COLLATE "C", never the database's collation. A table created before L10 inherited the
    -- database collation (en_US.UTF-8 on most clusters), so ShardedEventStore's merge, which
    -- is in code point order, skipped ids. Converting the column in place is binary-coercible
    -- (text -> text): no table rewrite, but idx_events_exec and the UNIQUE index are rebuilt
    -- under an ACCESS EXCLUSIVE lock, ONCE (~4.5 s per 2M events measured; see the L10 PR).
    -- Guarded by the catalog, so every later boot is a no-op. Equality lookups are unchanged
    -- by the collation, and "C" comparisons are plain memcmp, so appends get cheaper.
    --
    -- * ALTER ... TYPE drops the column's statistics, and the planner then pages with a seq
    --   scan + sort, so the column is re-ANALYZEd in the same step.
    -- * The lock wait is bounded (loom.l10_lock_timeout, set by runMigration): an ALTER queued
    --   behind a long transaction would otherwise queue every append behind ITSELF.
    -- * If the conversion cannot run — the lock timed out, a user view/rule depends on the
    --   column, or the role does not own the table — boot continues with a WARNING naming the
    --   statements to run by hand. Correctness does not depend on it (the paging query says
    --   COLLATE "C" explicitly); only paging speed does, and loudly. The subtransaction's
    --   rollback also restores lock_timeout.
    -- The collation is looked up in pg_collation rather than cast via ::regcollation (PG 13+).
    DO $l10$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'events'::regclass AND attname = 'execution_id'
          AND attcollation <> (
            SELECT oid FROM pg_collation
            WHERE collname = 'C' AND collnamespace = 'pg_catalog'::regnamespace
          )
      ) THEN
        BEGIN
          PERFORM set_config(
            'lock_timeout',
            COALESCE(NULLIF(current_setting('loom.l10_lock_timeout', true), ''), '2s'),
            true
          );
          ALTER TABLE events ALTER COLUMN execution_id TYPE TEXT COLLATE "C";
          PERFORM set_config('lock_timeout', '0', true);
          ANALYZE events (execution_id);
        EXCEPTION
          WHEN lock_not_available OR feature_not_supported OR insufficient_privilege
            OR dependent_objects_still_exist THEN
            RAISE WARNING 'loom: events.execution_id is not COLLATE "C" (%: %). Execution-id paging stays correct but cannot use idx_events_exec until you run: ALTER TABLE events ALTER COLUMN execution_id TYPE TEXT COLLATE "C"; ANALYZE events;',
              SQLSTATE, SQLERRM;
        END;
      END IF;
    END
    $l10$;
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
