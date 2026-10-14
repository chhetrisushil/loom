import {
  type AcquireOptions,
  type Lease,
  type LeaseStore,
  assertSteal,
  assertTtl,
} from "@loom/event-runtime";
import Database from "better-sqlite3";
import { migrate } from "./schema";

interface LeaseRow {
  execution_id: string;
  owner: string;
  expires_at: number;
}

const rowToLease = (r: LeaseRow): Lease => ({
  executionId: r.execution_id,
  owner: r.owner,
  expiresAt: r.expires_at,
});

/**
 * SQLite {@link LeaseStore} (#380). Single-host by nature — better-sqlite3 is synchronous and
 * the file is the boundary — which is the right scope for it: leases answer "which of my nodes
 * owns this", and a single-host deployment has one. Multi-node wants Postgres.
 */
export class SqliteLeaseStore implements LeaseStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    migrate(this.db);
  }

  async acquire(
    executionId: string,
    owner: string,
    ttlMs: number,
    now = Date.now(),
    options?: AcquireOptions
  ): Promise<Lease | null> {
    assertTtl(ttlMs);
    const steal = assertSteal(options);
    return this.acquireOne(executionId, owner, ttlMs, now, steal);
  }

  // One statement, so two processes on the same file cannot both win: the insert takes a
  // free row, and the conflict clause takes it only when it is ours, already expired, or the
  // caller holds a steal proof (validated by `acquire`/`acquireMany` before this runs).
  private acquireOne(
    executionId: string,
    owner: string,
    ttlMs: number,
    now: number,
    steal: boolean
  ): Lease | null {
    const expiresAt = now + ttlMs;
    const info = this.db
      .prepare<[string, string, number, string, number, number]>(
        `INSERT INTO leases (execution_id, owner, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(execution_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
         WHERE leases.owner = ? OR leases.expires_at <= ? OR ? = 1`
      )
      .run(executionId, owner, expiresAt, owner, now, steal ? 1 : 0);
    return info.changes > 0 ? { executionId, owner, expiresAt } : null;
  }

  /** Many leases in one transaction (SPI 2.2.0): per id exactly {@link acquire}, atomically. */
  async acquireMany(
    executionIds: readonly string[],
    owner: string,
    ttlMs: number,
    now = Date.now(),
    options?: AcquireOptions
  ): Promise<Lease[]> {
    assertTtl(ttlMs);
    const steal = assertSteal(options);
    const ids = [...new Set(executionIds)];
    return this.db.transaction(() => {
      const out: Lease[] = [];
      for (const id of ids) {
        const lease = this.acquireOne(id, owner, ttlMs, now, steal);
        if (lease !== null) out.push(lease);
      }
      return out;
    })();
  }

  /** The HELD set: ids whose lease `owner` still holds, extended. Never resurrects a missing row. */
  async renewMany(
    executionIds: readonly string[],
    owner: string,
    ttlMs: number,
    now = Date.now()
  ): Promise<string[]> {
    assertTtl(ttlMs);
    const ids = [...new Set(executionIds)];
    const stmt = this.db.prepare<[number, string, string]>(
      "UPDATE leases SET expires_at = ? WHERE execution_id = ? AND owner = ?"
    );
    return this.db.transaction(() =>
      ids.filter((id) => stmt.run(now + ttlMs, id, owner).changes > 0)
    )();
  }

  async releaseMany(executionIds: readonly string[], owner: string): Promise<void> {
    const ids = [...new Set(executionIds)];
    const stmt = this.db.prepare<[string, string]>(
      "DELETE FROM leases WHERE execution_id = ? AND owner = ?"
    );
    this.db.transaction(() => {
      for (const id of ids) stmt.run(id, owner);
    })();
  }

  async renew(
    executionId: string,
    owner: string,
    ttlMs: number,
    now = Date.now()
  ): Promise<boolean> {
    assertTtl(ttlMs);
    const info = this.db
      .prepare<[number, string, string]>(
        "UPDATE leases SET expires_at = ? WHERE execution_id = ? AND owner = ?"
      )
      .run(now + ttlMs, executionId, owner);
    return info.changes > 0;
  }

  async expired(now = Date.now(), limit = 100): Promise<Lease[]> {
    const rows = this.db
      .prepare<[number, number], LeaseRow>(
        "SELECT * FROM leases WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT ?"
      )
      .all(now, limit);
    return rows.map(rowToLease);
  }

  async get(executionId: string): Promise<Lease | null> {
    const row = this.db
      .prepare<[string], LeaseRow>("SELECT * FROM leases WHERE execution_id = ?")
      .get(executionId);
    return row ? rowToLease(row) : null;
  }

  async release(executionId: string, owner: string): Promise<void> {
    this.db
      .prepare<[string, string]>("DELETE FROM leases WHERE execution_id = ? AND owner = ?")
      .run(executionId, owner);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
