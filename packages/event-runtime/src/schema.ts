import type Database from "better-sqlite3";

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      payload TEXT NOT NULL,
      metadata TEXT,
      PRIMARY KEY (id),
      UNIQUE (execution_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_events_exec
      ON events (execution_id, sequence ASC);

    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}
