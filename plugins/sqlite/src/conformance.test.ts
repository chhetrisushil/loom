import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runBranchRegistryConformance,
  runContentStoreConformance,
  runDurableStateStoreConformance,
  runEventStoreConformance,
  runFoldedStateConformance,
  runLeaseStoreConformance,
  runMemoryStoreConformance,
  runReadModelStoreConformance,
  runSnapshotStoreConformance,
  runTimerStoreConformance,
} from "@loom/conformance";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteBranchRegistry } from "./SqliteBranchRegistry";
import { SqliteContentStore } from "./SqliteContentStore";
import { SqliteDurableStateStore } from "./SqliteDurableStateStore";
import { SqliteEventStore } from "./SqliteEventStore";
import { SqliteLeaseStore } from "./SqliteLeaseStore";
import { SqliteMemoryStore } from "./SqliteMemoryStore";
import { SqliteReadModelStore } from "./SqliteReadModelStore";
import { SqliteSnapshotStore } from "./SqliteSnapshotStore";
import { SqliteTimerStore } from "./SqliteTimerStore";

// Dogfood the published conformance kits against the real SQLite backend — the same
// suite a third-party store runs to prove it conforms (ADR 0033). Fresh :memory: DB per case.
runEventStoreConformance(() => new SqliteEventStore(":memory:"), "SqliteEventStore");
runSnapshotStoreConformance(() => new SqliteSnapshotStore(":memory:"), "SqliteSnapshotStore");
runLeaseStoreConformance(() => new SqliteLeaseStore(":memory:"), "SqliteLeaseStore");
runBranchRegistryConformance(() => new SqliteBranchRegistry(":memory:"), "SqliteBranchRegistry");
runTimerStoreConformance(() => new SqliteTimerStore(":memory:"), "SqliteTimerStore");
runDurableStateStoreConformance(
  () => new SqliteDurableStateStore(":memory:"),
  "SqliteDurableStateStore"
);

runReadModelStoreConformance(() => new SqliteReadModelStore(":memory:"), "SqliteReadModelStore");
runFoldedStateConformance(() => new SqliteReadModelStore(":memory:"), "SqliteReadModelStore");
describe("SqliteReadModelStore folded", () => {
  it("implements the folded methods", async () => {
    const s = new SqliteReadModelStore(":memory:");
    expect(typeof s.applyFolded).toBe("function");
    await s.close();
  });

  const withDir = async (fn: (file: string) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "loom-rm-"));
    try {
      await fn(join(dir, "rm.db"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const ap = (executionId: string, upToSequence: number) => ({
    modelId: "m",
    executionId,
    upToSequence,
    state: { n: upToSequence },
    key: "k",
    scope: null,
    foldVersion: "v1",
  });

  it("tombstones and the version header survive reopening the file", async () => {
    await withDir(async (file) => {
      const a = new SqliteReadModelStore(file);
      await a.beginFold("m", "v1");
      await a.applyFolded(ap("x-1", 3));
      await a.purgeFolded("m", { executionId: "x-1" });
      await a.close();
      const b = new SqliteReadModelStore(file);
      expect(await b.beginFold("m", "v1")).toEqual({ rebuilt: false });
      expect((await b.getFolded("m", ["x-1"]))[0]).toMatchObject({
        state: null,
        erased: true,
        sequence: 3,
      });
      expect(await b.applyFolded(ap("x-1", 4))).toBe("applied-erased");
      expect(await b.applyFolded({ ...ap("x-2", 1), foldVersion: "v0" })).toBe("version-mismatch");
      await b.close();
    });
  });

  it("adds the folded tables to a database that only has the older tables", async () => {
    await withDir(async (file) => {
      const old = new Database(file);
      old.exec(`CREATE TABLE read_model_rows (
        model_id TEXT NOT NULL, row_id TEXT NOT NULL, execution_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, timestamp INTEGER NOT NULL, kind TEXT NOT NULL,
        fields TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (model_id, row_id));
        CREATE TABLE read_model_watermarks (
        model_id TEXT NOT NULL, execution_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        PRIMARY KEY (model_id, execution_id));`);
      old.close();
      const s = new SqliteReadModelStore(file);
      await s.beginFold("m", "v1");
      expect(await s.applyFolded(ap("x-1", 1))).toBe("applied");
      expect(await s.getFoldedByKey("m", ["k"])).toHaveLength(1);
      await s.clear("m");
      expect(await s.getFolded("m", ["x-1"])).toEqual([]);
      await s.close();
    });
  });
});
runContentStoreConformance(() => new SqliteContentStore(":memory:"), "SqliteContentStore", {
  clocked: (now) => new SqliteContentStore(":memory:", { now }),
});
runMemoryStoreConformance(() => new SqliteMemoryStore(":memory:"), "SqliteMemoryStore");
