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
import { type PgConfig, type PoolLike, toPool } from "./pool";
import { ensureSnapshotZstd, migrate } from "./schema";

interface SnapshotRow {
  id: string;
  execution_id: string;
  workflow_id: string;
  sequence: string; // BIGINT → string
  state: unknown; // JSONB → parsed object (NULL on an ADR 0140 codec row)
  state_z?: Buffer | null; // BYTEA codec frame (ADR 0140); absent until a store provisions the column
  created_at: string; // BIGINT → string
}

function rowToSnapshot(row: SnapshotRow): Snapshot {
  // Reads dispatch on the row's own format: a codec frame when `state_z` holds one, else JSONB. Whatever
  // the store is configured to WRITE, it reads both, forever; nothing is rewritten.
  const state =
    row.state_z !== undefined && row.state_z !== null
      ? decodeState(row.state_z)
      : (row.state as ExecutionState | null);
  if (state === null || state === undefined) {
    throw new Error(`snapshot ${row.id} has neither state nor state_z`);
  }
  return {
    id: row.id,
    executionId: row.execution_id,
    workflowId: row.workflow_id,
    sequence: Number(row.sequence),
    state,
    createdAt: Number(row.created_at),
  };
}

export interface PostgresSnapshotStoreOptions {
  /**
   * ADR 0140 - how NEW snapshots are written. `"none"` (default): JSONB, exactly as before and the
   * schema is untouched. `"zstd"`: a codec frame (format byte + zstd-3 JSON) in `snapshots.state_z
   * BYTEA`, provisioned at boot by `ensureSnapshotZstd` (opt-in, fail soft: if the column cannot be
   * added, one warning and this store keeps writing JSONB). Reads accept BOTH formats whatever this is.
   * Throws at construction on a Node without zstd (>= 22.15).
   */
  codec?: SnapshotCodecName;
  /** Lock wait for provisioning `state_z` (see `MigrateOptions.lockTimeoutMs`). */
  migrationLockTimeoutMs?: number;
  /** Receives the one provisioning warning. Default `console.warn`. */
  onWarn?: (message: string) => void;
}

/** Postgres-backed {@link SnapshotStore}. Same contract as the SQLite store. */
export class PostgresSnapshotStore implements SnapshotStore {
  private readonly pool: PoolLike;
  private readonly ownsPool: boolean;
  private readonly ready: Promise<void>;
  /** ADR 0140 - the codec REQUESTED for new snapshots (structural; `ProfilingSnapshotStore` reads it). */
  readonly snapshotCodec: SnapshotCodecName;
  // True once `state_z` is provisioned and a codec was requested; until then (or on a soft failure) JSONB.
  private writeFrames = false;
  // Whether `snapshots.state_z` exists (another node may have opted in). A JSONB re-save must then clear it.
  private hasFrameColumn = false;

  constructor(config: PgConfig, options: PostgresSnapshotStoreOptions = {}) {
    this.snapshotCodec = parseSnapshotCodec(options.codec);
    assertSnapshotCodecAvailable(this.snapshotCodec);
    const { pool, owned } = toPool(config);
    this.pool = pool;
    this.ownsPool = owned;
    this.ready = migrate(this.pool).then(async () => {
      if (this.snapshotCodec === "zstd") {
        this.writeFrames = await ensureSnapshotZstd(this.pool, {
          ...(options.migrationLockTimeoutMs !== undefined && {
            lockTimeoutMs: options.migrationLockTimeoutMs,
          }),
          ...(options.onWarn !== undefined && { onWarn: options.onWarn }),
        });
        this.hasFrameColumn = this.writeFrames;
      } else {
        // One lock-free catalog read, so a store that does not write frames still never leaves a stale
        // frame behind when it re-saves (by id) a snapshot an opted-in node wrote as one.
        const { rows } = await this.pool.query(
          "SELECT 1 FROM pg_attribute WHERE attrelid = 'snapshots'::regclass AND attname = 'state_z' AND NOT attisdropped"
        );
        this.hasFrameColumn = rows.length > 0;
      }
    });
  }

  async save(snapshot: Snapshot): Promise<void> {
    await this.ready;
    if (this.writeFrames) {
      // Exactly one of state / state_z is non-NULL (a CHECK enforces it); an upsert over a JSONB row flips it.
      await this.pool.query(
        `INSERT INTO snapshots (id, execution_id, workflow_id, sequence, state, state_z, created_at)
         VALUES ($1, $2, $3, $4, NULL, $5::bytea, $6)
         ON CONFLICT (id) DO UPDATE SET
           execution_id = EXCLUDED.execution_id,
           workflow_id = EXCLUDED.workflow_id,
           sequence = EXCLUDED.sequence,
           state = NULL,
           state_z = EXCLUDED.state_z,
           created_at = EXCLUDED.created_at`,
        [
          snapshot.id,
          snapshot.executionId,
          snapshot.workflowId,
          snapshot.sequence,
          encodeState(snapshot.state, this.snapshotCodec),
          snapshot.createdAt,
        ]
      );
      return;
    }
    // Upsert by id (a re-saved checkpoint replaces the prior one).
    await this.pool.query(
      `INSERT INTO snapshots (id, execution_id, workflow_id, sequence, state, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (id) DO UPDATE SET
         execution_id = EXCLUDED.execution_id,
         workflow_id = EXCLUDED.workflow_id,
         sequence = EXCLUDED.sequence,
         state = EXCLUDED.state,${this.hasFrameColumn ? "\n         state_z = NULL," : ""}
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
