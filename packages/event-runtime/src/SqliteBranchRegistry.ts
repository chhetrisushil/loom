import Database from "better-sqlite3";
import type { BranchRef, BranchRegistry, LineageRecord } from "./BranchRegistry";
import { migrate } from "./schema";

interface RefRow {
  name: string;
  execution_id: string;
  tip: number;
  parent_execution_id: string | null;
  fork_sequence: number | null;
  created_at: number;
  updated_at: number;
}

interface LineageRow {
  execution_id: string;
  parent_execution_id: string;
  fork_sequence: number;
  created_at: number;
}

function rowToRef(row: RefRow): BranchRef {
  return {
    name: row.name,
    executionId: row.execution_id,
    tip: row.tip,
    ...(row.parent_execution_id !== null && { parentExecutionId: row.parent_execution_id }),
    ...(row.fork_sequence !== null && { forkSequence: row.fork_sequence }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToLineage(row: LineageRow): LineageRecord {
  return {
    executionId: row.execution_id,
    parentExecutionId: row.parent_execution_id,
    forkSequence: row.fork_sequence,
    createdAt: row.created_at,
  };
}

/**
 * SQLite-backed {@link BranchRegistry}. Lives in @loom/event-runtime because
 * refs describe event-log topology; point it at the same DB file as the
 * SqliteEventStore (migrate() creates the `refs`/`lineage` tables idempotently).
 */
export class SqliteBranchRegistry implements BranchRegistry {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    migrate(this.db);
  }

  putRef(ref: BranchRef): void {
    this.db
      .prepare<[string, string, number, string | null, number | null, number, number]>(`
        INSERT INTO refs (name, execution_id, tip, parent_execution_id, fork_sequence, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          execution_id = excluded.execution_id,
          tip = excluded.tip,
          parent_execution_id = excluded.parent_execution_id,
          fork_sequence = excluded.fork_sequence,
          updated_at = excluded.updated_at
      `)
      .run(
        ref.name,
        ref.executionId,
        ref.tip,
        ref.parentExecutionId ?? null,
        ref.forkSequence ?? null,
        ref.createdAt,
        ref.updatedAt
      );
  }

  getRef(name: string): BranchRef | null {
    const row = this.db.prepare<[string], RefRow>("SELECT * FROM refs WHERE name = ?").get(name);
    return row ? rowToRef(row) : null;
  }

  listRefs(): BranchRef[] {
    const rows = this.db.prepare<[], RefRow>("SELECT * FROM refs ORDER BY name ASC").all();
    return rows.map(rowToRef);
  }

  moveTip(name: string, tip: number): void {
    this.db
      .prepare<[number, number, string]>("UPDATE refs SET tip = ?, updated_at = ? WHERE name = ?")
      .run(tip, Date.now(), name);
  }

  promote(fromName: string, toName: string): void {
    const from = this.getRef(fromName);
    if (!from) {
      throw new Error(`Cannot promote: ref "${fromName}" does not exist`);
    }
    const existing = this.getRef(toName);
    const now = Date.now();
    this.putRef({
      name: toName,
      executionId: from.executionId,
      tip: from.tip,
      ...(from.parentExecutionId !== undefined && { parentExecutionId: from.parentExecutionId }),
      ...(from.forkSequence !== undefined && { forkSequence: from.forkSequence }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  deleteRef(name: string): void {
    this.db.prepare<[string]>("DELETE FROM refs WHERE name = ?").run(name);
  }

  recordLineage(rec: Omit<LineageRecord, "createdAt">): void {
    this.db
      .prepare<[string, string, number, number]>(`
        INSERT OR REPLACE INTO lineage (execution_id, parent_execution_id, fork_sequence, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(rec.executionId, rec.parentExecutionId, rec.forkSequence, Date.now());
  }

  getLineage(executionId: string): LineageRecord | null {
    const row = this.db
      .prepare<[string], LineageRow>("SELECT * FROM lineage WHERE execution_id = ?")
      .get(executionId);
    return row ? rowToLineage(row) : null;
  }

  children(executionId: string): LineageRecord[] {
    const rows = this.db
      .prepare<[string], LineageRow>(
        "SELECT * FROM lineage WHERE parent_execution_id = ? ORDER BY created_at ASC"
      )
      .all(executionId);
    return rows.map(rowToLineage);
  }

  close(): void {
    this.db.close();
  }
}
