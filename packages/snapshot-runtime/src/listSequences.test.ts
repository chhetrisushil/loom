import type { ExecutionState } from "@loomwork/core";
import { describe, expect, it } from "vitest";
import { InMemoryAsyncSnapshotStore } from "./InMemoryAsyncSnapshotStore";
import { ProfilingSnapshotStore } from "./ProfilingSnapshotStore";
import { TenantScopedSnapshotStore } from "./TenantScopedSnapshotStore";
import { SNAPSHOT_STORE_SPI_VERSION, type Snapshot, type SnapshotStore } from "./types";

// ADR 0134 amendment (2026-11-02) - the optional `SnapshotStore.listSequences` (SPI 1.3.0).

const snap = (executionId: string, sequence: number, id?: string): Snapshot => ({
  id: id ?? `${executionId}-${sequence}`,
  executionId,
  workflowId: "wf",
  sequence,
  state: { executionId, workflowId: "wf" } as unknown as ExecutionState,
  createdAt: 1000 + sequence,
});

/** A store written against SPI 1.2.0: no `listSequences`. */
function withoutList(inner: SnapshotStore): SnapshotStore {
  return {
    save: (s) => inner.save(s),
    loadLatest: (i) => inner.loadLatest(i),
    loadAt: (i, s) => inner.loadAt(i, s),
    loadLatestBefore: (i, s) => inner.loadLatestBefore(i, s),
    close: () => inner.close(),
  };
}

describe("listSequences (SPI 1.3.0)", () => {
  it("the version is 1.3.0", () => {
    expect(SNAPSHOT_STORE_SPI_VERSION).toBe("1.3.0");
  });

  it("in-memory: ascending, exclusive bounds, one entry per stored snapshot (shared sequences repeat)", async () => {
    const store = new InMemoryAsyncSnapshotStore();
    for (const s of [4, 1, 3, 0]) await store.save(snap("a", s));
    await store.save(snap("a", 3, "a-3-suspend")); // a second snapshot at sequence 3
    await store.save(snap("b", 2));
    expect(await store.listSequences("a")).toEqual([0, 1, 3, 3, 4]);
    expect(await store.listSequences("a", { after: 0, before: 4 })).toEqual([1, 3, 3]);
    expect(await store.listSequences("a", { after: 3 })).toEqual([4]);
    expect(await store.listSequences("a", { before: 1 })).toEqual([0]);
    expect(await store.listSequences("a", { after: 3, before: 3 })).toEqual([]);
    expect(await store.listSequences("a", { after: 4, before: 0 })).toEqual([]);
    expect(await store.listSequences("nope")).toEqual([]);
    // The length is exactly what a keep-less prune of the same range deletes.
    const range = { after: 0, before: 4 };
    const n = (await store.listSequences("a", range)).length;
    expect(await store.pruneSnapshots("a", range)).toBe(n);
    expect(await store.listSequences("a")).toEqual([0, 4]);
  });

  describe("decorators forward only when the inner store has it", () => {
    it("TenantScopedSnapshotStore scopes the id: a tenant lists only its own sequences", async () => {
      const inner = new InMemoryAsyncSnapshotStore();
      const t1 = new TenantScopedSnapshotStore(inner, "t1");
      const t2 = new TenantScopedSnapshotStore(inner, "t2");
      for (const s of [0, 1, 2]) await t1.save(snap("e", s));
      for (const s of [7, 8]) await t2.save(snap("e", s));
      expect(await t1.listSequences!("e")).toEqual([0, 1, 2]);
      expect(await t2.listSequences!("e")).toEqual([7, 8]);
      expect(await t1.listSequences!("e", { after: 0 })).toEqual([1, 2]);
      // Neither reaches the other's, nor the raw, execution.
      expect(await t2.listSequences!("t1:e")).toEqual([]);
      expect(await inner.listSequences("e")).toEqual([]);
      expect(await inner.listSequences("t1:e")).toEqual([0, 1, 2]);
    });

    it("TenantScoped and Profiling leave it undefined over a store that lacks it", () => {
      const bare = withoutList(new InMemoryAsyncSnapshotStore());
      expect(new TenantScopedSnapshotStore(bare, "t1").listSequences).toBeUndefined();
      expect(new ProfilingSnapshotStore(bare).listSequences).toBeUndefined();
    });

    it("ProfilingSnapshotStore forwards it", async () => {
      const inner = new InMemoryAsyncSnapshotStore();
      const profiled = new ProfilingSnapshotStore(inner);
      for (const s of [2, 0, 1]) await profiled.save(snap("e", s));
      expect(await profiled.listSequences!("e")).toEqual([0, 1, 2]);
      expect(await profiled.listSequences!("e", { after: 0, before: 2 })).toEqual([1]);
    });
  });
});
