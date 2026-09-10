import type {
  ReadModelPage,
  ReadModelQuery,
  ReadModelRow,
  ReadModelScalar,
  ReadModelStore,
} from "@loom/plugin-read-model";
import { assertPurgeFilter, clampQueryLimit, parseQueryCursor } from "@loom/plugin-read-model";
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
    })();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
