import type { BranchRef, BranchRegistry, LineageRecord } from "@loom/event-runtime";
import { type PgConfig, type PoolLike, toPool } from "./pool";
import { migrate } from "./schema";

interface RefRow {
  name: string;
  execution_id: string;
  tip: string;
  parent_execution_id: string | null;
  fork_sequence: string | null;
  created_at: string;
  updated_at: string;
}

interface LineageRow {
  execution_id: string;
  parent_execution_id: string;
  fork_sequence: string;
  created_at: string;
}

function rowToRef(row: RefRow): BranchRef {
  return {
    name: row.name,
    executionId: row.execution_id,
    tip: Number(row.tip),
    ...(row.parent_execution_id !== null && { parentExecutionId: row.parent_execution_id }),
    ...(row.fork_sequence !== null && { forkSequence: Number(row.fork_sequence) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToLineage(row: LineageRow): LineageRecord {
  return {
    executionId: row.execution_id,
    parentExecutionId: row.parent_execution_id,
    forkSequence: Number(row.fork_sequence),
    createdAt: Number(row.created_at),
  };
}

// Deterministic wall-clock is a store concern, not a replay path — but wall-clock is
// injected so tests stay deterministic and library code avoids a bare Date.now().
type Now = () => number;

/** Postgres-backed {@link BranchRegistry}. Same contract as the SQLite store. */
export class PostgresBranchRegistry implements BranchRegistry {
  private readonly pool: PoolLike;
  private readonly ownsPool: boolean;
  private readonly ready: Promise<void>;
  private readonly now: Now;

  constructor(config: PgConfig, opts?: { now?: Now }) {
    const { pool, owned } = toPool(config);
    this.pool = pool;
    this.ownsPool = owned;
    this.ready = migrate(this.pool);
    this.now = opts?.now ?? (() => Date.now());
  }

  async putRef(ref: BranchRef): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO refs (name, execution_id, tip, parent_execution_id, fork_sequence, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (name) DO UPDATE SET
         execution_id = EXCLUDED.execution_id,
         tip = EXCLUDED.tip,
         parent_execution_id = EXCLUDED.parent_execution_id,
         fork_sequence = EXCLUDED.fork_sequence,
         updated_at = EXCLUDED.updated_at`,
      [
        ref.name,
        ref.executionId,
        ref.tip,
        ref.parentExecutionId ?? null,
        ref.forkSequence ?? null,
        ref.createdAt,
        ref.updatedAt,
      ]
    );
  }

  async getRef(name: string): Promise<BranchRef | null> {
    await this.ready;
    const { rows } = await this.pool.query<RefRow>("SELECT * FROM refs WHERE name = $1", [name]);
    return rows[0] ? rowToRef(rows[0]) : null;
  }

  async listRefs(): Promise<BranchRef[]> {
    await this.ready;
    const { rows } = await this.pool.query<RefRow>("SELECT * FROM refs ORDER BY name ASC");
    return rows.map(rowToRef);
  }

  async moveTip(name: string, tip: number): Promise<void> {
    await this.ready;
    await this.pool.query("UPDATE refs SET tip = $1, updated_at = $2 WHERE name = $3", [
      tip,
      this.now(),
      name,
    ]);
  }

  async promote(fromName: string, toName: string): Promise<void> {
    const from = await this.getRef(fromName);
    if (from === null) {
      throw new Error(`Cannot promote: ref "${fromName}" does not exist`);
    }
    const existing = await this.getRef(toName);
    const now = this.now();
    await this.putRef({
      name: toName,
      executionId: from.executionId,
      tip: from.tip,
      ...(from.parentExecutionId !== undefined && { parentExecutionId: from.parentExecutionId }),
      ...(from.forkSequence !== undefined && { forkSequence: from.forkSequence }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async deleteRef(name: string): Promise<void> {
    await this.ready;
    await this.pool.query("DELETE FROM refs WHERE name = $1", [name]);
  }

  async recordLineage(rec: Omit<LineageRecord, "createdAt">): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO lineage (execution_id, parent_execution_id, fork_sequence, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (execution_id) DO UPDATE SET
         parent_execution_id = EXCLUDED.parent_execution_id,
         fork_sequence = EXCLUDED.fork_sequence,
         created_at = EXCLUDED.created_at`,
      [rec.executionId, rec.parentExecutionId, rec.forkSequence, this.now()]
    );
  }

  async getLineage(executionId: string): Promise<LineageRecord | null> {
    await this.ready;
    const { rows } = await this.pool.query<LineageRow>(
      "SELECT * FROM lineage WHERE execution_id = $1",
      [executionId]
    );
    return rows[0] ? rowToLineage(rows[0]) : null;
  }

  async children(executionId: string): Promise<LineageRecord[]> {
    await this.ready;
    const { rows } = await this.pool.query<LineageRow>(
      "SELECT * FROM lineage WHERE parent_execution_id = $1 ORDER BY created_at ASC",
      [executionId]
    );
    return rows.map(rowToLineage);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
