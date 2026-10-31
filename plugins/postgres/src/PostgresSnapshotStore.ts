import type { ExecutionState } from "@loom/core";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import { type PgConfig, type PoolLike, toPool } from "./pool";
import { migrate } from "./schema";

interface SnapshotRow {
  id: string;
  execution_id: string;
  workflow_id: string;
  sequence: string; // BIGINT → string
  state: unknown; // JSONB → parsed object
  created_at: string; // BIGINT → string
}

function rowToSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    executionId: row.execution_id,
    workflowId: row.workflow_id,
    sequence: Number(row.sequence),
    state: row.state as ExecutionState,
    createdAt: Number(row.created_at),
  };
}

/** Postgres-backed {@link SnapshotStore}. Same contract as the SQLite store. */
export class PostgresSnapshotStore implements SnapshotStore {
  private readonly pool: PoolLike;
  private readonly ownsPool: boolean;
  private readonly ready: Promise<void>;

  constructor(config: PgConfig) {
    const { pool, owned } = toPool(config);
    this.pool = pool;
    this.ownsPool = owned;
    this.ready = migrate(this.pool);
  }

  async save(snapshot: Snapshot): Promise<void> {
    await this.ready;
    // Upsert by id (a re-saved checkpoint replaces the prior one).
    await this.pool.query(
      `INSERT INTO snapshots (id, execution_id, workflow_id, sequence, state, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (id) DO UPDATE SET
         execution_id = EXCLUDED.execution_id,
         workflow_id = EXCLUDED.workflow_id,
         sequence = EXCLUDED.sequence,
         state = EXCLUDED.state,
         created_at = EXCLUDED.created_at`,
      [
        snapshot.id,
        snapshot.executionId,
        snapshot.workflowId,
        snapshot.sequence,
        JSON.stringify(snapshot.state),
        snapshot.createdAt,
      ]
    );
  }

  async loadLatest(executionId: string): Promise<Snapshot | null> {
    await this.ready;
    const { rows } = await this.pool.query<SnapshotRow>(
      "SELECT * FROM snapshots WHERE execution_id = $1 ORDER BY sequence DESC LIMIT 1",
      [executionId]
    );
    return rows[0] ? rowToSnapshot(rows[0]) : null;
  }

  async loadAt(executionId: string, sequence: number): Promise<Snapshot | null> {
    await this.ready;
    const { rows } = await this.pool.query<SnapshotRow>(
      "SELECT * FROM snapshots WHERE execution_id = $1 AND sequence = $2 LIMIT 1",
      [executionId, sequence]
    );
    return rows[0] ? rowToSnapshot(rows[0]) : null;
  }

  async loadLatestBefore(executionId: string, sequence: number): Promise<Snapshot | null> {
    await this.ready;
    const { rows } = await this.pool.query<SnapshotRow>(
      "SELECT * FROM snapshots WHERE execution_id = $1 AND sequence <= $2 ORDER BY sequence DESC LIMIT 1",
      [executionId, sequence]
    );
    return rows[0] ? rowToSnapshot(rows[0]) : null;
  }

  async deleteExecution(executionId: string): Promise<void> {
    await this.ready;
    await this.pool.query("DELETE FROM snapshots WHERE execution_id = $1", [executionId]);
  }

  async pruneSnapshots(
    executionId: string,
    range: { readonly after: number; readonly before: number },
    keep: readonly number[] = []
  ): Promise<number> {
    await this.ready;
    // One statement over idx_snapshots_exec (execution_id, sequence DESC).
    const res = await this.pool.query(
      `DELETE FROM snapshots WHERE execution_id = $1 AND sequence > $2 AND sequence < $3
       AND sequence <> ALL($4::bigint[])`,
      [executionId, range.after, range.before, keep]
    );
    return res.rowCount ?? 0;
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
