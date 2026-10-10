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
    -- #380 — durable ownership of a RUNNING execution; the primary key IS the exclusion.
    CREATE TABLE IF NOT EXISTS leases (
      execution_id TEXT NOT NULL PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leases_expiry ON leases (expires_at ASC);

    CREATE TABLE IF NOT EXISTS lineage (
      execution_id TEXT PRIMARY KEY,
      parent_execution_id TEXT NOT NULL,
      fork_sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_lineage_parent
      ON lineage (parent_execution_id);
  `);
  migrateIncarnation(db);
}

/**
 * ADR 0129 — the store-assigned incarnation of an execution, kept in STORE METADATA only (never
 * in an envelope, so replay stays byte-identical). It lives on the sequence-0 row and is filled
 * by a trigger from a one-row counter, so EVERY way a sequence 0 can land (append, appendBatch,
 * copyPrefix, appendIfUnchanged, another process) assigns one. The counter is never reset, so a
 * deleted-and-recreated id always gets a larger value. Logs created before this column existed
 * keep NULL (no backfill): their anchor stays the legacy `timestamp:id`. All steps are
 * idempotent and tolerate two processes migrating at once.
 */
function migrateIncarnation(db: Database.Database): void {
  const columns = db.prepare<[], { name: string }>("PRAGMA table_info(events)").all();
  if (!columns.some((c) => c.name === "incarnation")) {
    try {
      db.exec("ALTER TABLE events ADD COLUMN incarnation INTEGER");
    } catch (err) {
      // A concurrent migrator added it between our check and our ALTER.
      if (!/duplicate column name/i.test(String((err as Error).message))) throw err;
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS incarnation_counter (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      n INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO incarnation_counter (id, n) VALUES (1, 0);
    CREATE TRIGGER IF NOT EXISTS trg_events_incarnation
    AFTER INSERT ON events
    WHEN NEW.sequence = 0
    BEGIN
      UPDATE incarnation_counter SET n = n + 1 WHERE id = 1;
      UPDATE events SET incarnation = (SELECT n FROM incarnation_counter WHERE id = 1)
        WHERE id = NEW.id;
    END;
  `);
}
