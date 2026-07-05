-- Loom Postgres backend — reference schema.
-- Mirrors the SQLite schema (packages/event-runtime/src/schema.ts) 1:1.

CREATE TABLE IF NOT EXISTS events (
  id            TEXT NOT NULL,
  workflow_id   TEXT NOT NULL,
  execution_id  TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  sequence      BIGINT NOT NULL,
  timestamp     BIGINT NOT NULL,
  payload       JSONB NOT NULL,
  metadata      JSONB,
  PRIMARY KEY (id),
  UNIQUE (execution_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_events_exec ON events (execution_id, sequence ASC);

CREATE TABLE IF NOT EXISTS snapshots (
  id            TEXT PRIMARY KEY,
  execution_id  TEXT NOT NULL,
  workflow_id   TEXT NOT NULL,
  sequence      BIGINT NOT NULL,
  state         JSONB NOT NULL,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_exec ON snapshots (execution_id, sequence DESC);
