import type { ExecutionState } from "@loom/core";
import {
  type Snapshot,
  type SnapshotCodecName,
  type SnapshotStore,
  assertSnapshotCodecAvailable,
  decodeState,
  encodeState,
  parseSnapshotCodec,
} from "@loom/snapshot-runtime";
import Database from "better-sqlite3";
import { migrate } from "./snapshotSchema";

interface SnapshotRow {
  id: string;
  execution_id: string;
  workflow_id: string;
  sequence: number;
  // TEXT for a pre-codec row (JSON text); a BLOB (Buffer) for an ADR 0141 codec frame. SQLite is dynamically
  // typed, so the TEXT-declared column holds either; the storage class IS the format discriminator.
  state: string | Buffer;
  created_at: number;
}

export interface SqliteSnapshotStoreOptions {
  /**
   * ADR 0141 - how NEW snapshots are written. `"none"` (default): JSON text, byte-identical to before.
   * `"zstd"`: a BLOB frame (format byte + zstd-compressed JSON) in the same `state` column. Reads accept
   * BOTH whatever this is set to, and nothing is rewritten. Throws at construction on a Node without zstd
   * (>= 22.15). No schema change: SQLite's column affinity keeps a BLOB a BLOB.
   */
  codec?: SnapshotCodecName;
}

function rowToSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    executionId: row.execution_id,
    workflowId: row.workflow_id,
    sequence: row.sequence,
    state: (typeof row.state === "string"
      ? JSON.parse(row.state)
      : decodeState(row.state)) as ExecutionState,
    createdAt: row.created_at,
  };
}

export class SqliteSnapshotStore implements SnapshotStore {
  private readonly db: Database.Database;
  /** ADR 0141 - the codec new snapshots are written with (structural; `ProfilingSnapshotStore` reads it). */
  readonly snapshotCodec: SnapshotCodecName;

  constructor(dbPath: string, options: SqliteSnapshotStoreOptions = {}) {
    this.snapshotCodec = parseSnapshotCodec(options.codec);
    assertSnapshotCodecAvailable(this.snapshotCodec);
    this.db = new Database(dbPath);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      migrate(this.db);
    } catch (err) {
      this.db.close(); // don't leak the file handle if setup fails on a bad/locked file
      throw err;
    }
  }

  async save(snapshot: Snapshot): Promise<void> {
    this.db
      .prepare<[string, string, string, number, string | Buffer, number]>(`
        INSERT OR REPLACE INTO snapshots (id, execution_id, workflow_id, sequence, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        snapshot.id,
        snapshot.executionId,
        snapshot.workflowId,
        snapshot.sequence,
        this.snapshotCodec === "none"
          ? JSON.stringify(snapshot.state)
          : encodeState(snapshot.state, this.snapshotCodec),
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

  async pruneSnapshots(
    executionId: string,
    range: { readonly after: number; readonly before: number },
    keep: readonly number[] = []
  ): Promise<number> {
    // One statement. The keep-set is a bound JSON array, not an interpolated list.
    const info = this.db
      .prepare<[string, number, number, string]>(
        `DELETE FROM snapshots WHERE execution_id = ? AND sequence > ? AND sequence < ?
         AND sequence NOT IN (SELECT value FROM json_each(?))`
      )
      .run(executionId, range.after, range.before, JSON.stringify(keep));
    return info.changes;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
