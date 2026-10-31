import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { type Snapshot, type SnapshotStore, zstdAvailable } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { defineConfig, normalizeConfig } from "./defineConfig";

// ADR 0140 - `durability.snapshots.codec`. Opt-in; the default wiring is unchanged.

class ReportingStore implements SnapshotStore {
  constructor(readonly snapshotCodec: string) {}
  async save(): Promise<void> {}
  async loadLatest(): Promise<Snapshot | null> {
    return null;
  }
  async loadAt(): Promise<Snapshot | null> {
    return null;
  }
  async loadLatestBefore(): Promise<Snapshot | null> {
    return null;
  }
  async close(): Promise<void> {}
}

const snap = (sequence: number): Snapshot => ({
  id: `s${sequence}`,
  executionId: "e",
  workflowId: "wf",
  sequence,
  state: { status: "running", frames: {}, big: "the same words ".repeat(300) } as never,
  createdAt: sequence,
});

describe("durability.snapshots (ADR 0140)", () => {
  it("is a durability group option, lifted to the flat shape", () => {
    const resolved = normalizeConfig({
      storage: { kind: "memory" },
      durability: { snapshots: { codec: "zstd" } },
    });
    expect((resolved as { snapshots?: unknown }).snapshots).toEqual({ codec: "zstd" });
  });

  it("default: the memory snapshot store writes no codec (unchanged)", async () => {
    const app = defineConfig({ storage: { kind: "memory" } });
    expect((app.stores.snapshotStore as { snapshotCodec?: string }).snapshotCodec).toBe("none");
    await app.close();
  });

  it("validates its shape and values at boot", () => {
    expect(() =>
      defineConfig({
        storage: { kind: "memory" },
        durability: { snapshots: { codec: "lz4" as never } },
      })
    ).toThrow(/snapshot codec must be "none" or "zstd"/);
    expect(() =>
      defineConfig({
        storage: { kind: "memory" },
        durability: { snapshots: { level: 9 } as never },
      })
    ).toThrow(/durability\.snapshots\.level is not an option/);
    expect(() =>
      defineConfig({ storage: { kind: "memory" }, durability: { snapshots: 3 as never } })
    ).toThrow(/must be an object/);
  });

  describe.skipIf(!zstdAvailable())("zstd", () => {
    it("applies to the memory snapshot store defineConfig builds", async () => {
      const app = defineConfig({
        storage: { kind: "memory" },
        durability: { snapshots: { codec: "zstd" } },
      });
      const store = app.stores.snapshotStore;
      expect((store as { snapshotCodec?: string }).snapshotCodec).toBe("zstd");
      await store.save(snap(1));
      expect((await store.loadLatest("e"))?.state).toEqual(snap(1).state);
      await app.close();
    });

    it("applies to the default sealed store for an encrypting custom event store (compress, then seal)", async () => {
      const events = Object.assign(new InMemoryAsyncEventStore(), {
        keys: {
          async getOrCreate() {
            return Buffer.alloc(32, 1);
          },
          async get() {
            return Buffer.alloc(32, 1);
          },
          async destroy() {},
        },
      });
      const app = defineConfig({
        storage: { kind: "custom", eventStore: events },
        durability: { snapshots: { codec: "zstd" } },
      });
      const store = app.stores.snapshotStore as SnapshotStore & {
        snapshotCodec?: string;
        sealsWholeState?: true;
      };
      expect(store.sealsWholeState).toBe(true);
      expect(store.snapshotCodec).toBe("zstd");
      await store.save(snap(1));
      expect((await store.loadLatest("e"))?.state).toEqual(snap(1).state);
      await app.close();
    });

    it("warns when an explicit snapshot store reports a different codec; says nothing when it agrees or is silent", async () => {
      const warnings: string[] = [];
      const build = (store: SnapshotStore) =>
        defineConfig({
          storage: {
            kind: "custom",
            eventStore: new InMemoryAsyncEventStore(),
            snapshotStore: store,
          },
          durability: { snapshots: { codec: "zstd" } },
          observability: { onWarn: (m: string) => void warnings.push(m) },
        });
      await build(new ReportingStore("none")).close();
      expect(warnings.join("\n")).toMatch(
        /durability\.snapshots\.codec is "zstd" but the snapshotStore/
      );
      warnings.length = 0;
      await build(new ReportingStore("zstd")).close();
      expect(warnings.join("\n")).not.toMatch(/durability\.snapshots\.codec/);
    });
  });
});
