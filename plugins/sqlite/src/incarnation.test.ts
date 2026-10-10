import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@loom/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "./SqliteEventStore";

// ADR 0129 — the incarnation lives on the sequence-0 row, assigned by a trigger from a counter
// that survives deletes. A database created before the column existed keeps the legacy anchor.
const evt = (executionId: string, sequence: number, timestamp = 1_000): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "wf",
  executionId,
  eventType: "EXECUTION_STARTED",
  sequence,
  timestamp,
  payload: {},
});

describe("SqliteEventStore incarnation (ADR 0129)", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-inc-"));
    path = join(dir, "t.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("an OLD database (no column) keeps the legacy anchor; new executions get incarnations; reopening is idempotent", async () => {
    const old = new Database(path);
    old.exec(`CREATE TABLE events (
      id TEXT NOT NULL, workflow_id TEXT NOT NULL, execution_id TEXT NOT NULL,
      event_type TEXT NOT NULL, sequence INTEGER NOT NULL, timestamp INTEGER NOT NULL,
      payload TEXT NOT NULL, metadata TEXT, PRIMARY KEY (id), UNIQUE (execution_id, sequence));
      INSERT INTO events VALUES ('old-0','wf','old','EXECUTION_STARTED',0,7,'{}',NULL);`);
    old.close();

    for (let i = 0; i < 2; i++) {
      const s = new SqliteEventStore(path);
      await s.close();
    }
    const store = new SqliteEventStore(path);
    try {
      const legacy = await store.appendIfUnchanged!("old", null);
      expect(legacy).toMatchObject({ reason: "observed", head: 0, anchor: "7:old-0" });
      await store.append(evt("fresh", 0));
      const a = (await store.appendIfUnchanged!("fresh", null)) as { anchor: string };
      expect(a.anchor).not.toContain(":");
      await store.deleteExecution!("fresh");
      await store.append(evt("fresh", 0));
      const b = (await store.appendIfUnchanged!("fresh", null)) as { anchor: string };
      expect(Number(b.anchor)).toBeGreaterThan(Number(a.anchor));
      // the counter never reuses a value even when the highest-numbered log was deleted
      await store.deleteExecution!("fresh");
      await store.append(evt("other", 0));
      const c = (await store.appendIfUnchanged!("other", null)) as { anchor: string };
      expect(Number(c.anchor)).toBeGreaterThan(Number(b.anchor));
    } finally {
      await store.close();
    }
  });
});
