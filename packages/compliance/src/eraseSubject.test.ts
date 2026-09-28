import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { foldEvents } from "@loom/replay-vm";
import { SnapshotIdentityMismatchError } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { SubjectIndex } from "./SubjectIndex";
import { EraseCoordinator } from "./eraseSubject";

const subjectOf = (e: EventEnvelope): string | undefined =>
  e.eventType === "EXECUTION_STARTED"
    ? (e.payload as { input?: { userId?: string } }).input?.userId
    : undefined;

function ev(
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
  };
}

async function seedStarted(store: InMemoryAsyncEventStore, executionId: string, userId: string) {
  await store.append(ev(executionId, 0, "EXECUTION_STARTED", { input: { userId } }));
}

describe("EraseCoordinator (T3 Phase B — erasure)", () => {
  it("shreds immediately when all of a subject's executions are terminal", async () => {
    const store = new InMemoryAsyncEventStore();
    await seedStarted(store, "x1", "ann");
    await store.append(ev("x1", 1, "EXECUTION_COMPLETED", {}));
    const index = SubjectIndex.fromEvents(await store.read("x1"), subjectOf);
    const shred = vi.fn(async () => {});

    const coord = new EraseCoordinator({ index, eventStore: store, shred });
    const result = await coord.eraseSubject("ann");

    expect(result.outcome).toBe("erased");
    expect(result.erased).toEqual(["x1"]);
    expect(shred).toHaveBeenCalledWith("ann", ["x1"]);
    expect(coord.pendingSubjects()).toEqual([]);
  });

  it("parks erasure while an execution is live, then auto-completes on termination (R4.5)", async () => {
    const store = new InMemoryAsyncEventStore();
    await seedStarted(store, "x1", "bob"); // live (no terminal event yet)
    const index = SubjectIndex.fromEvents(await store.read("x1"), subjectOf);
    const shred = vi.fn(async () => {});

    const coord = new EraseCoordinator({ index, eventStore: store, shred });
    const parked = await coord.eraseSubject("bob");

    // Deferred, not shredded — never shred a live fold.
    expect(parked.outcome).toBe("parked");
    expect(parked.pending).toEqual(["x1"]);
    expect(shred).not.toHaveBeenCalled();
    expect(coord.pendingSubjects()).toEqual(["bob"]);
    // The request was durably recorded on the control stream (survives restart).
    const control = await store.read("__loom_erasure__");
    expect(control.some((e) => e.eventType === "ERASURE_PENDING")).toBe(true);

    // The execution terminates → the parked erasure completes automatically.
    await store.append(ev("x1", 1, "EXECUTION_COMPLETED", {}));
    await coord.handleEvent(ev("x1", 1, "EXECUTION_COMPLETED", {}));
    expect(shred).toHaveBeenCalledWith("bob", ["x1"]);
    expect(coord.pendingSubjects()).toEqual([]);
  });

  it("waits for the LAST live execution before completing", async () => {
    const store = new InMemoryAsyncEventStore();
    await seedStarted(store, "x1", "cat");
    await seedStarted(store, "x2", "cat");
    await store.append(ev("x1", 1, "EXECUTION_COMPLETED", {})); // x1 terminal, x2 still live
    const index = SubjectIndex.fromEvents(
      [...(await store.read("x1")), ...(await store.read("x2"))],
      subjectOf
    );
    const shred = vi.fn(async () => {});
    const coord = new EraseCoordinator({ index, eventStore: store, shred });

    expect((await coord.eraseSubject("cat")).outcome).toBe("parked");

    // x1's terminal event does NOT complete — x2 is still live.
    await coord.handleEvent(ev("x1", 1, "EXECUTION_COMPLETED", {}));
    expect(shred).not.toHaveBeenCalled();

    // x2 terminates → now all terminal → complete.
    await store.append(ev("x2", 1, "EXECUTION_FAILED", {}));
    await coord.handleEvent(ev("x2", 1, "EXECUTION_FAILED", {}));
    expect(shred).toHaveBeenCalledOnce();
    expect(shred).toHaveBeenCalledWith("cat", ["x1", "x2"]);
  });

  it("returns unknown for a subject with no records", async () => {
    const store = new InMemoryAsyncEventStore();
    const coord = new EraseCoordinator({
      index: new SubjectIndex(subjectOf),
      eventStore: store,
      shred: vi.fn(async () => {}),
    });
    expect((await coord.eraseSubject("ghost")).outcome).toBe("unknown");
  });

  it("loadParked recovers the pending set from the control stream (restart)", async () => {
    const store = new InMemoryAsyncEventStore();
    await seedStarted(store, "x1", "dan");
    const index = SubjectIndex.fromEvents(await store.read("x1"), subjectOf);
    // First coordinator parks dan.
    await new EraseCoordinator({
      index,
      eventStore: store,
      shred: vi.fn(async () => {}),
    }).eraseSubject("dan");

    // A fresh coordinator (simulating restart) rebuilds the parked set from the log.
    const restarted = new EraseCoordinator({
      index,
      eventStore: store,
      shred: vi.fn(async () => {}),
    });
    expect(restarted.pendingSubjects()).toEqual([]);
    await restarted.loadParked();
    expect(restarted.pendingSubjects()).toEqual(["dan"]);
  });
});

describe("EraseCoordinator — compacted executions (ADR 0106)", () => {
  it("a compacted TERMINAL execution is not live: erasure completes instead of waiting forever", async () => {
    const store = new InMemoryAsyncEventStore();
    await seedStarted(store, "x1", "dan");
    await store.append(ev("x1", 1, "STEP_STARTED", { stepId: "s" }));
    await store.append(ev("x1", 2, "EXECUTION_COMPLETED", {}));
    const index = SubjectIndex.fromEvents(await store.read("x1"), subjectOf);
    // Compacted through its tip: the log is [0], the completion lives in the checkpoint —
    // written blank by a pre-0106 compaction, to prove identity is filled, not required.
    const checkpoint = foldEvents(await store.read("x1"));
    await store.truncatePrefix("x1", 2);
    const snapshotStore = {
      loadLatest: async (id: string) => (id === "x1" ? { sequence: 2, state: checkpoint } : null),
    };
    const shred = vi.fn(async () => {});
    const withoutSnapshots = new EraseCoordinator({ index, eventStore: store, shred });
    expect((await withoutSnapshots.eraseSubject("dan")).outcome).toBe("parked"); // the bug
    const coord = new EraseCoordinator({ index, eventStore: store, snapshotStore, shred });
    const result = await coord.eraseSubject("dan");
    expect(result.outcome).toBe("erased");
    expect(shred).toHaveBeenCalledWith("dan", ["x1"]);
  });
});

describe("EraseCoordinator — snapshot identity (ADR 0106)", () => {
  it("refuses a checkpoint whose NON-blank identity names another execution", async () => {
    const store = new InMemoryAsyncEventStore();
    await seedStarted(store, "x1", "eve");
    await store.append(ev("x1", 1, "EXECUTION_COMPLETED", {}));
    const index = SubjectIndex.fromEvents(await store.read("x1"), subjectOf);
    const foreign = { ...foldEvents(await store.read("x1")), executionId: "someone-else" };
    const snapshotStore = { loadLatest: async () => ({ sequence: 1, state: foreign }) };
    const shred = vi.fn(async () => {});
    const coord = new EraseCoordinator({ index, eventStore: store, snapshotStore, shred });
    await expect(coord.eraseSubject("eve")).rejects.toThrow(SnapshotIdentityMismatchError);
    expect(shred).not.toHaveBeenCalled();
  });
});

describe("EraseCoordinator — tenant isolation (T3-R2.4)", () => {
  const tenantOf = (e: EventEnvelope): string | undefined =>
    (e.payload as { input?: { tenant?: string } }).input?.tenant;

  it("erases one tenant's subject without touching another tenant's same-id subject", async () => {
    const store = new InMemoryAsyncEventStore();
    // Same subject id "alice" under two tenants, both terminal.
    await store.append(
      ev("a1", 0, "EXECUTION_STARTED", { input: { userId: "alice", tenant: "acme" } })
    );
    await store.append(ev("a1", 1, "EXECUTION_COMPLETED", {}));
    await store.append(
      ev("a2", 0, "EXECUTION_STARTED", { input: { userId: "alice", tenant: "globex" } })
    );
    await store.append(ev("a2", 1, "EXECUTION_COMPLETED", {}));
    const index = SubjectIndex.fromEvents(
      [...(await store.read("a1")), ...(await store.read("a2"))],
      subjectOf,
      { tenantOf }
    );
    const shred = vi.fn(async () => {});
    const coord = new EraseCoordinator({ index, eventStore: store, shred });

    const result = await coord.eraseSubject("alice", "acme");
    expect(result.outcome).toBe("erased");
    // Only acme's execution is shredded — globex's alice is untouched.
    expect(shred).toHaveBeenCalledTimes(1);
    expect(shred).toHaveBeenCalledWith("alice", ["a1"]);
  });

  it("parks per (tenant, subject) — same subject id in two tenants parks independently", async () => {
    const store = new InMemoryAsyncEventStore();
    await store.append(
      ev("a1", 0, "EXECUTION_STARTED", { input: { userId: "alice", tenant: "acme" } })
    ); // live
    await store.append(
      ev("a2", 0, "EXECUTION_STARTED", { input: { userId: "alice", tenant: "globex" } })
    ); // live
    const index = SubjectIndex.fromEvents(
      [...(await store.read("a1")), ...(await store.read("a2"))],
      subjectOf,
      { tenantOf }
    );
    const shred = vi.fn(async () => {});
    const coord = new EraseCoordinator({ index, eventStore: store, shred });

    expect((await coord.eraseSubject("alice", "acme")).outcome).toBe("parked");
    expect((await coord.eraseSubject("alice", "globex")).outcome).toBe("parked");

    // Completing acme's execution erases ONLY acme's alice; globex stays parked.
    await store.append(ev("a1", 1, "EXECUTION_COMPLETED", {}));
    await coord.handleEvent(ev("a1", 1, "EXECUTION_COMPLETED", {}));
    expect(shred).toHaveBeenCalledTimes(1);
    expect(shred).toHaveBeenCalledWith("alice", ["a1"]);
  });
});
