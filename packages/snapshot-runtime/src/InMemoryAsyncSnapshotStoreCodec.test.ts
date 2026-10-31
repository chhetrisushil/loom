import { describe, expect, it } from "vitest";
import { InMemoryAsyncSnapshotStore } from "./InMemoryAsyncSnapshotStore";
import { zstdAvailable } from "./snapshotCodec";
import type { Snapshot } from "./types";

function snap(sequence: number, tag: string): Snapshot {
  return {
    id: `${sequence}-${tag}`,
    executionId: "x",
    workflowId: "wf",
    sequence,
    state: { executionId: "x", workflowId: "wf", workflowVersion: "1" } as Snapshot["state"],
    createdAt: sequence,
  };
}

describe("InMemoryAsyncSnapshotStore codec (ADR 0141)", () => {
  it("default is today's behaviour: the very object saved comes back", async () => {
    const store = new InMemoryAsyncSnapshotStore();
    const s = snap(1, "a");
    await store.save(s);
    expect(await store.loadLatest("x")).toBe(s);
    expect(store.snapshotCodec).toBe("none");
  });

  it("rejects a codec name it does not know", () => {
    expect(() => new InMemoryAsyncSnapshotStore({ codec: "lz4" as never })).toThrow(TypeError);
  });

  describe.skipIf(!zstdAvailable())("zstd", () => {
    it("round-trips every read path as an independent, deep-equal copy", async () => {
      const store = new InMemoryAsyncSnapshotStore({ codec: "zstd" });
      const a = snap(1, "a");
      const b = snap(3, "b");
      await store.save(a);
      await store.save(b);
      const latest = await store.loadLatest("x");
      expect(latest).toEqual(b);
      expect(latest).not.toBe(b);
      expect(latest?.state).not.toBe(b.state);
      expect(await store.loadAt("x", 1)).toEqual(a);
      expect(await store.loadLatestBefore("x", 2)).toEqual(a);
      expect(await store.loadLatestSealed("x")).toEqual(b);
      expect(await store.loadAt("x", 2)).toBeNull();
      // a later mutation of the saved object cannot reach what is stored
      (b.state as unknown as { workflowId: string }).workflowId = "mutated";
      expect((await store.loadLatest("x"))?.state.workflowId).toBe("wf");
    });

    it("prune and the last-insertion tie-break behave as without a codec", async () => {
      const store = new InMemoryAsyncSnapshotStore({ codec: "zstd" });
      await store.save(snap(5, "first"));
      await store.save(snap(5, "second"));
      expect((await store.loadLatest("x"))?.id).toBe("5-second");
      await store.save(snap(9, "n"));
      expect(await store.pruneSnapshots("x", { after: 0, before: 9 })).toBe(2);
      expect((await store.loadLatest("x"))?.sequence).toBe(9);
    });
  });
});
