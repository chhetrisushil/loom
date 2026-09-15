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
 * Postgres-backed {@link LeaseStore} (#380) — the multi-node backend, and the one that
 * matters: a lease answers "which node owns this execution", which is only a question when
 * there is more than one.
 *
 * Acquisition is **one statement**. Read-then-write would let two nodes both observe a free
 * lease and both take it, which is precisely the race this exists to lose loudly: the
 * conflict clause takes an existing row only when it is already ours or has expired, and a
 * zero rowcount is the other node winning.
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
    now = Date.now()
  ): Promise<Lease | null> {
    assertTtl(ttlMs);
    await this.ready;
    const expiresAt = now + ttlMs;
    const { rowCount } = await this.pool.query(
      `INSERT INTO leases (execution_id, owner, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (execution_id) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
       WHERE leases.owner = $2 OR leases.expires_at <= $4`,
      [executionId, owner, expiresAt, now]
    );
    return rowCount === 0 ? null : { executionId, owner, expiresAt };
  }

  async renew(
    executionId: string,
    owner: string,
    ttlMs: number,
    now = Date.now()
  ): Promise<boolean> {
    assertTtl(ttlMs);
    await this.ready;
    const { rowCount } = await this.pool.query(
      "UPDATE leases SET expires_at = $1 WHERE execution_id = $2 AND owner = $3",
      [now + ttlMs, executionId, owner]
    );
    return (rowCount ?? 0) > 0;
  }

  async expired(now = Date.now(), limit = 100): Promise<Lease[]> {
    await this.ready;
    const { rows } = await this.pool.query<LeaseRow>(
      "SELECT * FROM leases WHERE expires_at <= $1 ORDER BY expires_at ASC LIMIT $2",
      [now, limit]
    );
    return rows.map(rowToLease);
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
