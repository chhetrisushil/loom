import {
  type AcquireOptions,
  type Lease,
  type LeaseStore,
  assertNoBatchSteal,
  assertSteal,
  assertTtl,
} from "@loom/event-runtime";
import { type PgConfig, type PoolLike, toPool } from "./pool";
import { migrate } from "./schema";

interface LeaseRow {
  execution_id: string;
  owner: string;
  expires_at: string; // BIGINT → string from node-postgres
}

const rowToLease = (r: LeaseRow): Lease => ({
  executionId: r.execution_id,
  owner: r.owner,
  expiresAt: Number(r.expires_at),
});

/**
 * The database's wall clock in epoch ms, as a scalar subquery: ONE reading per statement, and
 * index-usable.
 *
 * `clock_timestamp()`, deliberately: `now()`/`transaction_timestamp()` is frozen at transaction
 * start, so a caller-supplied pool client sitting inside a long transaction would stamp (and
 * judge) on a stale reading. But `clock_timestamp()` is VOLATILE, and a volatile call inside a
 * WHERE is re-evaluated per row, which turns `expires_at <= <expr>` into a Filter and makes the
 * `expired()` walk over `idx_leases_expiry` cover the whole index (143 ms at 200k live leases).
 * Wrapping it in `(SELECT ...)` makes it an uncorrelated InitPlan: evaluated once, then a plain
 * Index Cond. The single reading also means `acquire`'s stamp and takeover test agree.
 */
const DB_NOW_MS = "(SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint)";

/** `now` if given, else DB time. `$n` must be passed `now ?? null`. */
const nowOrDb = (param: number): string => `COALESCE($${param}::bigint, ${DB_NOW_MS})`;

/**
 * The exact SQL `expired()` runs (`$1` = explicit now or NULL, `$2` = limit). Exported so the
 * index-usage test EXPLAINs the real query rather than a copy.
 */
export const EXPIRED_SQL = `SELECT * FROM leases WHERE expires_at <= ${nowOrDb(1)}
       ORDER BY expires_at ASC LIMIT $2`;

/*
 * TTL: `assertTtl` accepts any positive finite number, but the column arithmetic is `$n::bigint`
 * and Postgres rejects a fractional bigint. Round UP (a lease is never shorter than asked) in
 * acquire/renew rather than tightening the cross-backend SPI check.
 */

/**
 * Postgres-backed {@link LeaseStore} (#380) — the multi-node backend, and the one that
 * matters: a lease answers "which node owns this execution", which is only a question when
 * there is more than one.
 *
 * Acquisition is **one statement**. Read-then-write would let two nodes both observe a free
 * lease and both take it, which is precisely the race this exists to lose loudly: the
 * conflict clause takes an existing row only when it is already ours or has expired, and a
 * zero rowcount is the other node winning.
 *
 * **One clock for every node (L29).** When `now` is omitted, expiry is stamped
 * (`acquire`/`renew`: DB now + ttl) and judged (`expired`, and the `acquire` takeover
 * condition) on the DATABASE's clock, so node skew cannot make a live lease look expired or
 * let a fast node steal one. An explicit `now` is still honoured verbatim (tests, simulated
 * clocks), on the caller's timeline: mixing explicit-`now` and default calls against one lease
 * table is unsupported, since the stamps come from two unrelated clocks. The returned
 * `Lease.expiresAt` is in DB time, and {@link PostgresLeaseStore.storeNow} reads that clock, so a
 * caller that must compare against it (`orphanCensus`) can.
 */
export class PostgresLeaseStore implements LeaseStore {
  readonly scope = "cluster" as const;
  private readonly pool: PoolLike;
  private readonly ownsPool: boolean;
  private readonly ready: Promise<void>;

  constructor(config: PgConfig) {
    const { pool, owned } = toPool(config);
    this.pool = pool;
    this.ownsPool = owned;
    this.ready = migrate(this.pool);
  }

  async acquire(
    executionId: string,
    owner: string,
    ttlMs: number,
    now?: number,
    options?: AcquireOptions
  ): Promise<Lease | null> {
    assertTtl(ttlMs);
    const steal = assertSteal(options);
    const ttl = Math.ceil(ttlMs);
    await this.ready;
    // `now` undefined => both the stamp and the takeover test use the DB clock (NULL params
    // fall through the coalesce), read ONCE via the `t` CTE; explicit => the caller's number.
    const { rows } = await this.pool.query<LeaseRow>(
      `WITH t(n) AS (SELECT ${nowOrDb(4)})
       INSERT INTO leases (execution_id, owner, expires_at)
       VALUES ($1, $2, (SELECT n FROM t) + $3::bigint)
       ON CONFLICT (execution_id) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
       WHERE leases.owner = $2 OR leases.expires_at <= (SELECT n FROM t) OR $5::boolean
       RETURNING execution_id, owner, expires_at`,
      [executionId, owner, ttl, now ?? null, steal]
    );
    return rows[0] ? rowToLease(rows[0]) : null;
  }

  /**
   * Many leases in ONE statement (SPI 2.2.0). Same conflict rule as {@link acquire}; the ids are
   * deduped (a multi-row upsert that names a key twice is an error) and sorted so two concurrent
   * batches take their row locks in the same order and cannot deadlock each other.
   */
  async acquireMany(
    executionIds: readonly string[],
    owner: string,
    ttlMs: number,
    now?: number,
    options?: AcquireOptions
  ): Promise<Lease[]> {
    assertTtl(ttlMs);
    assertNoBatchSteal(options);
    const ids = [...new Set(executionIds)].sort();
    if (ids.length === 0) return [];
    const ttl = Math.ceil(ttlMs);
    await this.ready;
    const { rows } = await this.pool.query<LeaseRow>(
      `WITH t(n) AS (SELECT ${nowOrDb(4)})
       INSERT INTO leases (execution_id, owner, expires_at)
       SELECT id, $2, (SELECT n FROM t) + $3::bigint
       FROM unnest($1::text[]) AS u(id) ORDER BY id
       ON CONFLICT (execution_id) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
       WHERE leases.owner = $2 OR leases.expires_at <= (SELECT n FROM t)
       RETURNING execution_id, owner, expires_at`,
      [ids, owner, ttl, now ?? null]
    );
    return rows.map(rowToLease);
  }

  /**
   * One statement for everything the node holds. `RETURNING` IS the held set: a row that was
   * released, taken over or never existed is simply not updated, so nothing is resurrected. The
   * locking subselect is ordered so concurrent batches cannot deadlock.
   */
  async renewMany(
    executionIds: readonly string[],
    owner: string,
    ttlMs: number,
    now?: number
  ): Promise<string[]> {
    assertTtl(ttlMs);
    const ids = [...new Set(executionIds)];
    if (ids.length === 0) return [];
    const ttl = Math.ceil(ttlMs);
    await this.ready;
    const { rows } = await this.pool.query<{ execution_id: string }>(
      `WITH t(n) AS (SELECT ${nowOrDb(1)}),
            mine AS (
              SELECT execution_id FROM leases
              WHERE execution_id = ANY($2::text[]) AND owner = $3
              ORDER BY execution_id FOR UPDATE
            )
       UPDATE leases SET expires_at = (SELECT n FROM t) + $4::bigint
       WHERE execution_id IN (SELECT execution_id FROM mine) AND owner = $3
       RETURNING execution_id`,
      [now ?? null, ids, owner, ttl]
    );
    return rows.map((r) => r.execution_id);
  }

  async releaseMany(executionIds: readonly string[], owner: string): Promise<void> {
    const ids = [...new Set(executionIds)];
    if (ids.length === 0) return;
    await this.ready;
    await this.pool.query(
      `DELETE FROM leases WHERE execution_id IN (
         SELECT execution_id FROM leases
         WHERE execution_id = ANY($1::text[]) AND owner = $2
         ORDER BY execution_id FOR UPDATE
       ) AND owner = $2`,
      [ids, owner]
    );
  }

  async renew(executionId: string, owner: string, ttlMs: number, now?: number): Promise<boolean> {
    assertTtl(ttlMs);
    const ttl = Math.ceil(ttlMs);
    await this.ready;
    const { rowCount } = await this.pool.query(
      `UPDATE leases SET expires_at = ${nowOrDb(1)} + $4::bigint
       WHERE execution_id = $2 AND owner = $3`,
      [now ?? null, executionId, owner, ttl]
    );
    return (rowCount ?? 0) > 0;
  }

  async expired(now?: number, limit = 100): Promise<Lease[]> {
    await this.ready;
    const { rows } = await this.pool.query<LeaseRow>(EXPIRED_SQL, [now ?? null, limit]);
    return rows.map(rowToLease);
  }

  /** The database's clock (epoch ms): the one `expiresAt` is stamped and judged on. */
  async storeNow(): Promise<number> {
    await this.ready;
    const { rows } = await this.pool.query<{ now: string }>(`SELECT ${DB_NOW_MS} AS now`);
    return Number(rows[0]?.now);
  }

  async get(executionId: string): Promise<Lease | null> {
    await this.ready;
    const { rows } = await this.pool.query<LeaseRow>(
      "SELECT * FROM leases WHERE execution_id = $1",
      [executionId]
    );
    return rows[0] ? rowToLease(rows[0]) : null;
  }

  async release(executionId: string, owner: string): Promise<void> {
    await this.ready;
    await this.pool.query("DELETE FROM leases WHERE execution_id = $1 AND owner = $2", [
      executionId,
      owner,
    ]);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
