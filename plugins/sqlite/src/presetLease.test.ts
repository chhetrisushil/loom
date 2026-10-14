import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteStorage } from "./preset";

const made = vi.hoisted(() => ({ opened: 0, closed: 0 }));
vi.mock("./SqliteLeaseStore", async (orig) => {
  const m = await orig<typeof import("./SqliteLeaseStore")>();
  class Counting extends m.SqliteLeaseStore {
    constructor(path: string) {
      super(path);
      made.opened++;
    }
    override async close(): Promise<void> {
      made.closed++;
      return super.close();
    }
  }
  return { ...m, SqliteLeaseStore: Counting };
});

// P3-6 (S7a review): the lease store is a LAZY accessor (no second events.db connection + migrate
// for a caller that never reads it) and closing the storage closes it with the event store.
describe("sqliteStorage lease store lifecycle", () => {
  const dirs: string[] = [];
  afterEach(() => {
    made.opened = 0;
    made.closed = 0;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const open = () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-s7a-lazy-"));
    dirs.push(dir);
    return sqliteStorage({ dir });
  };

  it("opens no second connection until leaseStore is accessed (and only once)", async () => {
    const storage = open();
    expect(made.opened).toBe(0);
    const a = storage.leaseStore;
    const b = storage.leaseStore;
    expect(a).toBe(b);
    expect(made.opened).toBe(1);
    await storage.eventStore.close?.();
    await storage.snapshotStore.close?.();
  });

  it("closing the storage closes an accessed lease store", async () => {
    const storage = open();
    await storage.leaseStore.acquire("x", "n", 1000, 0);
    await storage.eventStore.close?.();
    await storage.snapshotStore.close?.();
    expect(made.closed).toBe(1);
  });

  it("closing the storage with the lease store never accessed opens and closes nothing", async () => {
    const storage = open();
    await storage.eventStore.close?.();
    await storage.snapshotStore.close?.();
    expect(made).toEqual({ opened: 0, closed: 0 });
  });
});
