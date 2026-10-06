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
   * L10/L21 — how long a one-time collation conversion (`refs.name`, then
   * `events.execution_id`) may WAIT for its table lock before giving up (with a WARNING;
   * boot continues). Short on purpose: while an ALTER waits, every append/putRef against
   * ITS table queues behind it. Default 2000 ms.
   *
   * Governs BOTH conversions, but NOT as one shared budget — each reads
   * `loom.migration_lock_timeout` and applies it to its OWN wait independently. If both
   * tables are contended, the two waits are sequential (L21's ALTER, then L10's), so a boot
   * can stall up to **2× lockTimeoutMs** (4000 ms by default) before COMMIT, not once. Each
   * wait still only blocks writers to the ONE table it is waiting on; the two tables are
   * never both stalled by the same wait.
   *
   * The migration runs ONCE per pool and the first migrator's value wins, so the reliable way
   * to set it is `await migratePostgresStores(pool, { lockTimeoutMs })` BEFORE constructing any
   * store on that pool. `PostgresEventStoreOptions.migrationLockTimeoutMs` and
   * `postgresStorage({ migrationLockTimeoutMs })` pass it too, but only take effect if that
   * store is the first to migrate its pool (the preset builds the event store first).
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
    // The caller's timeouts, captured once and restored after each exempt step. Every
    // set_config here is transaction-local, so nothing leaks into the pooled session.
    const { rows } = await client.query<{ st: string; lt: string }>(
      "SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt"
    );
    const callerStatementTimeout = rows[0]?.st ?? "0";
    const callerLockTimeout = rows[0]?.lt ?? "0";
    // ADR 0108 D3 — waiting on the migration lock is intended serialization, so it is NOT
    // bounded by the caller's timeouts (lock_timeout applies to advisory locks too). Otherwise
    // a peer booting while another node runs a long one-time conversion fails its migration,
    // and its store's `ready` rejects every operation until the process restarts.
    await client.query(
      "SELECT set_config('statement_timeout', '0', true), set_config('lock_timeout', '0', true)"
    );
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      MIGRATION_LOCK_NAMESPACE,
      MIGRATION_LOCK_ID,
    ]);
    await client.query(
      "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)",
      [callerStatementTimeout, callerLockTimeout]
    );
    // Read by the L10/L21 DO blocks below (each applies it to its OWN wait independently —
    // see `MigrateOptions.lockTimeoutMs`).
    await client.query("SELECT set_config('loom.migration_lock_timeout', $1, true)", [
      `${lockTimeoutMs}ms`,
    ]);
    await client.query(DDL_EVENTS);
    await client.query(DDL_REST);
    // Review round 1 (P2) — L21 (`refs`) runs BEFORE L10 (`events`), both after DDL_REST,
    // which is what creates `refs` on a fresh database. Ordering matters for more than
    // "lock the hot table last": this transaction acquires ACCESS EXCLUSIVE on `refs` and
    // `events` in whatever order these two blocks run in, and holds each until COMMIT. The
    // ORIGINAL order (events, then refs) deadlocked (40P01, reproduced in
    // `branchRegistryMigration.test.ts`) against a concurrent transaction that reads `refs`
    // then `events` in one transaction — each transaction ends up waiting on a lock the
    // other already holds. No SHIPPED code does that (or the reverse): `append()` only ever
    // touches `events`, and every `BranchRegistry` method only ever touches `refs`/`lineage`
    // — so this order is not "correct" in a way the reverse isn't, only demonstrated safe
    // against the reproduced case, with `refs` (this migration's smaller, less-referenced
    // table) locked first and released soonest, and the hot `events` table locked last and
    // held for the shortest remaining stretch of the transaction. The EXCEPTION list in BOTH
    // DO blocks also now catches `deadlock_detected`, so if a future caller's transaction
    // (in either order) deadlocks against this one, whichever block loses fails soft with a
    // WARNING instead of rolling back the whole migration — L10 included.
    await client.query("SELECT set_config('statement_timeout', '0', true)");
    await client.query(L21_COLLATION);
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      callerStatementTimeout,
    ]);
    // L10 — the collation conversion may rebuild two indexes on a large log: exempt THAT
    // statement (only) from the caller's statement_timeout, then restore it.
    await client.query("SELECT set_config('statement_timeout', '0', true)");
    await client.query(L10_COLLATION);
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      callerStatementTimeout,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    // Best-effort rollback; the original error is what the caller needs to see.
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const DDL_EVENTS = `
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
`;

/**
 * L10 (EventStore SPI 2.0.0, ADR 0108): execution ids page in code point order, which is
 * COLLATE "C", never the database's collation. A table created before L10 inherited the
 * database collation (en_US.UTF-8 on most clusters), so ShardedEventStore's merge, which is in
 * code point order, skipped ids. Converting the column in place is binary-coercible
 * (text -> text): no table rewrite, but idx_events_exec and the UNIQUE index are rebuilt under
 * an ACCESS EXCLUSIVE lock, ONCE (~4.5 s per 2M events measured). Guarded by the catalog, so
 * every later boot is a no-op. Equality lookups are unchanged by the collation, and "C"
 * comparisons are plain memcmp, so appends get cheaper.
 *
 * Runs SECOND in `runMigration`, after `L21_COLLATION` — see the ordering/deadlock note there
 * (review round 1, P2): `events` is the hot table, so it is locked last and held for the
 * shortest remaining stretch of the transaction.
 *
 * The boot-migration policy of ADR 0108 D3:
 *  - The LOCK WAIT is bounded (`loom.migration_lock_timeout`, set by runMigration): an ALTER
 *    queued behind a long transaction would otherwise queue every append behind ITSELF. Applied
 *    to THIS statement's wait only, independently of L21's — the two are not a shared budget,
 *    so a boot where both `refs` and `events` are contended can stall up to 2x this value
 *    before COMMIT (L21's wait, then this one). The caller's `lock_timeout` is captured and
 *    RESTORED after the ALTER, so the rest of the migration runs under the operator's setting,
 *    not an unbounded one.
 *  - The REBUILD is not bounded: runMigration runs this block with `statement_timeout = 0`
 *    (and restores the caller's value after it), because a pool-level statement timeout
 *    shorter than the rebuild would abort it on every boot, which is a crash loop that also
 *    takes the exclusive lock each time. A one-time bounded stall is the accepted cost.
 *  - Peers WAIT for it: runMigration takes the advisory lock with both timeouts at 0, then
 *    restores the caller's values, so a node booting mid-rebuild queues instead of failing.
 *  - ALTER ... TYPE drops the column's statistics, and the planner then pages with a seq scan
 *    + sort, so the column is re-ANALYZEd in the same step.
 *  - If the conversion cannot run (the lock wait timed out, an operator cancelled it, or a
 *    user view/rule depends on the column), boot continues with a WARNING naming the
 *    statements to run by hand. Correctness does not depend on it (the paging query says
 *    COLLATE "C" itself); only paging speed does, and loudly. The subtransaction's rollback
 *    restores lock_timeout. A role that does not own `events` is NOT caught: the migration's
 *    next CREATE INDEX fails for it anyway, so a WARNING would only precede a fatal error.
 *  - The collation is looked up in pg_collation rather than cast via ::regcollation (PG 13+).
 */
const L10_COLLATION = `
    DO $l10$
    DECLARE
      caller_lock_timeout text := current_setting('lock_timeout');
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
            COALESCE(NULLIF(current_setting('loom.migration_lock_timeout', true), ''), '2s'),
            true
          );
          ALTER TABLE events ALTER COLUMN execution_id TYPE TEXT COLLATE "C";
          PERFORM set_config('lock_timeout', caller_lock_timeout, true);
          ANALYZE events (execution_id);
        EXCEPTION
          WHEN lock_not_available OR query_canceled OR feature_not_supported
            OR dependent_objects_still_exist OR deadlock_detected THEN
            RAISE WARNING 'loom: events.execution_id is not COLLATE "C" (%: %). Execution-id paging stays correct but cannot use idx_events_exec until you run: ALTER TABLE events ALTER COLUMN execution_id TYPE TEXT COLLATE "C"; ANALYZE events;',
              SQLSTATE, SQLERRM;
        END;
      END IF;
    END
    $l10$;
`;

const DDL_REST = `
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
      name TEXT COLLATE "C" NOT NULL PRIMARY KEY,
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
    -- ADR 0118 D4: marks a re-drive row (a backed-off retry of a contended resume). \`CREATE TABLE
    -- IF NOT EXISTS\` never adds a column to a table an older version created, so this is its own
    -- idempotent statement.
    ALTER TABLE timers ADD COLUMN IF NOT EXISTS redrive JSONB;

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

/**
 * L21 (BranchRegistry SPI 2.0.0, ADR 0108 addendum): ref names page in code point order,
 * which is COLLATE "C", never the database's collation. Same shape as {@link L10_COLLATION}
 * — see its doc comment for the full rationale (ALTER ... TYPE TEXT COLLATE "C" here is
 * binary-coercible, no table rewrite, but rebuilds the ONE index that depends on `name`:
 * `refs`'s own primary key, under an ACCESS EXCLUSIVE lock). Differences from L10:
 *  - Runs FIRST in `runMigration`, immediately after `DDL_REST` (which is what creates `refs`
 *    on a fresh database — it does not exist yet when `DDL_EVENTS` runs). Review round 1 (P2):
 *    this transaction acquires ACCESS EXCLUSIVE on `refs` and `events`, in whatever order
 *    these two DO blocks run, and holds each until COMMIT — running L10 (`events`, the hot
 *    table) first deadlocked (40P01) against a concurrent transaction that reads `refs` then
 *    `events` in one transaction (reproduced in `branchRegistryMigration.test.ts`). Running
 *    L21 first locks the smaller, less-referenced table first and releases it soonest, and
 *    leaves `events` locked for the shortest remaining stretch of the transaction. No SHIPPED
 *    code acquires both locks in the OTHER order (`append()` only touches `events`; every
 *    `BranchRegistry` method only touches `refs`/`lineage`), so this order trades a
 *    demonstrated deadlock for one that would need an application transaction spanning both
 *    tables in the reverse order — which the shared `deadlock_detected` EXCEPTION arm (in
 *    BOTH blocks) now fails soft on regardless, rather than rolling back the whole migration.
 *  - Reads `loom.migration_lock_timeout` independently of L10's read of the same setting — see
 *    `MigrateOptions.lockTimeoutMs`: each conversion's lock wait is its own budget, not a
 *    shared one, so a boot where both tables are contended can stall up to 2x this value.
 *  - `ANALYZE refs (name)` re-establishes the column's statistics; a table this small rarely
 *    needs it for a plan to stay index-only, but a large registry (forking is cheap) can.
 */
const L21_COLLATION = `
    DO $l21$
    DECLARE
      caller_lock_timeout text := current_setting('lock_timeout');
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'refs'::regclass AND attname = 'name'
          AND attcollation <> (
            SELECT oid FROM pg_collation
            WHERE collname = 'C' AND collnamespace = 'pg_catalog'::regnamespace
          )
      ) THEN
        BEGIN
          PERFORM set_config(
            'lock_timeout',
            COALESCE(NULLIF(current_setting('loom.migration_lock_timeout', true), ''), '2s'),
            true
          );
          ALTER TABLE refs ALTER COLUMN name TYPE TEXT COLLATE "C";
          PERFORM set_config('lock_timeout', caller_lock_timeout, true);
          ANALYZE refs (name);
        EXCEPTION
          WHEN lock_not_available OR query_canceled OR feature_not_supported
            OR dependent_objects_still_exist OR deadlock_detected THEN
            RAISE WARNING 'loom: refs.name is not COLLATE "C" (%: %). Branch-ref paging stays correct but cannot serve ORDER BY from the primary-key index until you run: ALTER TABLE refs ALTER COLUMN name TYPE TEXT COLLATE "C"; ANALYZE refs;',
              SQLSTATE, SQLERRM;
        END;
      END IF;
    END
    $l21$;
`;

// The channel every EventStore instance LISTENs on for cross-node subscribe.
export const NOTIFY_CHANNEL = "loom_events";
