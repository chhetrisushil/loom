import type { ExecutionState } from "@loom/core";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import Database from "better-sqlite3";
import { migrate } from "./snapshotSchema";

interface SnapshotRow {
  id: string;
  execution_id: string;
  workflow_id: string;
  sequence: number;
  state: string;
  created_at: number;
}

function rowToSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    executionId: row.execution_id,
    workflowId: row.workflow_id,
    sequence: row.sequence,
    state: JSON.parse(row.state) as ExecutionState,
    createdAt: row.created_at,
  };
}

export class SqliteSnapshotStore implements SnapshotStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    migrate(this.db);
  }

  async save(snapshot: Snapshot): Promise<void> {
    this.db
      .prepare<[string, string, string, number, string, number]>(`
        INSERT OR REPLACE INTO snapshots (id, execution_id, workflow_id, sequence, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        snapshot.id,
        snapshot.executionId,
        snapshot.workflowId,
        snapshot.sequence,
        JSON.stringify(snapshot.state),
        snapshot.createdAt
      );
  }

  async loadLatest(executionId: string): Promise<Snapshot | null> {
    const row = this.db
      .prepare<[string], SnapshotRow>(
        "SELECT * FROM snapshots WHERE execution_id = ? ORDER BY sequence DESC LIMIT 1"
      )
      .get(executionId);
    return row ? rowToSnapshot(row) : null;
  }

  async loadAt(executionId: string, sequence: number): Promise<Snapshot | null> {
    const row = this.db
      .prepare<[string, number], SnapshotRow>(
        "SELECT * FROM snapshots WHERE execution_id = ? AND sequence = ?"
      )
      .get(executionId, sequence);
    return row ? rowToSnapshot(row) : null;
  }

  async loadLatestBefore(executionId: string, sequence: number): Promise<Snapshot | null> {
    const row = this.db
      .prepare<[string, number], SnapshotRow>(
        "SELECT * FROM snapshots WHERE execution_id = ? AND sequence <= ? ORDER BY sequence DESC LIMIT 1"
      )
      .get(executionId, sequence);
    return row ? rowToSnapshot(row) : null;
  }

  async deleteExecution(executionId: string): Promise<void> {
    this.db.prepare<[string]>("DELETE FROM snapshots WHERE execution_id = ?").run(executionId);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
