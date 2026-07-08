import { describe, expect, it } from "vitest";
import { InMemoryAsyncSnapshotStore } from "./InMemoryAsyncSnapshotStore";
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

describe("InMemoryAsyncSnapshotStore", () => {
  it("loadLatest returns the greatest-sequence snapshot regardless of save order", async () => {
    const store = new InMemoryAsyncSnapshotStore();
    await store.save(snap(5, "a"));
    await store.save(snap(2, "b")); // out of order
    await store.save(snap(9, "c"));
    await store.save(snap(6, "d"));
    expect((await store.loadLatest("x"))?.id).toBe("9-c");
    expect(await store.loadLatest("missing")).toBeNull();
  });

  it("loadLatestBefore returns the rightmost snapshot with sequence <= target", async () => {
    const store = new InMemoryAsyncSnapshotStore();
    for (const s of [0, 2, 5, 6, 9]) await store.save(snap(s, "x"));
    expect((await store.loadLatestBefore("x", 6))?.sequence).toBe(6);
    expect((await store.loadLatestBefore("x", 4))?.sequence).toBe(2); // gap → nearest below
    expect((await store.loadLatestBefore("x", 100))?.sequence).toBe(9);
    expect(await store.loadLatestBefore("x", -1)).toBeNull();
  });

  it("breaks ties by last-inserted for latest, first-inserted for loadAt", async () => {
    const store = new InMemoryAsyncSnapshotStore();
    await store.save(snap(5, "first"));
    await store.save(snap(5, "second"));
    // latest / latest-before pick the last-inserted among equal sequences...
    expect((await store.loadLatest("x"))?.id).toBe("5-second");
    expect((await store.loadLatestBefore("x", 5))?.id).toBe("5-second");
    // ...loadAt returns the first match (old `find` semantics).
    expect((await store.loadAt("x", 5))?.id).toBe("5-first");
    expect(await store.loadAt("x", 7)).toBeNull();
  });
});
