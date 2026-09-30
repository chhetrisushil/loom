import { type Lease, type LeaseStore, assertTtl } from "@loom/event-runtime";
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
 * The database's wall clock in epoch ms, evaluated where the row is written or judged.
 *
 * `clock_timestamp()`, deliberately: `now()`/`transaction_timestamp()` is frozen at transaction
 * start, so a caller-supplied pool client sitting inside a long transaction would stamp (and
 * judge) on a stale reading, and `statement_timestamp()` is fixed at statement start. A lease
 * is a liveness claim about the moment it is written, so the actual reading is the honest one.
 * It is evaluated per use inside a statement, which is fine: every comparison is against a
 * stamp written by this same clock.
 */
const DB_NOW_MS = "(extract(epoch from clock_timestamp()) * 1000)::bigint";

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
 * `Lease.expiresAt` is in DB time; a caller comparing it to its own `Date.now()` (e.g.
 * `orphanCensus`) inherits that node's skew, which only affects that advisory read.
 */
export class PostgresLeaseStore implements LeaseStore {
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
    now?: number
  ): Promise<Lease | null> {
    assertTtl(ttlMs);
    await this.ready;
    // `now` undefined => both the stamp and the takeover test use the DB clock (NULL params
    // fall through the coalesce); explicit => the caller's number, exactly as before.
    const { rows } = await this.pool.query<LeaseRow>(
      `INSERT INTO leases (execution_id, owner, expires_at)
       VALUES ($1, $2, COALESCE($4::bigint, ${DB_NOW_MS}) + $3::bigint)
       ON CONFLICT (execution_id) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
       WHERE leases.owner = $2 OR leases.expires_at <= COALESCE($4::bigint, ${DB_NOW_MS})
       RETURNING execution_id, owner, expires_at`,
      [executionId, owner, ttlMs, now ?? null]
    );
    return rows[0] ? rowToLease(rows[0]) : null;
  }

  async renew(executionId: string, owner: string, ttlMs: number, now?: number): Promise<boolean> {
    assertTtl(ttlMs);
    await this.ready;
    const { rowCount } = await this.pool.query(
      `UPDATE leases SET expires_at = COALESCE($1::bigint, ${DB_NOW_MS}) + $4::bigint
       WHERE execution_id = $2 AND owner = $3`,
      [now ?? null, executionId, owner, ttlMs]
    );
    return (rowCount ?? 0) > 0;
  }

  async expired(now?: number, limit = 100): Promise<Lease[]> {
    await this.ready;
    const { rows } = await this.pool.query<LeaseRow>(
      `SELECT * FROM leases WHERE expires_at <= COALESCE($1::bigint, ${DB_NOW_MS})
       ORDER BY expires_at ASC LIMIT $2`,
      [now ?? null, limit]
    );
    return rows.map(rowToLease);
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
