import type {
  ReadModelPage,
  ReadModelQuery,
  ReadModelRow,
  ReadModelStore,
} from "@loom/plugin-read-model";
import type { Pool } from "pg";
import { type PgConfig, toPool } from "./pool";
import { migrate } from "./schema";

interface RowRecord {
  row_id: string;
  execution_id: string;
  sequence: string; // BIGINT → string from node-postgres
  timestamp: string;
  kind: string;
  fields: Record<string, unknown>;
  value: unknown;
}

/**
 * Postgres-backed {@link ReadModelStore} (RM, issue #183) — the multi-node
 * backend. Read models live in the same database as the event log (one backup
 * = full kernel state); `apply` is idempotent (`ON CONFLICT DO NOTHING`) and
 * watermarks advance with `GREATEST`, so concurrent nodes ingesting the same
 * events converge without locks. Field queries use JSONB containment (`@>`)
 * over a GIN index; keyset pagination uses row-value comparison.
 */
export class PostgresReadModelStore implements ReadModelStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly ready: Promise<void>;

  constructor(config: PgConfig) {
    const { pool, owned } = toPool(config);
    this.pool = pool;
    this.ownsPool = owned;
    this.ready = migrate(this.pool);
  }

  async apply(
    modelId: string,
    executionId: string,
    upToSequence: number,
    rows: readonly ReadModelRow[]
  ): Promise<void> {
    await this.ready;
    for (const row of rows) {
      await this.pool.query(
        `INSERT INTO read_model_rows
           (model_id, row_id, execution_id, sequence, timestamp, kind, fields, value)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
         ON CONFLICT (model_id, row_id) DO NOTHING`,
        [
          modelId,
          row.rowId,
          row.executionId,
          row.sequence,
          row.timestamp,
          row.kind,
          JSON.stringify(row.fields),
          JSON.stringify(row.value ?? null),
        ]
      );
    }
    await this.pool.query(
      `INSERT INTO read_model_watermarks (model_id, execution_id, sequence)
       VALUES ($1, $2, $3)
       ON CONFLICT (model_id, execution_id)
       DO UPDATE SET sequence = GREATEST(read_model_watermarks.sequence, EXCLUDED.sequence)`,
      [modelId, executionId, upToSequence]
    );
  }

  async watermark(modelId: string, executionId: string): Promise<number | null> {
    await this.ready;
    const { rows } = await this.pool.query<{ sequence: string }>(
      "SELECT sequence FROM read_model_watermarks WHERE model_id = $1 AND execution_id = $2",
      [modelId, executionId]
    );
    return rows[0] === undefined ? null : Number(rows[0].sequence);
  }

  async watermarkedExecutions(modelId: string): Promise<string[]> {
    await this.ready;
    const { rows } = await this.pool.query<{ execution_id: string }>(
      "SELECT execution_id FROM read_model_watermarks WHERE model_id = $1",
      [modelId]
    );
    return rows.map((r) => r.execution_id);
  }

  async query(modelId: string, q: ReadModelQuery = {}): Promise<ReadModelPage> {
    await this.ready;
    const desc = q.order === "desc";
    const limit = q.limit ?? 100;
    const clauses = ["model_id = $1"];
    const params: unknown[] = [modelId];
    if (q.kind !== undefined) {
      params.push(q.kind);
      clauses.push(`kind = $${params.length}`);
    }
    if (q.where !== undefined && Object.keys(q.where).length > 0) {
      params.push(JSON.stringify(q.where));
      clauses.push(`fields @> $${params.length}::jsonb`); // exact scalar containment, GIN-indexed
    }
    if (q.cursor !== undefined) {
      const [ts, seq, rowId] = JSON.parse(q.cursor) as [number, number, string];
      params.push(ts, seq, rowId);
      clauses.push(
        `(timestamp, sequence, row_id) ${desc ? "<" : ">"} ($${params.length - 2}, $${params.length - 1}, $${params.length})`
      );
    }
    const dir = desc ? "DESC" : "ASC";
    params.push(limit + 1);
    const { rows: records } = await this.pool.query<RowRecord>(
      `SELECT row_id, execution_id, sequence, timestamp, kind, fields, value
       FROM read_model_rows WHERE ${clauses.join(" AND ")}
       ORDER BY timestamp ${dir}, sequence ${dir}, row_id ${dir}
       LIMIT $${params.length}`,
      params
    );

    const page = records.slice(0, limit).map(
      (r): ReadModelRow => ({
        rowId: r.row_id,
        executionId: r.execution_id,
        sequence: Number(r.sequence),
        timestamp: Number(r.timestamp),
        kind: r.kind,
        fields: r.fields as ReadModelRow["fields"],
        value: r.value,
      })
    );
    const last = page[page.length - 1];
    return {
      rows: page,
      ...(records.length > limit &&
        last !== undefined && {
          nextCursor: JSON.stringify([last.timestamp, last.sequence, last.rowId]),
        }),
    };
  }

  async clear(modelId: string): Promise<void> {
    await this.ready;
    await this.pool.query("DELETE FROM read_model_rows WHERE model_id = $1", [modelId]);
    await this.pool.query("DELETE FROM read_model_watermarks WHERE model_id = $1", [modelId]);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
