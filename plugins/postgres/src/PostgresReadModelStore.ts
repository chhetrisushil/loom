import type {
  FoldedApply,
  FoldedApplyResult,
  FoldedRecord,
  FoldedSelector,
  ReadModelPage,
  ReadModelQuery,
  ReadModelRow,
  ReadModelScalar,
  ReadModelStore,
} from "@loom/plugin-read-model";
import {
  assertManyKeys,
  assertPurgeFilter,
  clampQueryLimit,
  foldedSelectorColumn,
  parseQueryCursor,
} from "@loom/plugin-read-model";
import {
  type FoldedNames,
  type FoldedTableOptions,
  ensureFoldedTables,
  foldedNames,
} from "./foldedState";
import { type PgConfig, type PoolLike, toPool } from "./pool";
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

/** Placement for the FOLDED tables only (ADR 0132 D10); row-model tables are unaffected. */
export interface PostgresReadModelStoreOptions extends FoldedTableOptions {
  /**
   * Default true. `false` skips ALL DDL (the shared migrate() and the folded tables), so a
   * role that cannot run DDL works; the app creates the tables from `foldedStateDdl(...)`.
   */
  manageSchema?: boolean;
}

interface FoldedDbRow {
  execution_id: string;
  app_key: string | null;
  scope: string | null;
  sequence: string; // BIGINT → string from node-postgres
  state: unknown;
  erased: boolean;
}

function toFolded(r: FoldedDbRow): FoldedRecord {
  return {
    executionId: r.execution_id,
    key: r.app_key,
    scope: r.scope,
    sequence: Number(r.sequence),
    state: r.state,
    erased: r.erased,
  };
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
  private readonly pool: PoolLike;
  private readonly ownsPool: boolean;
  private readonly ready: Promise<void>;
  private readonly names: FoldedNames;
  private readonly manageSchema: boolean;
  private foldedReady: Promise<void> | undefined;

  constructor(config: PgConfig, options: PostgresReadModelStoreOptions = {}) {
    const { manageSchema = true, ...placement } = options;
    this.names = foldedNames(placement); // validates identifiers up front
    this.manageSchema = manageSchema;
    const { pool, owned } = toPool(config);
    this.pool = pool;
    this.ownsPool = owned;
    this.ready = manageSchema ? migrate(this.pool) : Promise.resolve();
  }

  /** Create the folded tables once (no-op with `manageSchema: false`). Used by the folded methods. */
  protected async ensureFolded(): Promise<void> {
    await this.ready;
    if (!this.manageSchema) return;
    this.foldedReady ??= ensureFoldedTables(this.pool, this.names).catch((err) => {
      this.foldedReady = undefined;
      throw err;
    });
    await this.foldedReady;
  }

  async apply(
    modelId: string,
    executionId: string,
    upToSequence: number,
    rows: readonly ReadModelRow[]
  ): Promise<void> {
    await this.ready;
    // Audit fix (DS&A rank 3): batched multi-VALUES inserts — one round-trip
    // per chunk instead of one per row. Idempotence (ON CONFLICT DO NOTHING)
    // makes the batch exactly as safe as the loop it replaces.
    const BATCH = 500; // 500 × 8 params = 4000, well under the 65535 cap
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const values = chunk
        .map((_, j) => {
          const b = j * 8;
          return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::jsonb, $${b + 8}::jsonb)`;
        })
        .join(", ");
      const params = chunk.flatMap((row) => [
        modelId,
        row.rowId,
        row.executionId,
        row.sequence,
        row.timestamp,
        row.kind,
        JSON.stringify(row.fields),
        JSON.stringify(row.value ?? null),
      ]);
      await this.pool.query(
        `INSERT INTO read_model_rows
           (model_id, row_id, execution_id, sequence, timestamp, kind, fields, value)
         VALUES ${values}
         ON CONFLICT (model_id, row_id) DO NOTHING`,
        params
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
    const limit = clampQueryLimit(q.limit);
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
      const [ts, seq, rowId] = parseQueryCursor(q.cursor);
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

  async purge(modelId: string, where: Record<string, ReadModelScalar>): Promise<number> {
    assertPurgeFilter(where);
    await this.ready;
    // `fields @> $2::jsonb` is the same GIN-indexed containment the query path uses, so a
    // purge deletes exactly what the equivalent query would have returned. Watermarks are
    // deliberately untouched (SPI contract): clearing one would make the next catch-up
    // re-derive the rows just erased.
    const { rowCount } = await this.pool.query(
      "DELETE FROM read_model_rows WHERE model_id = $1 AND fields @> $2::jsonb",
      [modelId, JSON.stringify(where)]
    );
    return rowCount ?? 0;
  }

  async clear(modelId: string): Promise<void> {
    await this.ready;
    await this.pool.query("DELETE FROM read_model_rows WHERE model_id = $1", [modelId]);
    await this.pool.query("DELETE FROM read_model_watermarks WHERE model_id = $1", [modelId]);
    // Folded tables: drop this model's rows only if they exist; never create them (F8, D10).
    // Header first, both deletes in one transaction: applyFolded takes FOR SHARE on the header row.
    const probe = await this.pool.query("SELECT to_regclass($1) AS s, to_regclass($2) AS f", [
      this.names.state,
      this.names.folds,
    ]);
    const { s, f } = probe.rows[0] ?? {};
    if (!s && !f) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (f) await client.query(`DELETE FROM ${this.names.folds} WHERE model_id = $1`, [modelId]);
      if (s) await client.query(`DELETE FROM ${this.names.state} WHERE model_id = $1`, [modelId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Folded state (ADR 0132 D3, D5, D6, D12) ──────────────────────────────

  async beginFold(modelId: string, foldVersion: string): Promise<{ rebuilt: boolean }> {
    await this.ensureFolded();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // One insert-or-lock statement: the row is locked FOR UPDATE-equivalent either way, so a
      // concurrent clear cannot leave us "rebuilding" a header that no longer exists. xmax = 0 means
      // we inserted it (nothing to rebuild); otherwise RETURNING shows the stored version.
      const { rows } = await client.query<{ version: string; inserted: boolean }>(
        `INSERT INTO ${this.names.folds} (model_id, version) VALUES ($1, $2)
         ON CONFLICT (model_id) DO UPDATE SET model_id = EXCLUDED.model_id
         RETURNING version, (xmax = 0) AS inserted`,
        [modelId, foldVersion]
      );
      const rebuilt = rows[0]?.inserted !== true && rows[0]?.version !== foldVersion;
      if (rebuilt) {
        await client.query(`DELETE FROM ${this.names.state} WHERE model_id = $1`, [modelId]);
        await client.query(`UPDATE ${this.names.folds} SET version = $2 WHERE model_id = $1`, [
          modelId,
          foldVersion,
        ]);
      }
      await client.query("COMMIT");
      return { rebuilt };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async applyFolded(a: FoldedApply): Promise<FoldedApplyResult> {
    await this.ensureFolded();
    const T = this.names.state;
    const H = this.names.folds;
    // One atomic statement: header match + monotonic CAS + classification (ADR 0132 D3/D5). The
    // header is read in the same statement (FOR SHARE) so a beginFold committing in between can
    // never turn a version mismatch into "stale".
    const res = await this.pool.query<{ hv: string | null; hit: boolean; e: boolean | null }>(
      `WITH h AS (SELECT version FROM ${H} WHERE model_id = $1::text FOR SHARE),
       ins AS (
         INSERT INTO ${T} (model_id, execution_id, app_key, scope, sequence, state, erased)
         SELECT $1::text, $2::text, $3::text, $4::text, $5::bigint, $6::jsonb, false
         WHERE EXISTS (SELECT 1 FROM h WHERE h.version = $7::text)
         ON CONFLICT (model_id, execution_id) DO UPDATE
            SET sequence = EXCLUDED.sequence,
                state    = CASE WHEN ${T}.erased THEN NULL ELSE EXCLUDED.state END,
                app_key  = COALESCE(EXCLUDED.app_key, ${T}.app_key),
                scope    = COALESCE(EXCLUDED.scope, ${T}.scope)
          WHERE ${T}.sequence < EXCLUDED.sequence
         RETURNING sequence, erased)
       SELECT (SELECT version FROM h) AS hv, EXISTS (SELECT 1 FROM ins) AS hit,
              (SELECT erased FROM ins) AS e`,
      [
        a.modelId,
        a.executionId,
        a.key ?? null,
        a.scope ?? null,
        a.upToSequence,
        a.state === null || a.state === undefined ? null : JSON.stringify(a.state),
        a.foldVersion,
      ]
    );
    const r = res.rows[0];
    if (r?.hit) return r.e ? "applied-erased" : "applied";
    return r?.hv === a.foldVersion ? "stale" : "version-mismatch";
  }

  async getFolded(modelId: string, executionIds: readonly string[]): Promise<FoldedRecord[]> {
    assertManyKeys(executionIds, "getFolded");
    await this.ensureFolded();
    const ids = [...new Set(executionIds)];
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query<FoldedDbRow>(
      `SELECT execution_id, app_key, scope, sequence, state, erased FROM ${this.names.state}
       WHERE model_id = $1 AND execution_id = ANY($2::text[])`,
      [modelId, ids]
    );
    const byId = new Map(rows.map((r) => [r.execution_id, toFolded(r)]));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      return r === undefined ? [] : [r];
    });
  }

  async getFoldedByKey(modelId: string, keys: readonly string[]): Promise<FoldedRecord[]> {
    assertManyKeys(keys, "getFoldedByKey");
    await this.ensureFolded();
    const uniq = [...new Set(keys)];
    if (uniq.length === 0) return [];
    // execution_id is COLLATE "C" in the DDL: byte order = code-point order (ADR 0132).
    const { rows } = await this.pool.query<FoldedDbRow>(
      `SELECT execution_id, app_key, scope, sequence, state, erased FROM ${this.names.state}
       WHERE model_id = $1 AND app_key = ANY($2::text[]) ORDER BY execution_id COLLATE "C"`,
      [modelId, uniq]
    );
    return rows.map(toFolded);
  }

  async purgeFolded(modelId: string, selector: FoldedSelector): Promise<number> {
    await this.ensureFolded();
    // `col` is one of three literals from foldedSelectorColumn, never caller input.
    const [col, val] = foldedSelectorColumn(selector);
    // Tombstone, never delete: the row IS the watermark (ADR 0132 D12).
    const { rowCount } = await this.pool.query(
      `UPDATE ${this.names.state} SET state = NULL, erased = true
       WHERE model_id = $1 AND ${col} = $2 AND NOT erased`,
      [modelId, val]
    );
    return rowCount ?? 0;
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
