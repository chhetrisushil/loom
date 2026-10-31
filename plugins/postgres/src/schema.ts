import { KERNEL_EVENT_KINDS } from "@loom/core";
import { EVENT_KIND_CLASS } from "@loom/event-runtime";
import type { PoolLike } from "./pool";

/** The kernel kinds that answer a park (ADR 0118 D1), from the one classification map. */
const ANSWERING_KERNEL_KINDS: readonly string[] = KERNEL_EVENT_KINDS.filter(
  (k) => EVENT_KIND_CLASS[k] === "answering"
);

/** `ARRAY['A','B']::text[]` for constant kernel kind names (inlined: see `acquireFenceIf`). */
function kindsSql(kinds: readonly string[]): string {
  for (const k of kinds) {
    if (!/^[A-Z_]+$/.test(k)) throw new Error(`kernel event kind "${k}" cannot be inlined`);
  }
  return `ARRAY[${kinds.map((k) => `'${k}'`).join(",")}]::text[]`;
}
export const ANSWERING_KINDS_SQL = kindsSql(ANSWERING_KERNEL_KINDS);
export const KERNEL_KINDS_SQL = kindsSql(KERNEL_EVENT_KINDS);

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
   * Governs the three conversion waits (L21 `refs`, L10 `events.execution_id`, and the ADR 0129
   * `events.incarnation` column + trigger), but NOT as one shared budget — each reads
   * `loom.migration_lock_timeout` and applies it to its OWN wait independently. The waits are
   * sequential, so a boot can stall up to **2× lockTimeoutMs** (4000 ms by default) behind
   * `refs` then `events` for the conversions, and — when `events` is contended throughout —
   * up to **4× lockTimeoutMs** against it (L10's wait, then the incarnation ALTER and CREATE
   * TRIGGER; the incarnation step is skipped outright after a transient L10 failure, so that
   * worst case needs the holder to release in between). Each wait still only blocks writers to
   * the ONE table it is waiting on. The opt-in `snapshotCompression: "lz4"` step is NOT part of
   * this budget: it runs after the commit with its own wait of min(lockTimeoutMs, 200 ms).
   *
   * The migration runs ONCE per pool and the first migrator's value wins, so the reliable way
   * to set it is `await migratePostgresStores(pool, { lockTimeoutMs })` BEFORE constructing any
   * store on that pool. `PostgresEventStoreOptions.migrationLockTimeoutMs` and
   * `postgresStorage({ migrationLockTimeoutMs })` pass it too, but only take effect if that
   * store is the first to migrate its pool (the preset builds the event store first).
   */
  lockTimeoutMs?: number;
  /**
   * ADR 0129 — receives the one-per-migration WARNING when the incarnation install did not
   * happen (events locked, a non-owner role, a dependent view). Default `console.warn`.
   */
  onWarn?: (message: string) => void;
  /**
   * ADR 0118 D1 — run the ONE-TIME park-fence backfill during the boot migration. Default `true`.
   *
   * The backfill is a full sequential scan of `events` (there is no `event_type` index) under the
   * migration advisory lock, exempt from `statement_timeout`: on a very large log the FIRST boot
   * stalls every node that boots behind it. For such an installation pass `false`, boot, and run
   * {@link backfillParkFences} offline (batched, no long lock). While it has not run, the first
   * `acquireFenceIf` of a park that PREDATES the upgrade can race an answering append (the
   * pre-upgrade behaviour); parks written after the upgrade are unaffected. A later boot with the
   * default re-attempts the backfill until the marker exists.
   */
  backfillParkFences?: boolean;
  /**
   * ADR 0136 — the TOAST compression of `snapshots.state`. OPT-IN: `"lz4"` runs
   * `ALTER TABLE snapshots ALTER COLUMN state SET COMPRESSION lz4` (PostgreSQL 14+ built with lz4),
   * which only affects values written AFTER it (existing rows stay pglz until rewritten; nothing here
   * rewrites them). On a server that cannot do it (older than 14, built without lz4, a non-owner role,
   * the table locked past its own short wait) the migration does NOT fail: it keeps the default
   * compression, reports one message through `onWarn`, and the next boot retries.
   * The `ALTER` needs ACCESS EXCLUSIVE on `snapshots`, and while it waits every snapshot load/save
   * queues behind it, so it runs in its OWN transaction after the main commit with a wait of
   * min(`lockTimeoutMs`, 200 ms): a boot can stall snapshot I/O (hence resume) by at most that, and
   * only while some long reader/writer holds the table. Like every option here, it is decided by the
   * FIRST migrator of a pool: asking for `"lz4"` on a pool another store already migrated is ignored. `"default"` (the default) leaves the column
   * alone and never reverts a column that already uses lz4. Measured (ADR 0136): lz4 stores ~1.5x MORE
   * bytes than pglz but reads ~20% and writes ~2.4x faster, so it is a speed choice, not a size one.
   */
  snapshotCompression?: "lz4" | "default";
  /**
   * ADR 0140 - `"zstd"` also provisions the `snapshots.state_z BYTEA` column the zstd snapshot codec
   * writes (and drops `state`'s NOT NULL, since a codec row keeps its state in `state_z`). OPT-IN, fail
   * soft, own short transaction with its own lock wait of min(`lockTimeoutMs`, 200 ms); see
   * {@link ensureSnapshotZstd}. Unlike the other options it is NOT decided by the first migrator of a
   * pool: it runs for whoever asks (it is idempotent and memoized per pool). `PostgresSnapshotStore`
   * asks for it itself when built with `codec: "zstd"`, so this is for provisioning ahead of time.
   */
  snapshotCodec?: "zstd" | "none";
}

export async function migrate(pool: PoolLike, options: MigrateOptions = {}): Promise<void> {
  const base = migrateOnce(pool, options);
  if (options.snapshotCodec !== "zstd") return base;
  await base;
  await ensureSnapshotZstd(pool, {
    lockTimeoutMs: options.lockTimeoutMs ?? 2000,
    ...(options.onWarn !== undefined && { onWarn: options.onWarn }),
  });
}

function migrateOnce(pool: PoolLike, options: MigrateOptions): Promise<void> {
  const inFlight = migrations.get(pool);
  if (inFlight !== undefined) return inFlight;

  const lockTimeoutMs = options.lockTimeoutMs ?? 2000;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs <= 0) {
    throw new RangeError(
      `migrate: lockTimeoutMs must be a positive integer (got ${lockTimeoutMs})`
    );
  }
  const run = runMigration(
    pool,
    lockTimeoutMs,
    options.backfillParkFences ?? true,
    options.onWarn,
    options.snapshotCompression ?? "default"
  );
  migrations.set(pool, run);
  // Never cache a rejection: a migration that failed (transient connection loss, a
  // database not yet accepting connections) must be retryable by the next caller.
  // The catch here only evicts — callers still observe the rejection via `run`.
  run.catch(() => {
    if (migrations.get(pool) === run) migrations.delete(pool);
  });
  return run;
}

async function runMigration(
  pool: PoolLike,
  lockTimeoutMs: number,
  backfill: boolean,
  onWarn?: (message: string) => void,
  snapshotCompression: "lz4" | "default" = "default"
): Promise<void> {
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
    // ADR 0118 D1 — one-time backfill of the token-0 fence rows a park now writes itself, for the
    // parks that PREDATE that. Before the L21/L10 conversions: it only reads \`events\`, and must
    // not run while their ACCESS EXCLUSIVE lock is held. Exempt from the caller's statement_timeout
    // (a scan of the whole log, once), then restored.
    if (backfill) {
      await client.query("SELECT set_config('statement_timeout', '0', true)");
      await client.query(R8K_PARK_FENCES);
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        callerStatementTimeout,
      ]);
    }
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
    // ADR 0129 — last, so the hot `events` table is locked for the shortest remaining stretch.
    await client.query(INCARNATION);
    // ADR 0129 — a store whose incarnation install did not happen must say so LOUDLY (once per
    // migration, i.e. per boot per pool), not only as a server-side NOTICE: it keeps the legacy
    // anchor, which is SPI 2.2.0 behaviour, so it must not be mistaken for a 2.3.0 store.
    const skipped = await client.query<{ why: string | null }>(
      "SELECT NULLIF(current_setting('loom.incarnation_skip', true), '') AS why"
    );
    const why = skipped.rows[0]?.why;
    await client.query("COMMIT");
    // ADR 0136 — AFTER the main commit, in its OWN short transaction (ADR 0136 D1): no lock from
    // the conversions above is held across it, and it can never extend them. Fails soft.
    const lz4Skipped =
      snapshotCompression === "lz4"
        ? await setSnapshotLz4(client, Math.min(lockTimeoutMs, LZ4_LOCK_TIMEOUT_MS))
        : undefined;
    if (lz4Skipped !== undefined) {
      (onWarn ?? ((m: string) => console.warn(m)))(
        `loom: @loom/plugin-postgres kept the default (pglz) compression for snapshots.state (${lz4Skipped}). Snapshots stay correct; the next boot retries. Drop the snapshotCompression: "lz4" option to silence this.`
      );
    }
    if (why !== null && why !== undefined) {
      (onWarn ?? ((m: string) => console.warn(m)))(
        `loom: @loom/plugin-postgres did NOT install the ADR 0129 store-assigned incarnation (${why}). This store keeps the legacy creation-marker anchor, i.e. EventStore SPI 2.2.0 behaviour (a delete + byte-identical re-creation of an execution id is NOT detected by appendIfUnchanged), until a later boot installs it. PostgresEventStore.incarnationAnchors() reports the effective state.`
      );
    }
  } catch (err) {
    // Best-effort rollback; the original error is what the caller needs to see.
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** SQLSTATEs a failed lz4 step may raise that must not fail the migration. */
const LZ4_SOFT_FAILURES = new Set([
  "0A000", // feature_not_supported: "this build does not support compression with LZ4"
  "22023", // invalid_parameter_value: unknown compression method
  "42601", // syntax_error: a server older than 14 has no SET COMPRESSION
  "42703", // undefined_column: a fork without pg_attribute.attcompression
  "42501", // insufficient_privilege: not the table owner
  "55P03", // lock_not_available: lock_timeout expired
  "57014", // query_canceled
  "40P01", // deadlock_detected
]);

/**
 * The lz4 step's OWN lock wait. `SET COMPRESSION` is metadata-only (instant once it holds the lock) but
 * asks for ACCESS EXCLUSIVE, and while it waits every snapshot load/save queues behind it, so it must not
 * borrow the (longer) conversion budget: the stall is bounded by this, per boot, until it succeeds.
 */
const LZ4_LOCK_TIMEOUT_MS = 200;

/**
 * ADR 0136 — switch `snapshots.state` to lz4 TOAST compression, soft, in its own transaction under the
 * migration advisory lock (taken BEFORE the probes, so they see the settled catalog). Returns why it was
 * skipped, or `undefined` when the column is (now) lz4. The catalog probe makes every later boot a no-op
 * that takes no table lock.
 */
async function setSnapshotLz4(
  client: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  },
  lockWaitMs: number
): Promise<string | undefined> {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query(
      "SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt"
    );
    // Same discipline as the main migration: waiting on a peer's migration is intended serialization.
    await client.query(
      "SELECT set_config('statement_timeout', '0', true), set_config('lock_timeout', '0', true)"
    );
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      MIGRATION_LOCK_NAMESPACE,
      MIGRATION_LOCK_ID,
    ]);
    await client.query(
      "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)",
      [rows[0]?.st ?? "0", rows[0]?.lt ?? "0"]
    );
    const v = await client.query("SHOW server_version_num");
    const version = Number(v.rows[0]?.server_version_num);
    if (!(version >= 140000)) {
      await client.query("COMMIT");
      return `PostgreSQL ${Number.isFinite(version) ? version : "?"} is older than 14`;
    }
    const cur = await client.query(
      "SELECT attcompression::text AS c FROM pg_attribute WHERE attrelid = 'snapshots'::regclass AND attname = 'state' AND NOT attisdropped"
    );
    if (cur.rows[0]?.c !== "l") {
      await client.query("SELECT set_config('lock_timeout', $1, true)", [`${lockWaitMs}ms`]);
      await client.query("ALTER TABLE snapshots ALTER COLUMN state SET COMPRESSION lz4");
    }
    await client.query("COMMIT");
    return undefined;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const code = (err as { code?: unknown }).code;
    if (typeof code !== "string" || !LZ4_SOFT_FAILURES.has(code)) throw err;
    return `${code}: ${(err as Error).message}`;
  }
}

const zstdReady = new WeakMap<PoolLike, Promise<boolean>>();

/**
 * ADR 0140 - provision the BYTEA column of the zstd snapshot codec: `snapshots.state_z BYTEA` (TOAST
 * storage EXTERNAL: the bytes are already compressed, so the server must not try again) and `state DROP
 * NOT NULL` (a codec row keeps its state in `state_z`, so `state` is NULL). Resolves `true` when both
 * hold, `false` when it could not be done (reported ONCE through `onWarn`; the caller then keeps writing
 * JSONB, which is always correct, and the next boot retries).
 *
 * Same discipline as ADR 0136's lz4 step: its OWN short transaction under the migration advisory lock
 * (taken before the probes, so they see a settled catalog), after the main migration committed, so it
 * can neither extend nor reorder the conversions' locks. The catalog probe means every boot after the
 * first takes NO table lock. When it must alter, the statements run in ONE transaction under ONE
 * ACCESS EXCLUSIVE acquisition with `lock_timeout` = min(`lockTimeoutMs`, 200 ms): each is catalog-only
 * (a nullable column without a default is not a rewrite; DROP NOT NULL does not scan), so the lock is
 * held for microseconds once granted, and while it WAITS snapshot I/O queues behind it for at most that
 * timeout. Memoized per pool when it succeeds (a failure is retried by the next caller).
 *
 * `migrate(pool)` MUST have completed first (it creates `snapshots`).
 */
export function ensureSnapshotZstd(
  pool: PoolLike,
  options: { lockTimeoutMs?: number; onWarn?: (message: string) => void } = {}
): Promise<boolean> {
  const memo = zstdReady.get(pool);
  if (memo !== undefined) return memo;
  const run = (async () => {
    const client = await pool.connect();
    try {
      const why = await addZstdColumn(
        client,
        Math.min(options.lockTimeoutMs ?? 2000, LZ4_LOCK_TIMEOUT_MS)
      );
      if (why !== undefined) {
        (options.onWarn ?? ((m: string) => console.warn(m)))(
          `loom: @loom/plugin-postgres could not provision snapshots.state_z for the zstd snapshot codec (${why}). Snapshots are still written as JSONB (always correct, just larger); the next boot retries. Drop the snapshot codec option to silence this.`
        );
        return false;
      }
      return true;
    } finally {
      client.release();
    }
  })();
  zstdReady.set(pool, run);
  run.then(
    (ok) => {
      if (!ok && zstdReady.get(pool) === run) zstdReady.delete(pool);
    },
    () => {
      if (zstdReady.get(pool) === run) zstdReady.delete(pool);
    }
  );
  return run;
}

async function addZstdColumn(
  client: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  },
  lockWaitMs: number
): Promise<string | undefined> {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query(
      "SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt"
    );
    await client.query(
      "SELECT set_config('statement_timeout', '0', true), set_config('lock_timeout', '0', true)"
    );
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      MIGRATION_LOCK_NAMESPACE,
      MIGRATION_LOCK_ID,
    ]);
    await client.query(
      "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)",
      [rows[0]?.st ?? "0", rows[0]?.lt ?? "0"]
    );
    const cur = await client.query(
      `SELECT attname::text AS name, attnotnull AS notnull FROM pg_attribute
       WHERE attrelid = 'snapshots'::regclass AND attname IN ('state', 'state_z') AND NOT attisdropped`
    );
    const hasZ = cur.rows.some((r) => r.name === "state_z");
    const stateNotNull = cur.rows.some((r) => r.name === "state" && r.notnull === true);
    const hasCheck =
      (
        await client.query(
          "SELECT 1 FROM pg_constraint WHERE conrelid = 'snapshots'::regclass AND conname = 'snapshots_one_format'"
        )
      ).rows.length > 0;
    if (!hasZ || stateNotNull || !hasCheck) {
      await client.query("SELECT set_config('lock_timeout', $1, true)", [`${lockWaitMs}ms`]);
      if (!hasZ) {
        await client.query("ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS state_z BYTEA");
        await client.query("ALTER TABLE snapshots ALTER COLUMN state_z SET STORAGE EXTERNAL");
      }
      if (stateNotNull)
        await client.query("ALTER TABLE snapshots ALTER COLUMN state DROP NOT NULL");
      // At most one format per row. NOT VALID: enforced for every later write but no table scan (the
      // column is new, so every existing row satisfies it by construction). It turns a mixed-config fleet's
      // JSONB re-save over a frame row into a loud error instead of a silently stale snapshot.
      if (!hasCheck) {
        await client.query(
          "ALTER TABLE snapshots ADD CONSTRAINT snapshots_one_format CHECK (state IS NULL OR state_z IS NULL) NOT VALID"
        );
      }
    }
    await client.query("COMMIT");
    return undefined;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const code = (err as { code?: unknown }).code;
    if (typeof code !== "string" || !LZ4_SOFT_FAILURES.has(code)) throw err;
    return `${code}: ${(err as Error).message}`;
  }
}

/**
 * ADR 0118 D1 — backfill the inert token-0 `fences` row of every execution that is PARKED right
 * now but parked before this version (a park now ensures its own row; see
 * `PostgresEventStore.append`). Without the row an answering append has nothing to lock
 * `FOR SHARE`, so the FIRST `acquireFenceIf` of such a park races it (probe: 279 of 300 batch
 * appends both succeeded). Only parks with no ANSWERING event after them get one (a settled
 * execution never needs it), so the table does not grow by the whole history.
 *
 * Runs ONCE: the marker is a comment on the `fences` table, written in the same transaction as
 * the backfill, under the migration advisory lock (no peer runs it twice or sees it half done).
 * A fresh database finds an empty log and just writes the marker. `ON CONFLICT DO NOTHING`
 * never touches a real token.
 */
const PARK_FENCE_MARKER = "loom:r8k-park-fences";
const R8K_PARK_FENCES = `
    DO $r8k_park_fences$
    BEGIN
      IF COALESCE(obj_description('fences'::regclass, 'pg_class'), '') <> '${PARK_FENCE_MARKER}' THEN
        INSERT INTO fences (execution_id, fence)
        SELECT p.execution_id, 0 FROM events p
        WHERE p.event_type = 'EXECUTION_SUSPENDED'
          AND NOT EXISTS (
            SELECT 1 FROM events a
            WHERE a.execution_id = p.execution_id AND a.sequence > p.sequence
              AND a.event_type = ANY (${ANSWERING_KINDS_SQL})
          )
        ON CONFLICT (execution_id) DO NOTHING;
        COMMENT ON TABLE fences IS '${PARK_FENCE_MARKER}';
      END IF;
    END
    $r8k_park_fences$;
`;

/** The throwaway partial index {@link backfillParkFences} builds (and drops) to find parks. */
const PARK_SCAN_INDEX = "idx_events_suspended_r8k_tmp";

export interface BackfillParkFencesOptions {
  /** Executions examined per statement. Default 1000. */
  batchSize?: number;
  /**
   * Build a PARTIAL index `events (execution_id, sequence) WHERE event_type = 'EXECUTION_SUSPENDED'`
   * (`CREATE INDEX CONCURRENTLY`: no write lock) for the run and drop it after. Default `true`.
   * It is deliberately NOT kept: after the backfill nothing scans by event type (a park lookup is
   * by execution, served by the `(execution_id, sequence)` unique index), and a permanent index
   * would tax every `EXECUTION_SUSPENDED` append for no reader.
   */
  tempIndex?: boolean;
}

/**
 * ADR 0118 D1 — the park-fence backfill for a LARGE installation, run outside the boot migration
 * (boot with `migrate(pool, { backfillParkFences: false })`). Idempotent and resumable: it walks
 * executions in id order, `ON CONFLICT DO NOTHING` (a real token is never touched), each batch its
 * own short statement, and writes the same one-time marker the boot backfill does. Returns the
 * number of fence rows inserted.
 */
export async function backfillParkFences(
  pool: PoolLike,
  options: BackfillParkFencesOptions = {}
): Promise<{ inserted: number }> {
  const batchSize = options.batchSize ?? 1000;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(
      `backfillParkFences: batchSize must be a positive integer (got ${batchSize})`
    );
  }
  await migrate(pool, { backfillParkFences: false });
  const marker = await pool.query<{ c: string | null }>(
    "SELECT obj_description('fences'::regclass, 'pg_class') AS c"
  );
  if (marker.rows[0]?.c === PARK_FENCE_MARKER) return { inserted: 0 };
  const useIndex = options.tempIndex ?? true;
  if (useIndex) {
    await pool.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${PARK_SCAN_INDEX} ON events (execution_id, sequence) WHERE event_type = 'EXECUTION_SUSPENDED'`
    );
  }
  let inserted = 0;
  try {
    let cursor = "";
    for (;;) {
      const ids = await pool.query<{ execution_id: string }>(
        `SELECT DISTINCT execution_id FROM events
         WHERE event_type = 'EXECUTION_SUSPENDED' AND execution_id > $1
         ORDER BY execution_id LIMIT $2`,
        [cursor, batchSize]
      );
      if (ids.rows.length === 0) break;
      const list = ids.rows.map((r) => r.execution_id);
      const res = await pool.query(
        `INSERT INTO fences (execution_id, fence)
         SELECT DISTINCT p.execution_id, 0 FROM events p
         WHERE p.execution_id = ANY($1::text[]) AND p.event_type = 'EXECUTION_SUSPENDED'
           AND NOT EXISTS (
             SELECT 1 FROM events a
             WHERE a.execution_id = p.execution_id AND a.sequence > p.sequence
               AND a.event_type = ANY (${ANSWERING_KINDS_SQL})
           )
         ON CONFLICT (execution_id) DO NOTHING`,
        [list]
      );
      inserted += res.rowCount ?? 0;
      cursor = list[list.length - 1] as string;
    }
    await pool.query(`COMMENT ON TABLE fences IS '${PARK_FENCE_MARKER}'`);
  } finally {
    if (useIndex) await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${PARK_SCAN_INDEX}`);
  }
  return { inserted };
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
          -- ADR 0129: tell the incarnation step (which runs later in this transaction) that
          -- the events table could not be locked, so it does not queue behind the same holder again.
          -- ONLY for a transient wait failure (lock_not_available 55P03, query_canceled 57014,
          -- deadlock_detected 40P01): feature_not_supported / dependent_objects_still_exist recur
          -- on every boot (a view over the column) and say nothing about the lock, so they must
          -- not make the incarnation install skip forever.
          IF SQLSTATE IN ('55P03', '57014', '40P01') THEN
            PERFORM set_config('loom.events_lock_failed', 'on', true);
          END IF;
        END;
      END IF;
    END
    $l10$;
`;

/**
 * ADR 0129 — the store-assigned incarnation of an execution, kept in STORE METADATA only (never
 * in an envelope, so replay stays byte-identical). A nullable `events.incarnation BIGINT`,
 * filled ONLY for `sequence = 0` rows by a row trigger from a SEQUENCE, so every way a sequence 0
 * can land (append, appendBatch, appendIfUnchanged, copyPrefix, another process) assigns one. A
 * sequence never reuses a value after a delete, so a re-created id always gets a larger one.
 * Logs created before this column existed keep NULL (no backfill): their anchor stays the legacy
 * `timestamp:id`, and a rollback to an older kernel simply ignores the column.
 *
 * Runs LAST in `runMigration` (the hot `events` table is locked for the shortest stretch), under
 * the migration advisory lock, so two booting nodes cannot interleave. Everything is guarded by
 * the catalog, so every later boot is a no-op: `ADD COLUMN IF NOT EXISTS` alone would request
 * ACCESS EXCLUSIVE on `events` on EVERY boot (see the `timers` note in DDL_REST). The one real
 * ALTER (nullable, no default: metadata only) and the CREATE TRIGGER wait under
 * `loom.migration_lock_timeout` and FAIL SOFT like L10 (a WARNING, the subtransaction restores
 * the caller's lock_timeout): the store then reads the anchor without the column (legacy marker)
 * until a later boot installs it.
 */
const INCARNATION = `
    DO $incarnation$
    DECLARE
      caller_lock_timeout text := current_setting('lock_timeout');
      sch text;
      seq_name text;
      fn_version constant text := 'loom-incarnation-v3';
    BEGIN
      IF current_setting('loom.events_lock_failed', true) = 'on' THEN
        PERFORM set_config('loom.incarnation_skip', 'events is locked by another transaction (see the L10 warning)', true);
        RETURN;
      END IF;
      BEGIN
        -- The function is SECURITY DEFINER (with its own pinned search_path): a writer role that
        -- may INSERT into \`events\` but was never granted USAGE on the sequence must still be
        -- able to create an execution.
        -- Everything below names the schema of the \`events\` table explicitly: the trigger runs in
        -- the INSERTING session, whose search_path may be anything (pg_restore, ETL, another loom
        -- schema first), so the function bakes a schema-qualified sequence and pins its own path.
        SELECT n.nspname INTO sch
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.oid = 'events'::regclass;
        seq_name := format('%I.%I', sch, 'events_incarnation_seq');
        IF to_regclass(seq_name) IS NULL THEN
          EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %s', seq_name);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = 'events'::regclass AND attname = 'incarnation' AND NOT attisdropped
        ) THEN
          PERFORM set_config(
            'lock_timeout',
            COALESCE(NULLIF(current_setting('loom.migration_lock_timeout', true), ''), '2s'),
            true
          );
          ALTER TABLE events ADD COLUMN IF NOT EXISTS incarnation BIGINT;
          PERFORM set_config('lock_timeout', caller_lock_timeout, true);
        END IF;
        -- Only (re)created when missing or of an older body, so a boot after the tables were
        -- re-owned to an application role (which does not own the function) is a no-op.
        IF NOT EXISTS (
          SELECT 1 FROM pg_proc p
          WHERE p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = sch)
            AND p.proname = 'events_assign_incarnation'
            AND obj_description(p.oid, 'pg_proc') = fn_version
        ) THEN
          EXECUTE format(
            'CREATE OR REPLACE FUNCTION %I.events_assign_incarnation() RETURNS trigger AS $fn$ BEGIN NEW.incarnation := nextval(%L::regclass); RETURN NEW; END $fn$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp',
            sch, seq_name
          );
          -- Trigger firing needs no EXECUTE grant; nobody else should hold one on a SECURITY DEFINER function.
          EXECUTE format('REVOKE ALL ON FUNCTION %I.events_assign_incarnation() FROM PUBLIC', sch);
          EXECUTE format('COMMENT ON FUNCTION %I.events_assign_incarnation() IS %L', sch, fn_version);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'events'::regclass AND tgname = 'trg_events_incarnation'
        ) THEN
          PERFORM set_config(
            'lock_timeout',
            COALESCE(NULLIF(current_setting('loom.migration_lock_timeout', true), ''), '2s'),
            true
          );
          EXECUTE format(
            'CREATE TRIGGER trg_events_incarnation BEFORE INSERT ON events FOR EACH ROW WHEN (NEW.sequence = 0) EXECUTE FUNCTION %I.events_assign_incarnation()',
            sch
          );
          PERFORM set_config('lock_timeout', caller_lock_timeout, true);
        END IF;
      EXCEPTION
        WHEN lock_not_available OR query_canceled OR deadlock_detected OR insufficient_privilege
          OR feature_not_supported OR dependent_objects_still_exist THEN
          RAISE WARNING 'loom: the ADR 0129 incarnation column/trigger on events could not be installed (%: %). This node keeps the legacy creation-marker anchor (SPI 2.2.0 behaviour) until a later boot installs it.',
            SQLSTATE, SQLERRM;
          PERFORM set_config('loom.incarnation_skip', SQLSTATE || ': ' || SQLERRM, true);
      END;
    END
    $incarnation$;
`;

const DDL_REST = `
    -- The probe looks in the TABLE's own namespace (to_regclass would search the whole search_path and
    -- wrongly skip an index that exists in another schema).
    -- Every index below is created behind a catalog probe. \`CREATE INDEX IF NOT EXISTS\` takes a
    -- SHARE lock on the table BEFORE it notices the index exists, and migrate runs it under
    -- lock_timeout=0, so it HANGS behind a long-held SHARE UPDATE EXCLUSIVE lock (an anti-wraparound
    -- autovacuum). A probe on the (lock-free) catalog skips the statement on every boot after the first.
    DO $ix_idx_events_exec$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = 'idx_events_exec' AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = 'events'::regclass)) THEN CREATE INDEX IF NOT EXISTS idx_events_exec ON events (execution_id, sequence ASC); END IF; END $ix_idx_events_exec$;

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT NOT NULL PRIMARY KEY,
      execution_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      sequence BIGINT NOT NULL,
      state JSONB NOT NULL,
      created_at BIGINT NOT NULL
    );
    DO $ix_idx_snapshots_exec$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = 'idx_snapshots_exec' AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = 'snapshots'::regclass)) THEN CREATE INDEX IF NOT EXISTS idx_snapshots_exec ON snapshots (execution_id, sequence DESC); END IF; END $ix_idx_snapshots_exec$;

    -- ADR 0138: the compaction archive. Append-only segments of the envelopes a compaction removed.
    -- A new table only (CREATE TABLE IF NOT EXISTS takes no lock on a later boot); the primary key
    -- (execution_id, from_seq) is the only index the archive needs. \`body\` is TEXT, not JSONB, so the
    -- archived bytes are exactly what was written (no key reordering, no numeric normalisation).
    CREATE TABLE IF NOT EXISTS archive_segments (
      execution_id TEXT NOT NULL,
      from_seq BIGINT NOT NULL,
      through_seq BIGINT NOT NULL,
      n_events BIGINT NOT NULL,
      digest TEXT NOT NULL,
      incarnation TEXT NOT NULL,
      kind TEXT,
      sender_digest TEXT,
      body TEXT NOT NULL,
      PRIMARY KEY (execution_id, from_seq)
    );
    -- ADR 0139 N7: \`sender_digest\` (a plaintext reserved segment's sender digest). A table the 1.0.0 build
    -- created gains it with the same guarded add as \`timers.redrive\` (catalog first, one real ALTER under
    -- the migration lock timeout; the archive is not on any hot read path).
    DO $archive_sender_digest$
    DECLARE
      caller_lock_timeout text := current_setting('lock_timeout');
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'archive_segments' AND column_name = 'sender_digest'
      ) THEN
        PERFORM set_config(
          'lock_timeout',
          COALESCE(NULLIF(current_setting('loom.migration_lock_timeout', true), ''), '2s'),
          true
        );
        ALTER TABLE archive_segments ADD COLUMN IF NOT EXISTS sender_digest TEXT;
        PERFORM set_config('lock_timeout', caller_lock_timeout, true);
      END IF;
    END
    $archive_sender_digest$;

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
    DO $ix_idx_lineage_parent$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = 'idx_lineage_parent' AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = 'lineage'::regclass)) THEN CREATE INDEX IF NOT EXISTS idx_lineage_parent ON lineage (parent_execution_id); END IF; END $ix_idx_lineage_parent$;

    -- K9.4 fencing: the current monotonic fence token per execution. A row exists once a
    -- dispatcher/worker acquires a fence, AND (ADR 0118 D1) once the execution PARKS: a park
    -- writes an inert token-0 row so an answering append has a row to lock \`FOR SHARE\` against
    -- \`acquireFenceIf\`'s \`FOR UPDATE\` (deleteExecution removes a token-0 row with the log;
    -- a row with a real token is kept). Executions that never park or fence pay nothing.
    -- Appends carrying a stale/missing token are rejected in append().
    CREATE TABLE IF NOT EXISTS fences (
      execution_id TEXT NOT NULL PRIMARY KEY,
      fence BIGINT NOT NULL
    );

    -- T1 durable timers: pending wakes for suspended executions, in the same
    -- database as the event log so one backup captures the full kernel state.
    CREATE TABLE IF NOT EXISTS timers (
      execution_id TEXT NOT NULL,
      wake_at BIGINT NOT NULL,
      redrive JSONB,
      refused JSONB,
      PRIMARY KEY (execution_id, wake_at)
    );
    DO $ix_idx_timers_wake$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = 'idx_timers_wake' AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = 'timers'::regclass)) THEN CREATE INDEX IF NOT EXISTS idx_timers_wake ON timers (wake_at ASC); END IF; END $ix_idx_timers_wake$;
    -- ADR 0118 D4: \`redrive\` marks a re-drive row (a backed-off retry of a contended resume).
    -- \`CREATE TABLE IF NOT EXISTS\` never adds a column to a table an older version created, so
    -- an older table gains it here. \`ADD COLUMN IF NOT EXISTS\` would take ACCESS EXCLUSIVE on
    -- EVERY boot (the lock is requested before the existence check), queueing every timer read
    -- behind any open transaction; the catalog is consulted first, and the one real ALTER waits
    -- under \`loom.migration_lock_timeout\` (a timeout fails this boot, which retries cleanly).
    DO $timers_redrive$
    DECLARE
      caller_lock_timeout text := current_setting('lock_timeout');
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'timers' AND column_name = 'redrive'
      ) THEN
        PERFORM set_config(
          'lock_timeout',
          COALESCE(NULLIF(current_setting('loom.migration_lock_timeout', true), ''), '2s'),
          true
        );
        ALTER TABLE timers ADD COLUMN IF NOT EXISTS redrive JSONB;
        PERFORM set_config('lock_timeout', caller_lock_timeout, true);
      END IF;
    END
    $timers_redrive$;
    -- ADR 0130 D10: \`refused\` stamps a replay-refusal row with the log head at refusal. Same
    -- guarded add as \`redrive\` (catalog first, one real ALTER under the migration lock timeout).
    DO $timers_refused$
    DECLARE
      caller_lock_timeout text := current_setting('lock_timeout');
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'timers' AND column_name = 'refused'
      ) THEN
        PERFORM set_config(
          'lock_timeout',
          COALESCE(NULLIF(current_setting('loom.migration_lock_timeout', true), ''), '2s'),
          true
        );
        ALTER TABLE timers ADD COLUMN IF NOT EXISTS refused JSONB;
        PERFORM set_config('lock_timeout', caller_lock_timeout, true);
      END IF;
    END
    $timers_refused$;
    -- ADR 0130 D10: a PARTIAL index over the (rare) refusal rows only; a plain timer pays nothing
    -- for it, and a scan for refusal rows never walks the plain ones.
    DO $ix_idx_timers_refused$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = 'idx_timers_refused' AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = 'timers'::regclass)) THEN CREATE INDEX IF NOT EXISTS idx_timers_refused ON timers (wake_at ASC) WHERE refused IS NOT NULL; END IF; END $ix_idx_timers_refused$;

    -- #380 — durable ownership of a RUNNING execution. One row per execution: a lease is
    -- exclusive by definition, so the primary key is the mutual exclusion.
    CREATE TABLE IF NOT EXISTS leases (
      execution_id TEXT NOT NULL PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    );
    DO $ix_idx_leases_expiry$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = 'idx_leases_expiry' AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = 'leases'::regclass)) THEN CREATE INDEX IF NOT EXISTS idx_leases_expiry ON leases (expires_at ASC); END IF; END $ix_idx_leases_expiry$;
    -- ADR 0130 D11 (S7a): heartbeat leases make this table small, hot and update-churned (every
    -- renewal rewrites a row). fillfactor < 100 leaves free space in each page for the new row
    -- versions (and for HOT where an update leaves every indexed column alone; a renewal changes
    -- the indexed \`expires_at\`, so it is not HOT: the S7f bench measures it), and an aggressive
    -- per-table autovacuum keeps dead tuples from outrunning the default 20% scale factor.
    -- Guarded like the timers column: ALTER TABLE ... SET takes SHARE UPDATE EXCLUSIVE on every
    -- boot, so it runs only on a table with NO storage options (an operator-tuned table, or one a
    -- previous boot already filled, is left alone), under \`loom.migration_lock_timeout\`.
    DO $leases_storage$
    DECLARE
      caller_lock_timeout text := current_setting('lock_timeout');
    BEGIN
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_class
          WHERE oid = to_regclass('leases') AND reloptions IS NULL
        ) THEN
          PERFORM set_config(
            'lock_timeout',
            COALESCE(NULLIF(current_setting('loom.migration_lock_timeout', true), ''), '2s'),
            true
          );
          ALTER TABLE leases SET (
            fillfactor = 70,
            autovacuum_vacuum_scale_factor = 0.02,
            autovacuum_vacuum_threshold = 50,
            autovacuum_analyze_scale_factor = 0.05
          );
          PERFORM set_config('lock_timeout', caller_lock_timeout, true);
        END IF;
      EXCEPTION
        -- Optional tuning must never take the event log down: fail soft, a later boot retries.
        WHEN lock_not_available OR query_canceled OR deadlock_detected OR insufficient_privilege THEN
          RAISE WARNING 'loom: the ADR 0130 leases storage options (fillfactor/autovacuum) could not be applied (%: %). The table works untuned; a later boot retries.',
            SQLSTATE, SQLERRM;
      END;
    END
    $leases_storage$;

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
    DO $ix_idx_rm_rows_order$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = 'idx_rm_rows_order' AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = 'read_model_rows'::regclass)) THEN CREATE INDEX IF NOT EXISTS idx_rm_rows_order ON read_model_rows (model_id, kind, timestamp, sequence); END IF; END $ix_idx_rm_rows_order$;
    DO $ix_idx_rm_rows_fields$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = 'idx_rm_rows_fields' AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = 'read_model_rows'::regclass)) THEN CREATE INDEX IF NOT EXISTS idx_rm_rows_fields ON read_model_rows USING GIN (fields jsonb_path_ops); END IF; END $ix_idx_rm_rows_fields$;
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
    DO $ix_idx_memory_entries_key$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = 'idx_memory_entries_key' AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = 'memory_entries'::regclass)) THEN CREATE INDEX IF NOT EXISTS idx_memory_entries_key ON memory_entries (key, seq ASC); END IF; END $ix_idx_memory_entries_key$;
    -- Relevance search over searchableText(entry). The 'simple' configuration neither
    -- stems nor drops stopwords, which keeps it language-neutral and close to how SQLite's
    -- unicode61 tokenizer and @loom/memory's own tokenize() split text -- three backends
    -- that agree on what a term is. An expression index, so the column stays the source.
    DO $ix_idx_memory_entries_fts$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = 'idx_memory_entries_fts' AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = 'memory_entries'::regclass)) THEN CREATE INDEX IF NOT EXISTS idx_memory_entries_fts ON memory_entries USING GIN (to_tsvector('simple', text)); END IF; END $ix_idx_memory_entries_fts$;
    -- Removal by entry id (ADR 0091). An EXPRESSION index over the stored JSON, not a
    -- column: the entry is already persisted whole, so an id round-trips with no schema
    -- change and no migration of existing rows -- and a column would be a second copy
    -- able to disagree with the one the SPI actually reads back. Partial, because only
    -- corpus entries carry an id and indexing the NULLs would be most of the table.
    DO $ix_idx_memory_entries_id$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = 'idx_memory_entries_id' AND c.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = 'memory_entries'::regclass)) THEN CREATE INDEX IF NOT EXISTS idx_memory_entries_id ON memory_entries (key, (entry->>'id')) WHERE entry->>'id' IS NOT NULL; END IF; END $ix_idx_memory_entries_id$;
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
