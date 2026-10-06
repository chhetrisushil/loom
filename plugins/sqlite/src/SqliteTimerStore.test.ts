import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteTimerStore } from "./SqliteTimerStore";

// ADR 0118 D4 — `CREATE TABLE IF NOT EXISTS` never adds a column to a table an older version
// created, so the re-drive column is added by an ALTER guarded by `pragma table_info`.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loom-timer-mig-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SqliteTimerStore migration (ADR 0118 D4)", () => {
  it("an OLD-shape timers table gains `redrive`, keeps its rows, and accepts a re-drive row", async () => {
    const path = join(dir, "loom.db");
    const old = new Database(path);
    old.exec(`CREATE TABLE timers (
      execution_id TEXT NOT NULL, wake_at INTEGER NOT NULL, PRIMARY KEY (execution_id, wake_at))`);
    old.prepare("INSERT INTO timers (execution_id, wake_at) VALUES ('old', 50)").run();
    old.close();

    const store = new SqliteTimerStore(path);
    await store.schedule({ executionId: "new", wakeAt: 60, redrive: { attempt: 1 } });
    expect(await store.due(100)).toEqual([
      { executionId: "old", wakeAt: 50 },
      { executionId: "new", wakeAt: 60, redrive: { attempt: 1 } },
    ]);
    // the upsert on the PRE-EXISTING plain row gains the flag, and is never downgraded
    await store.schedule({ executionId: "old", wakeAt: 50, redrive: { attempt: 4 } });
    await store.schedule({ executionId: "old", wakeAt: 50 });
    expect((await store.due(100))[0]).toEqual({
      executionId: "old",
      wakeAt: 50,
      redrive: { attempt: 4 },
    });
    await store.close();
  });

  it("re-opening a migrated database does not re-run the ALTER (it would throw)", async () => {
    const path = join(dir, "loom.db");
    await new SqliteTimerStore(path).close();
    const again = new SqliteTimerStore(path);
    await again.schedule({ executionId: "x", wakeAt: 1, redrive: { attempt: 0 } });
    expect(await again.due(10)).toEqual([{ executionId: "x", wakeAt: 1, redrive: { attempt: 0 } }]);
    await again.close();
  });
});
