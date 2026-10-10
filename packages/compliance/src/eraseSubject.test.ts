import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore, inboxTopicStreamId } from "@loom/event-runtime";
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

describe("EraseCoordinator and a continue-as-new chain (ADR 0109 D2)", () => {
  const continued = (id: string, seq: number, to: string, kernel = true) => ({
    ...ev(id, seq, "EXECUTION_CONTINUED", { successorId: to, chainId: "k", generation: 1 }),
    ...(kernel && { metadata: { kernel: true } }),
  });

  it("a continued predecessor is TERMINAL: erasure proceeds when it is the subject's only execution", async () => {
    const store = new InMemoryAsyncEventStore();
    await seedStarted(store, "k", "dee");
    await store.append(continued("k", 1, "k~1"));
    const index = SubjectIndex.fromEvents(await store.read("k"), subjectOf);
    const shred = vi.fn(async () => {});
    const coord = new EraseCoordinator({ index, eventStore: store, shred });
    expect((await coord.eraseSubject("dee")).outcome).toBe("erased");
    expect(shred).toHaveBeenCalledWith("dee", ["k"]);
  });

  it("a LIVE successor still blocks erasure; the predecessor's EXECUTION_CONTINUED does not complete a parked one", async () => {
    const store = new InMemoryAsyncEventStore();
    await seedStarted(store, "k", "eve");
    await seedStarted(store, "k~1", "eve"); // the successor carries the subject too
    const index = SubjectIndex.fromEvents(
      [...(await store.read("k")), ...(await store.read("k~1"))],
      subjectOf
    );
    const shred = vi.fn(async () => {});
    const coord = new EraseCoordinator({ index, eventStore: store, shred });
    // while the predecessor is still running AND the successor is live: parked
    expect((await coord.eraseSubject("eve")).outcome).toBe("parked");
    // the predecessor's hand-off alone does not finish it: the successor is live
    await store.append(continued("k", 1, "k~1"));
    await coord.handleEvent(continued("k", 1, "k~1"));
    expect(shred).not.toHaveBeenCalled();
    expect(coord.pendingSubjects()).toEqual(["eve"]);
    // the successor ends: now it completes
    await store.append(ev("k~1", 1, "EXECUTION_COMPLETED", {}));
    await coord.handleEvent(ev("k~1", 1, "EXECUTION_COMPLETED", {}));
    expect(shred).toHaveBeenCalledWith("eve", ["k", "k~1"]);
  });

  it("an UNSTAMPED EXECUTION_CONTINUED is an app event: the execution stays live and erasure parks", async () => {
    const store = new InMemoryAsyncEventStore();
    await seedStarted(store, "k", "fay");
    await store.append(continued("k", 1, "k~1", false));
    const index = SubjectIndex.fromEvents(await store.read("k"), subjectOf);
    const shred = vi.fn(async () => {});
    const coord = new EraseCoordinator({ index, eventStore: store, shred });
    expect((await coord.eraseSubject("fay")).outcome).toBe("parked");
    expect(shred).not.toHaveBeenCalled();
  });
});

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

describe("EraseCoordinator — pre-1.21.0 snapshots (ADR 0105)", () => {
  it("a legacy snapshot that read `failed` for a CAUGHT step failure is still live: erasure parks", async () => {
    const store = new InMemoryAsyncEventStore();
    await seedStarted(store, "x1", "fay");
    await store.append(ev("x1", 1, "STEP_STARTED", { stepId: "s" }));
    await store.append(ev("x1", 2, "STEP_FAILED", { stepId: "s", error: "boom" }));
    const index = SubjectIndex.fromEvents(await store.read("x1"), subjectOf);
    // What a pre-1.21.0 fold wrote after a caught failure: execution `failed`, no `_error`.
    const current = foldEvents(await store.read("x1"));
    const legacy = { ...current, status: "failed" as const };
    expect(legacy.variables._error).toBeUndefined();
    const snapshotStore = { loadLatest: async () => ({ sequence: 2, state: legacy }) };
    const shred = vi.fn(async () => {});
    const coord = new EraseCoordinator({ index, eventStore: store, snapshotStore, shred });
    expect((await coord.eraseSubject("fay")).outcome).toBe("parked");
    expect(shred).not.toHaveBeenCalled();
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

describe("EraseCoordinator reaches RESERVED inbox streams (ADR 0110 follow-up)", () => {
  const streamOf = (chain: string): string => `__loom_inbox__:${chain}`;
  const inboxMsg = (chain: string, sequence = 0): EventEnvelope => ({
    id: `${streamOf(chain)}-${sequence}`,
    workflowId: "__loom_inbox__",
    executionId: streamOf(chain),
    eventType: "INBOX_MESSAGE",
    sequence,
    timestamp: 1,
    payload: { topic: "t", messageId: "m", payload: "ssn-123", sender: {} },
  });
  const setup = async () => {
    const store = new InMemoryAsyncEventStore();
    const order: string[] = [];
    const shred = vi.fn(async () => {
      order.push("shred");
    });
    return { store, shred, order };
  };
  const indexOf = async (store: InMemoryAsyncEventStore, ids: string[]) =>
    SubjectIndex.fromEvents((await Promise.all(ids.map((id) => store.read(id)))).flat(), subjectOf);

  it("an orphan stream of a finished execution is deleted with the erasure, AFTER the shred", async () => {
    const { store, shred, order } = await setup();
    await seedStarted(store, "a1", "ann");
    await store.append(ev("a1", 1, "EXECUTION_COMPLETED", {}));
    await store.append(inboxMsg("a1")); // a crash orphan: a send landed after the owner's own delete
    const rawDelete = store.deleteExecution!.bind(store);
    store.deleteExecution = async (id: string) => {
      order.push(`delete ${id}`);
      return rawDelete(id);
    };
    const coord = new EraseCoordinator({
      index: await indexOf(store, ["a1"]),
      eventStore: store,
      shred,
    });
    expect((await coord.eraseSubject("ann")).outcome).toBe("erased");
    expect(await store.read(streamOf("a1"))).toEqual([]);
    expect(order).toEqual(["shred", `delete ${streamOf("a1")}`]);
  });

  it("ADR 0110 D10b: EVERY stream of the chain is purged — topic streams, the legacy one, then the registry LAST", async () => {
    const { store, shred, order } = await setup();
    await seedStarted(store, "a1", "ann");
    await store.append(ev("a1", 1, "EXECUTION_COMPLETED", {}));
    const registry = "__loom_inbox__:a1#reg";
    const hot = inboxTopicStreamId("a1", "hot");
    const cold = inboxTopicStreamId("a1", "cold");
    for (const topic of ["hot", "cold", "hot"]) {
      await store.append({
        id: `${registry}-${(await store.read(registry)).length}`,
        workflowId: "__loom_inbox__",
        executionId: registry,
        eventType: "INBOX_TOPIC",
        sequence: (await store.read(registry)).length,
        timestamp: 1,
        payload: { topic },
      });
    }
    for (const stream of [hot, cold]) {
      await store.append({ ...inboxMsg("a1", 2 ** 40), id: `${stream}-x`, executionId: stream });
    }
    await store.append(inboxMsg("a1"));
    const rawDelete = store.deleteExecution!.bind(store);
    store.deleteExecution = async (id: string) => {
      order.push(`delete ${id}`);
      return rawDelete(id);
    };
    const coord = new EraseCoordinator({
      index: await indexOf(store, ["a1"]),
      eventStore: store,
      shred,
    });
    expect((await coord.eraseSubject("ann")).outcome).toBe("erased");
    for (const stream of [hot, cold, streamOf("a1"), registry]) {
      expect(await store.read(stream)).toEqual([]);
    }
    // The topic streams first, the registry that names them last (a crash midway stays findable).
    expect(order).toEqual([
      "shred",
      `delete ${hot}`,
      `delete ${cold}`,
      `delete ${streamOf("a1")}`,
      `delete ${registry}`,
    ]);
  });

  it("ADR 0110 D10b: a topic stream the registry does NOT name (a sender died before registering) is purged too", async () => {
    const { store, shred } = await setup();
    await seedStarted(store, "a1", "ann");
    await store.append(ev("a1", 1, "EXECUTION_COMPLETED", {}));
    const ghost = inboxTopicStreamId("a1", "ghost");
    await store.append({ ...inboxMsg("a1", 2 ** 40), id: `${ghost}-x`, executionId: ghost });
    // A neighbour chain sharing the id prefix must be left alone.
    const other = inboxTopicStreamId("a1#x", "t");
    await store.append({ ...inboxMsg("a1#x", 2 ** 40), id: `${other}-x`, executionId: other });
    const coord = new EraseCoordinator({
      index: await indexOf(store, ["a1"]),
      eventStore: store,
      shred,
    });
    expect((await coord.eraseSubject("ann")).outcome).toBe("erased");
    expect(await store.read(ghost)).toEqual([]);
    expect(await store.read(other)).toHaveLength(1);
  });

  it("the logs are read BEFORE the key is destroyed: a store that cannot read after the shred still gets its stream purged", async () => {
    const { store } = await setup();
    await seedStarted(store, "a1", "ann");
    await store.append(ev("a1", 1, "EXECUTION_FAILED", {}));
    await store.append(inboxMsg("a1"));
    let shredded = false;
    const decrypting = Object.create(store) as InMemoryAsyncEventStore;
    decrypting.read = async (id: string) => {
      if (shredded) throw new Error("PayloadShreddedError: the key is gone");
      return store.read(id);
    };
    const coord = new EraseCoordinator({
      index: await indexOf(store, ["a1"]),
      eventStore: decrypting,
      shred: async () => {
        shredded = true;
      },
    });
    expect((await coord.eraseSubject("ann")).outcome).toBe("erased");
    expect(await store.read(streamOf("a1"))).toEqual([]);
  });

  it("a fork's own chain is purged by its stamp, not by its execution id", async () => {
    const { store, shred } = await setup();
    await store.append({
      ...ev("f1", 0, "EXECUTION_STARTED", { input: { userId: "ann" } }),
      metadata: { forkChain: { chainId: "fork-chain", generation: 0 } },
    });
    await store.append(ev("f1", 1, "EXECUTION_COMPLETED", {}));
    await store.append(inboxMsg("fork-chain"));
    await store.append(inboxMsg("f1")); // not this execution's chain: must survive
    const coord = new EraseCoordinator({
      index: await indexOf(store, ["f1"]),
      eventStore: store,
      shred,
    });
    await coord.eraseSubject("ann");
    expect(await store.read(streamOf("fork-chain"))).toEqual([]);
    expect(await store.read(streamOf("f1"))).toHaveLength(1);
  });

  it("a later generation is judged by its start's chain id", async () => {
    const { store, shred } = await setup();
    await seedStarted(store, "k", "ann");
    await store.append({
      ...ev("k", 1, "EXECUTION_CONTINUED", { successorId: "k~1", chainId: "k", generation: 1 }),
      metadata: { kernel: true },
    });
    await store.append(
      ev("k~1", 0, "EXECUTION_STARTED", { input: { userId: "ann" }, chainId: "k", generation: 1 })
    );
    await store.append(ev("k~1", 1, "EXECUTION_COMPLETED", {}));
    await store.append(inboxMsg("k"));
    const coord = new EraseCoordinator({
      index: await indexOf(store, ["k", "k~1"]),
      eventStore: store,
      shred,
    });
    expect((await coord.eraseSubject("ann")).outcome).toBe("erased");
    expect(await store.read(streamOf("k"))).toEqual([]);
  });

  it("a CONTINUED execution never purges: its successor, which this subject does not own, still owns the stream", async () => {
    const { store, shred } = await setup();
    await seedStarted(store, "k", "ann");
    await store.append({
      ...ev("k", 1, "EXECUTION_CONTINUED", { successorId: "k~1", chainId: "k", generation: 1 }),
      metadata: { kernel: true },
    });
    await store.append(inboxMsg("k"));
    const coord = new EraseCoordinator({
      index: await indexOf(store, ["k"]),
      eventStore: store,
      shred,
    });
    expect((await coord.eraseSubject("ann")).outcome).toBe("erased");
    expect(await store.read(streamOf("k"))).toHaveLength(1);
  });

  it("another subject's stream is untouched", async () => {
    const { store, shred } = await setup();
    await seedStarted(store, "a1", "ann");
    await store.append(ev("a1", 1, "EXECUTION_COMPLETED", {}));
    await seedStarted(store, "b1", "bob");
    await store.append(ev("b1", 1, "EXECUTION_COMPLETED", {}));
    await store.append(inboxMsg("a1"));
    await store.append(inboxMsg("b1"));
    const coord = new EraseCoordinator({
      index: await indexOf(store, ["a1", "b1"]),
      eventStore: store,
      shred,
    });
    await coord.eraseSubject("ann");
    expect(await store.read(streamOf("a1"))).toEqual([]);
    expect(await store.read(streamOf("b1"))).toHaveLength(1);
  });

  it("a LIVE execution parks the erasure and its stream is left alone until it finishes; then the parked erasure purges", async () => {
    const { store, shred } = await setup();
    await seedStarted(store, "a1", "ann");
    await store.append(inboxMsg("a1"));
    const coord = new EraseCoordinator({
      index: await indexOf(store, ["a1"]),
      eventStore: store,
      shred,
    });
    expect((await coord.eraseSubject("ann")).outcome).toBe("parked");
    expect(await store.read(streamOf("a1"))).toHaveLength(1);
    const done = ev("a1", 1, "EXECUTION_COMPLETED", {});
    await store.append(done);
    await coord.handleEvent(done);
    expect(shred).toHaveBeenCalled();
    expect(await store.read(streamOf("a1"))).toEqual([]);
  });

  it("a store that cannot delete streams is a no-op (the key is the erasure there)", async () => {
    const { store, shred } = await setup();
    await seedStarted(store, "a1", "ann");
    await store.append(ev("a1", 1, "EXECUTION_COMPLETED", {}));
    await store.append(inboxMsg("a1"));
    const readWrite = { read: store.read.bind(store), append: store.append.bind(store) };
    const coord = new EraseCoordinator({
      index: await indexOf(store, ["a1"]),
      eventStore: readWrite,
      shred,
    });
    expect((await coord.eraseSubject("ann")).outcome).toBe("erased");
    expect(await store.read(streamOf("a1"))).toHaveLength(1);
  });
});

describe("EraseCoordinator and PARKED owners (review P2-2)", () => {
  const suspend = (id: string, seq: number) =>
    ev(id, seq, "EXECUTION_SUSPENDED", { condition: { on: "Go" } });
  const streamOf = (chain: string): string => `__loom_inbox__:${chain}`;
  const inboxMsg = (chain: string): EventEnvelope => ({
    id: `${streamOf(chain)}-0`,
    workflowId: "__loom_inbox__",
    executionId: streamOf(chain),
    eventType: "INBOX_MESSAGE",
    sequence: 0,
    timestamp: 1,
    payload: { topic: "t", messageId: "m", payload: "ssn-123", sender: {} },
  });
  /** A runtime-free cancel: appends the terminal event the way `runtime.cancel` journals it. */
  const make = async (
    parkedIds: string[],
    runningIds: string[] = [],
    cancelImpl?: (store: InMemoryAsyncEventStore, id: string) => Promise<boolean>
  ) => {
    const store = new InMemoryAsyncEventStore();
    for (const id of [...parkedIds, ...runningIds]) await seedStarted(store, id, "pat");
    for (const id of parkedIds) await store.append(suspend(id, 1));
    const events = (
      await Promise.all([...parkedIds, ...runningIds].map((id) => store.read(id)))
    ).flat();
    const order: string[] = [];
    const shred = vi.fn(async () => {
      order.push("shred");
    });
    const cancel = vi.fn(async (id: string, reason: string) => {
      order.push(`cancel ${id} ${reason}`);
      if (cancelImpl !== undefined) return cancelImpl(store, id);
      await store.append(ev(id, 2, "EXECUTION_CANCELLED", { reason }));
      return true;
    });
    const coord = new EraseCoordinator({
      index: SubjectIndex.fromEvents(events, subjectOf),
      eventStore: store,
      shred,
      cancel,
    });
    return { store, shred, cancel, order, coord };
  };

  it("by default a suspended owner is LIVE: the erasure is parked (honestly) and nothing is shredded", async () => {
    const { shred, cancel, coord } = await make(["p1"]);
    const r = await coord.eraseSubject("pat");
    expect(r).toMatchObject({ outcome: "parked", erased: [], pending: ["p1"] });
    expect(shred).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(coord.pendingSubjects()).toEqual(["pat"]);
  });

  it('{ parked: "shred" } CANCELS every parked owner (reason "erased") BEFORE shredding, and names them', async () => {
    const { shred, order, store, coord } = await make(["p1", "p2"]);
    const r = await coord.eraseSubject("pat", undefined, { parked: "shred" });
    expect(r).toMatchObject({
      outcome: "erased",
      erased: ["p1", "p2"],
      pending: [],
      parkedShredded: ["p1", "p2"],
    });
    expect(shred).toHaveBeenCalledWith("pat", ["p1", "p2"]);
    expect(order).toEqual(["cancel p1 erased", "cancel p2 erased", "shred"]);
    for (const id of ["p1", "p2"]) {
      expect((await store.read(id)).at(-1)?.eventType).toBe("EXECUTION_CANCELLED");
    }
  });

  it('{ parked: "shred" } NEVER shreds past a RUNNING owner: it defers on exactly that one and cancels nothing', async () => {
    const { shred, cancel, coord } = await make(["p1"], ["r1"]);
    const r = await coord.eraseSubject("pat", undefined, { parked: "shred" });
    expect(r).toMatchObject({ outcome: "parked", erased: [], pending: ["r1"] });
    expect(shred).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('{ parked: "shred" } DEFERS (no shred) when a cancel fails, or the owner woke up and is not terminal', async () => {
    const failing = await make(["p1"], [], async () => {
      throw new Error("fence lost");
    });
    expect(await failing.coord.eraseSubject("pat", undefined, { parked: "shred" })).toMatchObject({
      outcome: "parked",
      pending: ["p1"],
    });
    expect(failing.shred).not.toHaveBeenCalled();

    // the cancel "succeeds" but the owner has since resumed (still non-terminal)
    const woke = await make(["p1"], [], async (store, id) => {
      await store.append(ev(id, 2, "EXECUTION_RESUMED", {}));
      return true;
    });
    expect(await woke.coord.eraseSubject("pat", undefined, { parked: "shred" })).toMatchObject({
      outcome: "parked",
    });
    expect(woke.shred).not.toHaveBeenCalled();
  });

  it('{ parked: "shred" } without a `cancel` hook throws and shreds nothing', async () => {
    const { store, shred } = await make(["p1"]);
    const coord = new EraseCoordinator({
      index: SubjectIndex.fromEvents(await store.read("p1"), subjectOf),
      eventStore: store,
      shred,
    });
    await expect(coord.eraseSubject("pat", undefined, { parked: "shred" })).rejects.toThrow(
      /pass `cancel`/
    );
    expect(shred).not.toHaveBeenCalled();
  });

  it("the cancelled owners are TERMINAL heads, so their reserved inbox streams are purged too (plaintext-before-crypto edge)", async () => {
    const { store, coord } = await make(["p1"]);
    await store.append(inboxMsg("p1"));
    expect(await store.read(streamOf("p1"))).toHaveLength(1);
    await coord.eraseSubject("pat", undefined, { parked: "shred" });
    expect(await store.read(streamOf("p1"))).toEqual([]);
  });

  it('{ parked: "defer" } is the default spelled out; a terminal-only subject is unaffected by the option', async () => {
    const { store, shred, cancel } = await make([], []);
    await seedStarted(store, "t1", "pat");
    await store.append(ev("t1", 1, "EXECUTION_COMPLETED", {}));
    const c2 = new EraseCoordinator({
      index: SubjectIndex.fromEvents(await store.read("t1"), subjectOf),
      eventStore: store,
      shred,
      cancel,
    });
    const r = await c2.eraseSubject("pat", undefined, { parked: "shred" });
    expect(r).toMatchObject({ outcome: "erased", parkedShredded: [] });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a re-run over an ALREADY-shredded log judges it by the redacted view the typed error carries (idempotent)", async () => {
    const { store, shred } = await make([]);
    await seedStarted(store, "t1", "pat");
    await store.append(ev("t1", 1, "EXECUTION_COMPLETED", {}));
    const shreddedStore = Object.create(store) as InMemoryAsyncEventStore;
    shreddedStore.read = async (id: string) => {
      const err = new Error("shredded") as Error & { redacted?: unknown };
      err.name = "PayloadShreddedError";
      err.redacted = await store.read(id);
      throw err;
    };
    const coord = new EraseCoordinator({
      index: SubjectIndex.fromEvents(await store.read("t1"), subjectOf),
      eventStore: shreddedStore,
      shred,
    });
    expect((await coord.eraseSubject("pat")).outcome).toBe("erased");
  });
});
