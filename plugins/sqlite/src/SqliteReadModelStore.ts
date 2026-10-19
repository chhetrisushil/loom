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
  assertFoldedSelector,
  assertManyKeys,
  assertPurgeFilter,
  clampQueryLimit,
  foldedSelectorColumn,
  parseQueryCursor,
} from "@loom/plugin-read-model";
import Database from "better-sqlite3";

interface RowRecord {
  row_id: string;
  execution_id: string;
  sequence: number;
  timestamp: number;
  kind: string;
  fields: string;
  value: string;
}

interface FoldedDbRow {
  execution_id: string;
  app_key: string | null;
  scope: string | null;
  sequence: number;
  state: string | null;
  erased: number;
}

function toFolded(r: FoldedDbRow): FoldedRecord {
  return {
    executionId: r.execution_id,
    key: r.app_key,
    scope: r.scope,
    sequence: r.sequence,
    state: r.state === null ? null : JSON.parse(r.state),
    erased: r.erased === 1,
  };
}

/**
 * SQLite-backed {@link ReadModelStore} (RM, issue #183). Point it at the same
 * DB file as the SqliteEventStore so one backup captures log + read models.
 * Own idempotent migration, same pattern as SqliteDurableStateStore. Field
 * equality queries use `json_extract` over the JSON `fields` column; keyset
 * pagination uses row-value comparison over (timestamp, sequence, row_id).
 */
export class SqliteReadModelStore implements ReadModelStore {
  private readonly db: Database.Database;
  // Audit fix (DS&A rank 2): statements are prepared ONCE — apply-heavy
  // catch-ups no longer re-parse identical SQL per call.
  private readonly insertRowStmt: Database.Statement;
  private readonly upsertMarkStmt: Database.Statement;
  private readonly watermarkStmt: Database.Statement;
  private readonly watermarkedStmt: Database.Statement;
  private readonly clearRowsStmt: Database.Statement;
  private readonly clearMarksStmt: Database.Statement;
  private readonly foldHeaderStmt: Database.Statement;
  private readonly upsertFoldHeaderStmt: Database.Statement;
  private readonly dropFoldStatesStmt: Database.Statement;
  private readonly dropFoldHeaderStmt: Database.Statement;
  private readonly applyFoldedStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS read_model_rows (
          model_id TEXT NOT NULL,
          row_id TEXT NOT NULL,
          execution_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          kind TEXT NOT NULL,
          fields TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (model_id, row_id)
        );
        CREATE INDEX IF NOT EXISTS idx_rm_rows_order
          ON read_model_rows (model_id, kind, timestamp, sequence);
        CREATE TABLE IF NOT EXISTS read_model_watermarks (
          model_id TEXT NOT NULL,
          execution_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          PRIMARY KEY (model_id, execution_id)
        );
        CREATE TABLE IF NOT EXISTS read_model_folds (
          model_id TEXT PRIMARY KEY,
          version TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS read_model_state (
          model_id TEXT NOT NULL,
          execution_id TEXT NOT NULL,
          app_key TEXT,
          scope TEXT,
          sequence INTEGER NOT NULL,
          state TEXT,
          erased INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (model_id, execution_id)
        );
        CREATE INDEX IF NOT EXISTS idx_rm_state_key
          ON read_model_state (model_id, app_key) WHERE app_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_rm_state_scope
          ON read_model_state (model_id, scope) WHERE scope IS NOT NULL;
      `);
      this.insertRowStmt = this.db.prepare(
        `INSERT OR IGNORE INTO read_model_rows
           (model_id, row_id, execution_id, sequence, timestamp, kind, fields, value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      this.upsertMarkStmt = this.db.prepare(
        `INSERT INTO read_model_watermarks (model_id, execution_id, sequence)
         VALUES (?, ?, ?)
         ON CONFLICT (model_id, execution_id)
         DO UPDATE SET sequence = MAX(sequence, excluded.sequence)`
      );
      this.watermarkStmt = this.db.prepare(
        "SELECT sequence FROM read_model_watermarks WHERE model_id = ? AND execution_id = ?"
      );
      this.watermarkedStmt = this.db.prepare(
        "SELECT execution_id FROM read_model_watermarks WHERE model_id = ?"
      );
      this.clearRowsStmt = this.db.prepare("DELETE FROM read_model_rows WHERE model_id = ?");
      this.clearMarksStmt = this.db.prepare("DELETE FROM read_model_watermarks WHERE model_id = ?");
      this.foldHeaderStmt = this.db.prepare(
        "SELECT version FROM read_model_folds WHERE model_id = ?"
      );
      this.upsertFoldHeaderStmt = this.db.prepare(
        `INSERT INTO read_model_folds (model_id, version) VALUES (?, ?)
         ON CONFLICT (model_id) DO UPDATE SET version = excluded.version`
      );
      this.dropFoldStatesStmt = this.db.prepare("DELETE FROM read_model_state WHERE model_id = ?");
      this.dropFoldHeaderStmt = this.db.prepare("DELETE FROM read_model_folds WHERE model_id = ?");
      // One statement: header check + monotonic CAS. RETURNING reports the (unchanged)
      // erased flag so advancing a tombstone is "applied-erased" and keeps state NULL.
      this.applyFoldedStmt = this.db.prepare(
        `INSERT INTO read_model_state
           (model_id, execution_id, app_key, scope, sequence, state, erased)
         SELECT ?, ?, ?, ?, ?, ?, 0
         WHERE EXISTS (SELECT 1 FROM read_model_folds WHERE model_id = ? AND version = ?)
         ON CONFLICT (model_id, execution_id) DO UPDATE
           SET sequence = excluded.sequence,
               state = CASE WHEN read_model_state.erased = 1 THEN NULL ELSE excluded.state END,
               app_key = COALESCE(excluded.app_key, read_model_state.app_key),
               scope = COALESCE(excluded.scope, read_model_state.scope)
           WHERE read_model_state.sequence < excluded.sequence
         RETURNING erased`
      );
    } catch (err) {
      this.db.close(); // don't leak the file handle if setup fails on a bad/locked file
      throw err;
    }
  }

  async apply(
    modelId: string,
    executionId: string,
    upToSequence: number,
    rows: readonly ReadModelRow[]
  ): Promise<void> {
    this.db.transaction(() => {
      for (const row of rows) {
        this.insertRowStmt.run(
          modelId,
          row.rowId,
          row.executionId,
          row.sequence,
          row.timestamp,
          row.kind,
          JSON.stringify(row.fields),
          JSON.stringify(row.value ?? null)
        );
      }
      this.upsertMarkStmt.run(modelId, executionId, upToSequence);
    })();
  }

  async watermark(modelId: string, executionId: string): Promise<number | null> {
    const row = this.watermarkStmt.get(modelId, executionId) as { sequence: number } | undefined;
    return row?.sequence ?? null;
  }

  async watermarkedExecutions(modelId: string): Promise<string[]> {
    const rows = this.watermarkedStmt.all(modelId) as { execution_id: string }[];
    return rows.map((r) => r.execution_id);
  }

  async query(modelId: string, q: ReadModelQuery = {}): Promise<ReadModelPage> {
    const desc = q.order === "desc";
    const limit = clampQueryLimit(q.limit);
    const clauses = ["model_id = ?"];
    const params: unknown[] = [modelId];
    if (q.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(q.kind);
    }
    for (const [field, value] of Object.entries(q.where ?? {})) {
      const path = `$."${field.split('"').join('""')}"`;
      if (value === null) {
        clauses.push("json_extract(fields, ?) IS NULL");
        params.push(path);
      } else {
        clauses.push("json_extract(fields, ?) = ?");
        params.push(path, typeof value === "boolean" ? (value ? 1 : 0) : value);
      }
    }
    if (q.cursor !== undefined) {
      const [ts, seq, rowId] = parseQueryCursor(q.cursor);
      clauses.push(`(timestamp, sequence, row_id) ${desc ? "<" : ">"} (?, ?, ?)`);
      params.push(ts, seq, rowId);
    }
    const dir = desc ? "DESC" : "ASC";
    const records = this.db
      .prepare(
        `SELECT row_id, execution_id, sequence, timestamp, kind, fields, value
         FROM read_model_rows WHERE ${clauses.join(" AND ")}
         ORDER BY timestamp ${dir}, sequence ${dir}, row_id ${dir}
         LIMIT ?`
      )
      .all(...params, limit + 1) as RowRecord[];

    const page = records.slice(0, limit).map(
      (r): ReadModelRow => ({
        rowId: r.row_id,
        executionId: r.execution_id,
        sequence: r.sequence,
        timestamp: r.timestamp,
        kind: r.kind,
        fields: JSON.parse(r.fields),
        value: JSON.parse(r.value),
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
    // Same `json_extract` equality the query path uses, so a purge deletes exactly the
    // rows the equivalent query would have returned. Not prepared once: the clause shape
    // varies with the filter's field set, and an erasure is a lifecycle call, not a hot path.
    const clauses = ["model_id = ?"];
    const params: unknown[] = [modelId];
    for (const [field, value] of Object.entries(where)) {
      const path = `$."${field.split('"').join('""')}"`;
      if (value === null) {
        clauses.push("json_extract(fields, ?) IS NULL");
        params.push(path);
      } else {
        clauses.push("json_extract(fields, ?) = ?");
        params.push(path, typeof value === "boolean" ? (value ? 1 : 0) : value);
      }
    }
    // Watermarks are deliberately left alone (SPI contract) — deleting one would make the
    // next catch-up re-derive the rows just erased.
    const info = this.db
      .prepare(`DELETE FROM read_model_rows WHERE ${clauses.join(" AND ")}`)
      .run(...params);
    return info.changes;
  }

  async clear(modelId: string): Promise<void> {
    this.db.transaction(() => {
      this.clearRowsStmt.run(modelId);
      this.clearMarksStmt.run(modelId);
      // Folded state (ADR 0132): this model only. Tables are created with the others in
      // the constructor, so clear never has to create anything.
      this.dropFoldStatesStmt.run(modelId);
      this.dropFoldHeaderStmt.run(modelId);
    })();
  }

  // ── Folded state (ADR 0132 D3, D5, D6, D12) ──────────────────────────────

  async beginFold(modelId: string, foldVersion: string): Promise<{ rebuilt: boolean }> {
    // IMMEDIATE: read-then-write must take the write lock up front, or a second process
    // in WAL mode fails with SQLITE_BUSY_SNAPSHOT when upgrading a stale read snapshot.
    return this.db
      .transaction(() => {
        const prior = this.foldHeaderStmt.get(modelId) as { version: string } | undefined;
        this.upsertFoldHeaderStmt.run(modelId, foldVersion);
        if (prior === undefined || prior.version === foldVersion) return { rebuilt: false };
        this.dropFoldStatesStmt.run(modelId);
        return { rebuilt: true };
      })
      .immediate();
  }

  async applyFolded(a: FoldedApply): Promise<FoldedApplyResult> {
    // IMMEDIATE for the same reason: the miss path reads the header after the write attempt.
    return this.db
      .transaction((): FoldedApplyResult => {
        const hit = this.applyFoldedStmt.get(
          a.modelId,
          a.executionId,
          a.key ?? null,
          a.scope ?? null,
          a.upToSequence,
          a.state === null || a.state === undefined ? null : JSON.stringify(a.state),
          a.modelId,
          a.foldVersion
        ) as { erased: number } | undefined;
        if (hit !== undefined) return hit.erased === 1 ? "applied-erased" : "applied";
        const hdr = this.foldHeaderStmt.get(a.modelId) as { version: string } | undefined;
        return hdr?.version === a.foldVersion ? "stale" : "version-mismatch";
      })
      .immediate();
  }

  async getFolded(modelId: string, executionIds: readonly string[]): Promise<FoldedRecord[]> {
    assertManyKeys(executionIds, "getFolded");
    const ids = [...new Set(executionIds)];
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT execution_id, app_key, scope, sequence, state, erased FROM read_model_state
         WHERE model_id = ? AND execution_id IN (${ids.map(() => "?").join(",")})`
      )
      .all(modelId, ...ids) as FoldedDbRow[];
    const byId = new Map(rows.map((r) => [r.execution_id, toFolded(r)]));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      return r === undefined ? [] : [r];
    });
  }

  async getFoldedByKey(modelId: string, keys: readonly string[]): Promise<FoldedRecord[]> {
    assertManyKeys(keys, "getFoldedByKey");
    const uniq = [...new Set(keys)];
    if (uniq.length === 0) return [];
    // BINARY collation = memcmp over UTF-8 = code-point order (ADR 0132), explicit so a
    // future column collation can never change it.
    const rows = this.db
      .prepare(
        `SELECT execution_id, app_key, scope, sequence, state, erased FROM read_model_state
         WHERE model_id = ? AND app_key IN (${uniq.map(() => "?").join(",")})
         ORDER BY execution_id COLLATE BINARY`
      )
      .all(modelId, ...uniq) as FoldedDbRow[];
    return rows.map(toFolded);
  }

  async purgeFolded(modelId: string, selector: FoldedSelector): Promise<number> {
    assertFoldedSelector(selector);
    const [col, val] = foldedSelectorColumn(selector);
    // Tombstone, never delete: the row IS the watermark (ADR 0132 D12). `col` is one of
    // three literals from foldedSelectorColumn, never caller input.
    return this.db
      .prepare(
        `UPDATE read_model_state SET state = NULL, erased = 1
         WHERE model_id = ? AND ${col} = ? AND erased = 0`
      )
      .run(modelId, val).changes;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
