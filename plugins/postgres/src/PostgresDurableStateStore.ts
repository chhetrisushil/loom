import type { DurableStateRecord, DurableStateStore } from "@loom/plugin-durable-state";
import { RevisionConflictError } from "@loom/plugin-durable-state";
import { type PgConfig, type PoolLike, toPool } from "./pool";
import { migrate } from "./schema";

interface DurableStateRow {
  contract_version: string; // BIGINT → string from node-postgres
  revision: string;
  payload: unknown; // JSONB → parsed value
}

/**
 * Postgres-backed {@link DurableStateStore} (ADR 0051 D2) — the multi-node
 * backend. Carry state lives in the same database as the event log (one backup
 * = full kernel state). CAS rides single-statement atomicity: the guarded
 * INSERT (`ON CONFLICT DO NOTHING`) / UPDATE (`WHERE revision = expected`)
 * either lands the new revision or affects zero rows, and the zero-row outcome
 * reports the actual revision in a loud RevisionConflictError — safe across
 * nodes without explicit locking.
 */
export class PostgresDurableStateStore implements DurableStateStore {
  private readonly pool: PoolLike;
  private readonly ownsPool: boolean;
  private readonly ready: Promise<void>;

  constructor(config: PgConfig) {
    const { pool, owned } = toPool(config);
    this.pool = pool;
    this.ownsPool = owned;
    this.ready = migrate(this.pool);
  }

  async load(key: string): Promise<DurableStateRecord | null> {
    await this.ready;
    const { rows } = await this.pool.query<DurableStateRow>(
      "SELECT contract_version, revision, payload FROM durable_state WHERE key = $1",
      [key]
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      contractVersion: Number(row.contract_version),
      revision: Number(row.revision),
      payload: row.payload,
    };
  }

  async save(
    key: string,
    value: { contractVersion: number; payload: unknown },
    expectedRevision: number
  ): Promise<DurableStateRecord> {
    await this.ready;
    // Explicit stringify: the pg driver mis-serializes top-level JS arrays as
    // Postgres arrays; a JSON string through ::jsonb is unambiguous.
    const payload = JSON.stringify(value.payload);
    const result =
      expectedRevision === 0
        ? await this.pool.query(
            "INSERT INTO durable_state (key, contract_version, revision, payload) VALUES ($1, $2, 1, $3::jsonb) ON CONFLICT (key) DO NOTHING",
            [key, value.contractVersion, payload]
          )
        : await this.pool.query(
            "UPDATE durable_state SET contract_version = $2, revision = $3, payload = $4::jsonb WHERE key = $1 AND revision = $5",
            [key, value.contractVersion, expectedRevision + 1, payload, expectedRevision]
          );
    if (result.rowCount === 1) {
      return {
        contractVersion: value.contractVersion,
        revision: expectedRevision + 1,
        payload: value.payload,
      };
    }
    const { rows } = await this.pool.query<{ revision: string }>(
      "SELECT revision FROM durable_state WHERE key = $1",
      [key]
    );
    throw new RevisionConflictError(
      key,
      expectedRevision,
      rows[0] === undefined ? 0 : Number(rows[0].revision)
    );
  }

  async clear(key: string): Promise<void> {
    await this.ready;
    await this.pool.query("DELETE FROM durable_state WHERE key = $1", [key]);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
