import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteLeaseStore } from "./SqliteLeaseStore";
import { sqliteStorage } from "./preset";

// ADR 0130 D11: the factory exposes the lease store NEXT TO the event store ("co-located"): same
// database file, so the lease and the log share one failure domain. Accessor only: defineConfig
// wiring is a later slice, so `kind`/`eventStore`/`snapshotStore` are unchanged.
describe("sqliteStorage exposes a co-located lease store", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("returns leaseStore beside eventStore, backed by the events database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-s7a-"));
    dirs.push(dir);
    const storage = sqliteStorage({ dir });
    try {
      expect(storage.kind).toBe("custom");
      expect(storage.leaseStore).toBeInstanceOf(SqliteLeaseStore);
      expect(await storage.leaseStore.acquire("x", "node-a", 1000, 0)).not.toBeNull();
      // A second handle on the events database sees the same row.
      const other = new SqliteLeaseStore(join(dir, "events.db"));
      expect(await other.acquire("x", "node-b", 1000, 100)).toBeNull();
      await other.close();
    } finally {
      await storage.leaseStore.close();
      await storage.eventStore.close?.();
      await storage.snapshotStore.close?.();
    }
  });
});
