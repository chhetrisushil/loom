import Database from "better-sqlite3";
import type { TimerRecord, TimerStore } from "./timers";

interface TimerRow {
  execution_id: string;
  wake_at: number;
}

/**
 * SQLite-backed {@link TimerStore} (T1.3). Point it at the same DB file as the
 * SqliteEventStore so a single backup captures events + timers — the full
 * kernel state. Own idempotent migration, same pattern as SqliteBranchRegistry.
 */
export class SqliteTimerStore implements TimerStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS timers (
        execution_id TEXT NOT NULL,
        wake_at INTEGER NOT NULL,
        PRIMARY KEY (execution_id, wake_at)
      );
      CREATE INDEX IF NOT EXISTS idx_timers_wake ON timers (wake_at ASC);
    `);
  }

  async schedule(timer: TimerRecord): Promise<void> {
    this.db
      .prepare<[string, number]>(
        "INSERT OR IGNORE INTO timers (execution_id, wake_at) VALUES (?, ?)"
      )
      .run(timer.executionId, timer.wakeAt);
  }

  async due(now: number, limit = 100): Promise<TimerRecord[]> {
    const rows = this.db
      .prepare<[number, number]>(
        "SELECT execution_id, wake_at FROM timers WHERE wake_at <= ? ORDER BY wake_at ASC LIMIT ?"
      )
      .all(now, limit) as TimerRow[];
    return rows.map((r) => ({ executionId: r.execution_id, wakeAt: r.wake_at }));
  }

  async complete(executionId: string, wakeAt: number): Promise<void> {
    this.db
      .prepare<[string, number]>("DELETE FROM timers WHERE execution_id = ? AND wake_at = ?")
      .run(executionId, wakeAt);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
