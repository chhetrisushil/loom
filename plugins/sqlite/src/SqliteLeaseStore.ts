import { type Lease, type LeaseStore, assertTtl } from "@loom/event-runtime";
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
    now = Date.now()
  ): Promise<Lease | null> {
    assertTtl(ttlMs);
    const expiresAt = now + ttlMs;
    // One statement, so two processes on the same file cannot both win: the insert takes a
    // free row, and the conflict clause takes it only when it is ours or already expired.
    const info = this.db
      .prepare<[string, string, number, string, number]>(
        `INSERT INTO leases (execution_id, owner, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(execution_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
         WHERE leases.owner = ? OR leases.expires_at <= ?`
      )
      .run(executionId, owner, expiresAt, owner, now);
    return info.changes > 0 ? { executionId, owner, expiresAt } : null;
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
