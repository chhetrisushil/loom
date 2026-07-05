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

    -- Branch registry: git-style movable pointers (refs) into the event-log
    -- topology. A ref names an execution head; promote() repoints a ref onto a
    -- winning execution ("pick-a-winner"). No merge — see BranchRegistry.
    CREATE TABLE IF NOT EXISTS refs (
      name TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      tip INTEGER NOT NULL,
      parent_execution_id TEXT,
      fork_sequence INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Immutable fork DAG: each forked execution records its parent and the
    -- sequence it forked at. One row per child execution.
    CREATE TABLE IF NOT EXISTS lineage (
      execution_id TEXT PRIMARY KEY,
      parent_execution_id TEXT NOT NULL,
      fork_sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_lineage_parent
      ON lineage (parent_execution_id);
  `);
}
