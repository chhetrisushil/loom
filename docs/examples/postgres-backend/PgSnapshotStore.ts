// Reference: a Postgres-backed SnapshotStore for Loom. See PgEventStore.ts for
// context. Inject it into WorkflowRuntime exactly like SqliteSnapshotStore.

import type { ExecutionState } from "@loom/core";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import type { Pool } from "pg";

interface SnapshotRow {
  id: string;
  execution_id: string;
  workflow_id: string;
  sequence: string;
  state: ExecutionState;
  created_at: string;
}

function rowToSnapshot(r: SnapshotRow): Snapshot {
  return {
    id: r.id,
    executionId: r.execution_id,
    workflowId: r.workflow_id,
    sequence: Number(r.sequence),
    state: r.state,
    createdAt: Number(r.created_at),
  };
}

export class PgSnapshotStore implements SnapshotStore {
  constructor(private readonly pool: Pool) {}

  async save(s: Snapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO snapshots (id, execution_id, workflow_id, sequence, state, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         execution_id = EXCLUDED.execution_id,
         workflow_id  = EXCLUDED.workflow_id,
         sequence     = EXCLUDED.sequence,
         state        = EXCLUDED.state,
         created_at   = EXCLUDED.created_at`,
      [s.id, s.executionId, s.workflowId, s.sequence, JSON.stringify(s.state), s.createdAt]
    );
  }

  async loadLatest(executionId: string): Promise<Snapshot | null> {
    const { rows } = await this.pool.query<SnapshotRow>(
      "SELECT * FROM snapshots WHERE execution_id = $1 ORDER BY sequence DESC LIMIT 1",
      [executionId]
    );
    return rows[0] ? rowToSnapshot(rows[0]) : null;
  }

  async loadAt(executionId: string, sequence: number): Promise<Snapshot | null> {
    const { rows } = await this.pool.query<SnapshotRow>(
      "SELECT * FROM snapshots WHERE execution_id = $1 AND sequence = $2",
      [executionId, sequence]
    );
    return rows[0] ? rowToSnapshot(rows[0]) : null;
  }

  async loadLatestBefore(executionId: string, sequence: number): Promise<Snapshot | null> {
    const { rows } = await this.pool.query<SnapshotRow>(
      "SELECT * FROM snapshots WHERE execution_id = $1 AND sequence <= $2 ORDER BY sequence DESC LIMIT 1",
      [executionId, sequence]
    );
    return rows[0] ? rowToSnapshot(rows[0]) : null;
  }

  async close(): Promise<void> {
    // The Pool is typically shared with PgEventStore; close it once, there.
  }
}
