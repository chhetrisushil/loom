import {
  SNAPSHOT_FRAME_SENTINEL,
  type Snapshot,
  SnapshotIdentityMismatchError,
  assertSnapshotIdentity,
} from "@loom/snapshot-runtime";
import type { SnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { SealGuardedSnapshotStore, SealedStreamUnreadableError } from "./sealGuard";

// ADR 0140 D5 - what a node that PREDATES the zstd snapshot codec does with a frame row. Postgres keeps
// `state` NOT NULL and writes SNAPSHOT_FRAME_SENTINEL there, so the old reader hands the sentinel up as
// the state. It must fail loudly, never read as "no state" or an empty fold.
describe("an old node reading a zstd frame row's sentinel (ADR 0140 D5)", () => {
  const row: Snapshot = {
    id: "a",
    executionId: "x",
    workflowId: "wf",
    sequence: 1,
    state: { ...SNAPSHOT_FRAME_SENTINEL } as never,
    createdAt: 1,
  };
  const oldStore = {
    loadLatest: async () => row,
    loadAt: async () => row,
    loadLatestBefore: async () => row,
    save: async () => {},
    close: async () => {},
  } as unknown as SnapshotStore;

  it("the runtime's seal guard refuses it as an unopened sealed checkpoint", async () => {
    const guarded = new SealGuardedSnapshotStore(oldStore, async () => {});
    await expect(guarded.loadLatest("x")).rejects.toBeInstanceOf(SealedStreamUnreadableError);
    await expect(guarded.loadAt("x", 1)).rejects.toBeInstanceOf(SealedStreamUnreadableError);
    await expect(guarded.loadLatestBefore("x", 1)).rejects.toBeInstanceOf(
      SealedStreamUnreadableError
    );
  });

  it("a fold seeded from it trips the identity check (the sentinel names no execution)", () => {
    expect(() => assertSnapshotIdentity(row.state as never, "x", "wf")).toThrow(
      SnapshotIdentityMismatchError
    );
  });
});
