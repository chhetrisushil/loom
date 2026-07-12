import type { Pool } from "pg";

// One idempotent migration for all Loom store tables, mirroring the SQLite schema
// (packages/event-runtime/src/schema.ts + snapshot-runtime). JSONB for payload /
// metadata / state; BIGINT for sequence / timestamps (parsed back to JS numbers in
// the row mappers, since node-postgres returns int8 as a string). Any of the three
// stores can bootstrap the full schema, so they compose on one database.
export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT NOT NULL PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      sequence BIGINT NOT NULL,
      timestamp BIGINT NOT NULL,
      payload JSONB NOT NULL,
      metadata JSONB,
      UNIQUE (execution_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_events_exec ON events (execution_id, sequence ASC);

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT NOT NULL PRIMARY KEY,
      execution_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      sequence BIGINT NOT NULL,
      state JSONB NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_exec ON snapshots (execution_id, sequence DESC);

    CREATE TABLE IF NOT EXISTS refs (
      name TEXT NOT NULL PRIMARY KEY,
      execution_id TEXT NOT NULL,
      tip BIGINT NOT NULL,
      parent_execution_id TEXT,
      fork_sequence BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lineage (
      execution_id TEXT NOT NULL PRIMARY KEY,
      parent_execution_id TEXT NOT NULL,
      fork_sequence BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lineage_parent ON lineage (parent_execution_id);

    -- K9.4 fencing: the current monotonic fence token per execution. A row exists
    -- only once a dispatcher/worker acquires a fence; executions that never fence
    -- pay nothing. Appends carrying a stale/missing token are rejected in append().
    CREATE TABLE IF NOT EXISTS fences (
      execution_id TEXT NOT NULL PRIMARY KEY,
      fence BIGINT NOT NULL
    );

    -- T1 durable timers: pending wakes for suspended executions, in the same
    -- database as the event log so one backup captures the full kernel state.
    CREATE TABLE IF NOT EXISTS timers (
      execution_id TEXT NOT NULL,
      wake_at BIGINT NOT NULL,
      PRIMARY KEY (execution_id, wake_at)
    );
    CREATE INDEX IF NOT EXISTS idx_timers_wake ON timers (wake_at ASC);
  `);
}

// The channel every EventStore instance LISTENs on for cross-node subscribe.
export const NOTIFY_CHANNEL = "loom_events";
