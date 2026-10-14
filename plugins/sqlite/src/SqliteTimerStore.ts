import type { TimerRecord, TimerStore } from "@loom/event-runtime";
import Database from "better-sqlite3";

interface TimerRow {
  execution_id: string;
  wake_at: number;
  redrive: string | null;
  refused: string | null;
}

/**
 * SQLite-backed {@link TimerStore} (T1.3). Point it at the same DB file as the
 * SqliteEventStore so a single backup captures events + timers — the full
 * kernel state. Own idempotent migration, same pattern as SqliteBranchRegistry.
 */
export class SqliteTimerStore implements TimerStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS timers (
          execution_id TEXT NOT NULL,
          wake_at INTEGER NOT NULL,
          PRIMARY KEY (execution_id, wake_at)
        );
        CREATE INDEX IF NOT EXISTS idx_timers_wake ON timers (wake_at ASC);
      `);
      // ADR 0118 D4 — `CREATE TABLE IF NOT EXISTS` never adds a column to a table an older version
      // created, so the re-drive column is added by a guarded ALTER: only when `table_info` lacks it
      // (SQLite has no `ADD COLUMN IF NOT EXISTS`, and a second ALTER would throw). The check and
      // the ALTER run under ONE write lock (`BEGIN IMMEDIATE`): two processes opening the same
      // file at once would otherwise both see the column missing and the loser's ALTER would throw
      // `duplicate column name`, failing its boot. The error is also tolerated (belt and braces: a
      // peer on a SQLite build whose locking differs still ends with the column present).
      this.db
        .transaction(() => {
          const columns = this.db.pragma("table_info(timers)") as { name: string }[];
          // `redrive` (ADR 0118 D4) and `refused` (ADR 0130 D10), both nullable TEXT (JSON).
          for (const column of ["redrive", "refused"]) {
            if (columns.some((c) => c.name === column)) continue;
            try {
              this.db.exec(`ALTER TABLE timers ADD COLUMN ${column} TEXT`);
            } catch (err) {
              if (!/duplicate column name/i.test(String((err as Error).message))) throw err;
            }
          }
        })
        .immediate();
      // ADR 0130 D10 - a PARTIAL index over the (rare) refusal rows only: a scan for them
      // (`due` with refusal rows wanted) never walks the plain timers, and a plain row pays nothing.
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_timers_refused ON timers (wake_at ASC) WHERE refused IS NOT NULL"
      );
    } catch (err) {
      this.db.close(); // don't leak the file handle if setup fails on a bad/locked file
      throw err;
    }
  }

  async schedule(timer: TimerRecord): Promise<void> {
    this.db
      .prepare<[string, number, string | null, string | null]>(
        // Upsert (ADR 0118 D4, ADR 0130 D10): a flagged row is never downgraded, a plain one gains
        // the flag, and a same-key `refused` upsert keeps the MAX head / MAX holds (never last-writer-wins).
        `INSERT INTO timers (execution_id, wake_at, redrive, refused) VALUES (?, ?, ?, ?)
         ON CONFLICT (execution_id, wake_at)
         DO UPDATE SET redrive = COALESCE(excluded.redrive, timers.redrive),
                       refused = CASE
                         WHEN excluded.refused IS NULL THEN timers.refused
                         WHEN timers.refused IS NULL THEN excluded.refused
                         WHEN json_extract(excluded.refused, '$.holds') IS NULL
                          AND json_extract(timers.refused, '$.holds') IS NULL
                         THEN json_object('head', max(json_extract(excluded.refused, '$.head'),
                                                      json_extract(timers.refused, '$.head')))
                         ELSE json_object('head', max(json_extract(excluded.refused, '$.head'),
                                                      json_extract(timers.refused, '$.head')),
                                          'holds', max(COALESCE(json_extract(excluded.refused, '$.holds'), 0),
                                                       COALESCE(json_extract(timers.refused, '$.holds'), 0)))
                       END`
      )
      .run(
        timer.executionId,
        timer.wakeAt,
        timer.redrive !== undefined ? JSON.stringify(timer.redrive) : null,
        timer.refused !== undefined ? JSON.stringify(timer.refused) : null
      );
  }

  async due(
    now: number,
    limit = 100,
    options?: { redrive?: boolean; inbox?: boolean; refused?: boolean }
  ): Promise<TimerRecord[]> {
    const rows = this.db
      .prepare<[number, number]>(
        `SELECT execution_id, wake_at, redrive, refused FROM timers WHERE wake_at <= ?${
          options?.redrive === false ? " AND redrive IS NULL" : ""
        }${options?.refused === false ? " AND refused IS NULL" : ""}${options?.inbox === false ? " AND (wake_at <> -1 OR redrive IS NOT NULL)" : ""} ORDER BY wake_at ASC LIMIT ?`
      )
      .all(now, limit) as TimerRow[];
    return rows.map((r) => ({
      executionId: r.execution_id,
      wakeAt: r.wake_at,
      ...(r.redrive !== null && { redrive: JSON.parse(r.redrive) as { attempt: number } }),
      ...(r.refused !== null && {
        refused: JSON.parse(r.refused) as { head: number; holds?: number },
      }),
    }));
  }

  async complete(executionId: string, wakeAt: number): Promise<void> {
    this.db
      .prepare<[string, number]>("DELETE FROM timers WHERE execution_id = ? AND wake_at = ?")
      .run(executionId, wakeAt);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
