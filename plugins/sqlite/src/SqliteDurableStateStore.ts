import type { DurableStateRecord, DurableStateStore } from "@loom/plugin-durable-state";
import { RevisionConflictError } from "@loom/plugin-durable-state";
import Database from "better-sqlite3";

interface DurableStateRow {
  contract_version: number;
  revision: number;
  payload: string;
}

/**
 * SQLite-backed {@link DurableStateStore} (ADR 0051 D2). Point it at the same
 * DB file as the SqliteEventStore so one backup captures events + carry state.
 * Own idempotent migration, same pattern as SqliteTimerStore. CAS rides
 * single-statement atomicity: the guarded INSERT/UPDATE either lands the new
 * revision or changes nothing, and a zero-change outcome reports the actual
 * revision in a loud RevisionConflictError.
 */
export class SqliteDurableStateStore implements DurableStateStore {
  private readonly db: Database.Database;
  private readonly loadStmt: Database.Statement;
  private readonly insertStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;
  private readonly revisionStmt: Database.Statement;
  private readonly clearStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS durable_state (
          key TEXT PRIMARY KEY,
          contract_version INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          payload TEXT NOT NULL
        );
      `);
      this.loadStmt = this.db.prepare(
        "SELECT contract_version, revision, payload FROM durable_state WHERE key = ?"
      );
      this.insertStmt = this.db.prepare(
        "INSERT OR IGNORE INTO durable_state (key, contract_version, revision, payload) VALUES (?, ?, 1, ?)"
      );
      this.updateStmt = this.db.prepare(
        "UPDATE durable_state SET contract_version = ?, revision = ?, payload = ? WHERE key = ? AND revision = ?"
      );
      this.revisionStmt = this.db.prepare("SELECT revision FROM durable_state WHERE key = ?");
      this.clearStmt = this.db.prepare("DELETE FROM durable_state WHERE key = ?");
    } catch (err) {
      this.db.close(); // don't leak the file handle if setup fails on a bad/locked file
      throw err;
    }
  }

  async load(key: string): Promise<DurableStateRecord | null> {
    const row = this.loadStmt.get(key) as DurableStateRow | undefined;
    if (row === undefined) return null;
    return {
      contractVersion: row.contract_version,
      revision: row.revision,
      payload: JSON.parse(row.payload),
    };
  }

  async save(
    key: string,
    value: { contractVersion: number; payload: unknown },
    expectedRevision: number
  ): Promise<DurableStateRecord> {
    const payload = JSON.stringify(value.payload);
    const changes =
      expectedRevision === 0
        ? this.insertStmt.run(key, value.contractVersion, payload).changes
        : this.updateStmt.run(
            value.contractVersion,
            expectedRevision + 1,
            payload,
            key,
            expectedRevision
          ).changes;
    if (changes === 1) {
      return {
        contractVersion: value.contractVersion,
        revision: expectedRevision + 1,
        payload: value.payload,
      };
    }
    const row = this.revisionStmt.get(key) as { revision: number } | undefined;
    throw new RevisionConflictError(key, expectedRevision, row?.revision ?? 0);
  }

  async clear(key: string): Promise<void> {
    this.clearStmt.run(key);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
