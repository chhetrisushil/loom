import type {
  ReadModelPage,
  ReadModelQuery,
  ReadModelRow,
  ReadModelStore,
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

/**
 * SQLite-backed {@link ReadModelStore} (RM, issue #183). Point it at the same
 * DB file as the SqliteEventStore so one backup captures log + read models.
 * Own idempotent migration, same pattern as SqliteDurableStateStore. Field
 * equality queries use `json_extract` over the JSON `fields` column; keyset
 * pagination uses row-value comparison over (timestamp, sequence, row_id).
 */
export class SqliteReadModelStore implements ReadModelStore {
  private readonly db: Database.Database;

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
    const insertRow = this.db.prepare(
      `INSERT OR IGNORE INTO read_model_rows
         (model_id, row_id, execution_id, sequence, timestamp, kind, fields, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const upsertMark = this.db.prepare(
      `INSERT INTO read_model_watermarks (model_id, execution_id, sequence)
       VALUES (?, ?, ?)
       ON CONFLICT (model_id, execution_id)
       DO UPDATE SET sequence = MAX(sequence, excluded.sequence)`
    );
    this.db.transaction(() => {
      for (const row of rows) {
        insertRow.run(
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
      upsertMark.run(modelId, executionId, upToSequence);
    })();
  }

  async watermark(modelId: string, executionId: string): Promise<number | null> {
    const row = this.db
      .prepare("SELECT sequence FROM read_model_watermarks WHERE model_id = ? AND execution_id = ?")
      .get(modelId, executionId) as { sequence: number } | undefined;
    return row?.sequence ?? null;
  }

  async watermarkedExecutions(modelId: string): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT execution_id FROM read_model_watermarks WHERE model_id = ?")
      .all(modelId) as { execution_id: string }[];
    return rows.map((r) => r.execution_id);
  }

  async query(modelId: string, q: ReadModelQuery = {}): Promise<ReadModelPage> {
    const desc = q.order === "desc";
    const limit = q.limit ?? 100;
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
      const [ts, seq, rowId] = JSON.parse(q.cursor) as [number, number, string];
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

  async clear(modelId: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM read_model_rows WHERE model_id = ?").run(modelId);
      this.db.prepare("DELETE FROM read_model_watermarks WHERE model_id = ?").run(modelId);
    })();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
