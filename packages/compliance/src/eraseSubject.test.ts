import type { EventEnvelope } from "@loom/core";
import {
  type ArchiveSegment,
  type ArchiveSegmentHeader,
  type ArchiveStore,
  InMemoryArchiveStore,
  InMemoryAsyncEventStore,
  assertReservedSegmentDigest,
  brandPayloadShredded,
  buildReservedSegment,
  buildSegment,
  inboxTopicStreamId,
  quarantineStreamId,
  senderDigestOf,
} from "@loom/event-runtime";
import { foldEvents } from "@loom/replay-vm";
import { SnapshotIdentityMismatchError } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { SubjectIndex } from "./SubjectIndex";
import {
  ArchivedCopiesRemainError,
  ERASURE_STREAM,
  EraseCoordinator,
  SenderRedactionUnsupportedError,
} from "./eraseSubject";

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
    // ADR 0130 residuals D9: the chain's quarantine stream is named (and deleted) with the others.
    expect(order).toEqual([
      "shred",
      `delete ${streamOf("a1")}`,
      `delete ${quarantineStreamId("a1")}`,
    ]);
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
    // ADR 0130 residuals D9: a held (quarantined) copy of the chain is an in-flight payload too.
    const held = quarantineStreamId("a1");
    await store.append({ ...inboxMsg("a1"), id: "quarantine:k", executionId: held });
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
    for (const stream of [hot, cold, streamOf("a1"), held, registry]) {
      expect(await store.read(stream)).toEqual([]);
    }
    // The topic streams first, the registry that names them last (a crash midway stays findable).
    expect(order).toEqual([
      "shred",
      `delete ${hot}`,
      `delete ${cold}`,
      `delete ${streamOf("a1")}`,
      `delete ${held}`,
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
      // (the erasure's own control stream is never sealed: the real store reads it after a shred)
      if (shredded && id !== ERASURE_STREAM) {
        throw brandPayloadShredded(new Error("PayloadShreddedError: the key is gone"));
      }
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
      if (id === ERASURE_STREAM) return store.read(id);
      const err = new Error("shredded") as Error & { redacted?: unknown };
      err.name = "PayloadShreddedError";
      brandPayloadShredded(err);
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

  it("an Error only NAMED PayloadShreddedError (no brand) is NOT judged by its redacted view", async () => {
    const { store, shred } = await make([]);
    await seedStarted(store, "t1", "pat");
    await store.append(ev("t1", 1, "EXECUTION_COMPLETED", {}));
    const forgedStore = Object.create(store) as InMemoryAsyncEventStore;
    forgedStore.read = async (id: string) => {
      const err = new Error("forged") as Error & { redacted?: unknown };
      err.name = "PayloadShreddedError";
      err.redacted = await store.read(id);
      throw err;
    };
    const coord = new EraseCoordinator({
      index: SubjectIndex.fromEvents(await store.read("t1"), subjectOf),
      eventStore: forgedStore,
      shred,
    });
    await expect(coord.eraseSubject("pat")).rejects.toThrow("forged");
  });
});

describe("erasure deletes the archived copies of a PLAINTEXT archive (ADR 0138 / 0139, owner ruling 2026-10-31)", () => {
  const chainInbox = (c: string) => `__loom_inbox__:${c}`;
  async function world() {
    const store = new InMemoryAsyncEventStore();
    await seedStarted(store, "e1", "zed");
    await store.append(ev("e1", 1, "EXECUTION_COMPLETED", {}));
    const index = SubjectIndex.fromEvents(await store.read("e1"), subjectOf);
    const archive = new InMemoryArchiveStore();
    // ADR 0138: a compaction segment of the subject's execution, and another execution's (kept)
    await archive.append(
      "e1",
      buildSegment([ev("e1", 1, "STEP_COMPLETED", { secret: "zed" })], "inc")
    );
    await archive.append("other", buildSegment([ev("other", 1, "STEP_COMPLETED", {})], "inc"));
    // ADR 0139: the chain's reserved streams (a trimmed prefix, a late run) and another chain's
    for (const key of [
      chainInbox("e1"),
      `__loom_late__:${chainInbox("e1")}@1`,
      "__loom_quarantine__:e1",
      chainInbox("e10"), // a chain whose id merely STARTS with ours: must survive
    ]) {
      await archive.append(
        key,
        buildSegment(
          [{ ...ev(key, 1, "INBOX_MESSAGE", { topic: "t" }), workflowId: "__loom_inbox__" }],
          "inc"
        )
      );
    }
    return { store, index, archive };
  }

  it("deletes the subject's compaction and reserved segments, keeps others', and records what it deleted", async () => {
    const { store, index, archive } = await world();
    const shred = vi.fn(async () => {});
    const coord = new EraseCoordinator({ index, eventStore: store, shred, archives: [archive] });
    const r = await coord.eraseSubject("zed");
    expect(r.outcome).toBe("erased");
    expect(r.archivedCopiesDeleted?.executions).toEqual(["e1"]);
    expect([...(r.archivedCopiesDeleted?.reservedStreams ?? [])].sort()).toEqual(
      [chainInbox("e1"), "__loom_quarantine__:e1", `__loom_late__:${chainInbox("e1")}@1`].sort()
    );
    expect(await archive.headers("e1")).toEqual([]);
    expect(await archive.headers(chainInbox("e1"))).toEqual([]);
    expect(await archive.headers(`__loom_late__:${chainInbox("e1")}@1`)).toEqual([]);
    expect((await archive.headers("other")).length).toBe(1);
    expect((await archive.headers(chainInbox("e10"))).length).toBe(1);
    const recorded = (await store.read(ERASURE_STREAM)).filter(
      (e) => e.eventType === "ERASURE_ARCHIVE_DELETED"
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toMatchObject({ subjectId: "zed", executions: ["e1"] });
    // idempotent: a retry finds nothing and records nothing more
    await coord.eraseSubject("zed");
    expect(
      (await store.read(ERASURE_STREAM)).filter((e) => e.eventType === "ERASURE_ARCHIVE_DELETED")
    ).toHaveLength(1);
  });

  it("never returns erased while plaintext copies remain: a plaintext archive that cannot delete refuses BEFORE the shred", async () => {
    const { store, index, archive } = await world();
    const stuck: ArchiveStore = {
      append: (id, seg) => archive.append(id, seg),
      headers: (id) => archive.headers(id),
      read: (id, range) => archive.read(id, range),
      listExecutions: (o) => archive.listExecutions(o),
      close: () => archive.close(),
    };
    const shred = vi.fn(async () => {});
    const coord = new EraseCoordinator({ index, eventStore: store, shred, archives: [stuck] });
    await expect(coord.eraseSubject("zed")).rejects.toThrow(ArchivedCopiesRemainError);
    expect(shred).not.toHaveBeenCalled();
    expect((await archive.headers("e1")).length).toBe(1);
  });

  it("a SEALING archive is left to the crypto-shred (nothing is deleted from it)", async () => {
    const { store, index, archive } = await world();
    const sealing = Object.assign(Object.create(archive), { sealsSegments: true }) as ArchiveStore;
    const shred = vi.fn(async () => {});
    const coord = new EraseCoordinator({ index, eventStore: store, shred, archives: [sealing] });
    const r = await coord.eraseSubject("zed");
    expect(r.outcome).toBe("erased");
    expect(r.archivedCopiesDeleted).toBeUndefined();
    expect((await archive.headers("e1")).length).toBe(1);
  });

  it("a PARKED erasure deletes the archived copies when the last execution terminates", async () => {
    const store = new InMemoryAsyncEventStore();
    await seedStarted(store, "e2", "yan");
    const index = SubjectIndex.fromEvents(await store.read("e2"), subjectOf);
    const archive = new InMemoryArchiveStore();
    await archive.append("e2", buildSegment([ev("e2", 1, "STEP_COMPLETED", { s: 1 })], "inc"));
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: vi.fn(async () => {}),
      archives: [archive],
    });
    expect((await coord.eraseSubject("yan")).outcome).toBe("parked");
    expect((await archive.headers("e2")).length).toBe(1);
    const done = ev("e2", 1, "EXECUTION_COMPLETED", {});
    await store.append(done);
    await coord.handleEvent(done);
    expect(await archive.headers("e2")).toEqual([]);
  });

  it("D12: erasing a SENDER redacts their identity in OTHER chains' archived reserved segments (plaintext), keeps the rest, journals it", async () => {
    const { store, index, archive } = await world();
    const key = chainInbox("other-chain");
    const msg = (seq: number, actor: string) => ({
      ...ev(key, seq, "INBOX_MESSAGE", {
        topic: "t",
        messageId: `m${seq}`,
        payload: `body ${seq}`,
        sender: { actor },
      }),
      workflowId: "__loom_inbox__",
    });
    const envs = [msg(1, "zed"), msg(2, "kim"), msg(3, "zed")];
    await archive.append(key, buildReservedSegment(envs, "inc"));
    // a crashed rewrite of another key: the stage holds the whole segment, the original is gone
    const lost = chainInbox("crashed");
    await archive.append(
      `__loom_redact__:${lost}`,
      buildReservedSegment([{ ...msg(1, "kim"), executionId: lost }], "inc")
    );
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: vi.fn(async () => {}),
      archives: [archive],
    });
    const r = await coord.eraseSubject("zed");
    expect(r.senderRedactions).toEqual([{ streamId: key, envelopes: 2 }]);
    const [seg] = await archive.read(key);
    const senders = seg?.envelopes.map((e) => (e.payload as { sender: { ref?: string } }).sender);
    // ADR 0139 N3: the erased marker carries one stable, non-identifying reference per erased sender
    expect(senders).toEqual([
      { erased: true, ref: expect.any(String) },
      { actor: "kim" },
      { erased: true, ref: expect.any(String) },
    ]);
    expect(senders?.[0]?.ref).toBe(senders?.[2]?.ref);
    expect(JSON.stringify(senders?.[0])).not.toContain("zed");
    expect(seg?.envelopes.map((e) => (e.payload as { payload: unknown }).payload)).toEqual([
      "body 1",
      "body 2",
      "body 3",
    ]);
    assertReservedSegmentDigest(key, seg as never); // the digest masks the sender: it still verifies
    expect(await archive.headers(`__loom_redact__:${key}`)).toEqual([]);
    // the crashed rewrite was recovered from its stage
    expect((await archive.headers(lost)).length).toBe(1);
    expect(await archive.headers(`__loom_redact__:${lost}`)).toEqual([]);
    expect(
      (await store.read(ERASURE_STREAM)).some((e) => e.eventType === "ERASURE_SENDER_REDACTED")
    ).toBe(true);
  });
});

// ── ADR 0139 review round 2 (#729): N1 atomic redaction, N4 intent-first journal, N5 refuse, N7 digest ──
describe("erasure redaction and deletion are atomic, recorded and fail closed (ADR 0139 N1/N4/N5/N7)", () => {
  const inbox = (c: string) => `__loom_inbox__:${c}`;
  const msg = (key: string, seq: number, actor: string) => ({
    ...ev(key, seq, "INBOX_MESSAGE", {
      topic: "t",
      messageId: `m${seq}`,
      payload: `body ${seq}`,
      sender: { actor },
    }),
    workflowId: "__loom_inbox__",
  });
  async function world() {
    const store = new InMemoryAsyncEventStore();
    await seedStarted(store, "e1", "zed");
    await store.append(ev("e1", 1, "EXECUTION_COMPLETED", {}));
    const index = SubjectIndex.fromEvents(await store.read("e1"), subjectOf);
    const archive = new InMemoryArchiveStore();
    const k1 = inbox("c1");
    const k2 = inbox("c2");
    await archive.append(k1, buildReservedSegment([msg(k1, 1, "zed"), msg(k1, 2, "kim")], "inc"));
    await archive.append(k2, buildReservedSegment([msg(k2, 1, "zed")], "inc"));
    return { store, index, archive, k1, k2 };
  }
  const sendersOf = async (a: ArchiveStore, key: string) =>
    (await a.read(key)).flatMap((seg) =>
      seg.envelopes.map(
        (e) => (e.payload as { sender: { actor?: string; erased?: boolean } }).sender
      )
    );

  it("N1: a segment a trim appended between the read and the swap is NOT lost; the key is re-read and redacted whole", async () => {
    const { store, index, archive, k1 } = await world();
    let raced = false;
    const racing: ErasableArchiveLike = Object.assign(Object.create(archive), {
      replaceSegments: async (
        key: string,
        expected: readonly ArchiveSegmentHeader[],
        next: readonly ArchiveSegment[]
      ) => {
        if (!raced && key === k1) {
          raced = true;
          // a trim on ANOTHER node appends a segment (naming the subject too) after our read
          await archive.append(k1, buildReservedSegment([msg(k1, 3, "zed")], "inc"));
        }
        return archive.replaceSegments(key, expected, next);
      },
    });
    const invalidated: string[] = [];
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: vi.fn(async () => {}),
      archives: [racing],
      onArchiveKeyChanged: (k) => invalidated.push(k),
    });
    const r = await coord.eraseSubject("zed");
    expect(raced).toBe(true);
    expect(r.outcome).toBe("erased");
    // the appended segment survived AND is redacted; nobody named zed remains anywhere
    expect((await archive.headers(k1)).map((h) => [h.from, h.through])).toEqual([
      [1, 2],
      [3, 3],
    ]);
    const senders = await sendersOf(archive, k1);
    expect(senders.map((x) => x.actor ?? "erased")).toEqual(["erased", "kim", "erased"]);
    expect(JSON.stringify(await archive.read(k1))).not.toContain("zed");
    expect(invalidated).toContain(k1);
  });

  it("N7: a redaction recomputes the sender digest in the same swap, so the sender field still has bit-rot detection", async () => {
    const { store, index, archive, k1 } = await world();
    const before = (await archive.headers(k1))[0]?.senderDigest;
    expect(before).toBeDefined();
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: vi.fn(async () => {}),
      archives: [archive],
    });
    await coord.eraseSubject("zed");
    const [seg] = await archive.read(k1);
    expect(seg?.senderDigest).toBe(senderDigestOf(seg?.envelopes ?? []));
    expect(seg?.senderDigest).not.toBe(before);
    assertReservedSegmentDigest(k1, seg as ArchiveSegment); // verifies both digests
    // a flipped sender byte (bit rot of the masked field) is now DETECTED
    const rotted = JSON.parse(JSON.stringify(seg)) as ArchiveSegment;
    (rotted.envelopes[1]!.payload as { sender: { actor: string } }).sender.actor = "mallory";
    expect(() => assertReservedSegmentDigest(k1, rotted)).toThrow();
  });

  it("N1: a crash MID-redaction loses nothing (every key whole), is journaled as an intent, and the retry after boot completes it", async () => {
    const { store, index, archive, k1, k2 } = await world();
    let failSecond = true;
    const flaky: ErasableArchiveLike = Object.assign(Object.create(archive), {
      replaceSegments: async (
        key: string,
        expected: readonly ArchiveSegmentHeader[],
        next: readonly ArchiveSegment[]
      ) => {
        if (failSecond && key === k2) {
          failSecond = false;
          throw new Error("process died");
        }
        return archive.replaceSegments(key, expected, next);
      },
    });
    const make = () =>
      new EraseCoordinator({
        index,
        eventStore: store,
        shred: vi.fn(async () => {}),
        archives: [flaky],
      });
    await expect(make().eraseSubject("zed")).rejects.toThrow("process died");
    // nothing lost: k1 redacted, k2 whole (still holds the one envelope), no stage keys
    expect((await sendersOf(archive, k1)).map((x) => x.actor ?? "erased")).toEqual([
      "erased",
      "kim",
    ]);
    expect((await sendersOf(archive, k2)).map((x) => x.actor ?? "erased")).toEqual(["zed"]);
    const journal = await store.read(ERASURE_STREAM);
    expect(journal.filter((e) => e.eventType === "ERASURE_SENDER_REDACTION_INTENDED")).toHaveLength(
      1
    );
    expect(journal.filter((e) => e.eventType === "ERASURE_SENDER_REDACTED")).toHaveLength(0);
    // BOOT (a fresh coordinator) then the operator's retry finishes it, recording the completion
    const booted = make();
    await booted.loadParked();
    const r = await booted.eraseSubject("zed");
    expect((await sendersOf(archive, k2)).map((x) => x.actor ?? "erased")).toEqual(["erased"]);
    expect(r.senderRedactions?.map((x) => x.streamId).sort()).toEqual([k1, k2].sort());
    const done = (await store.read(ERASURE_STREAM)).filter(
      (e) => e.eventType === "ERASURE_SENDER_REDACTED"
    );
    expect(done).toHaveLength(1);
    expect((done[0]?.payload as { intentId?: string }).intentId).toBe(
      journal.find((e) => e.eventType === "ERASURE_SENDER_REDACTION_INTENDED")?.id
    );
  });

  it("N1: a stage an earlier build left (original gone) is restored at BOOT and by the operator verb, not only at the next erasure", async () => {
    const { store, index, archive } = await world();
    const lost = inbox("lost");
    await archive.append(
      `__loom_redact__:${lost}`,
      buildReservedSegment([msg(lost, 1, "kim")], "inc")
    );
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: vi.fn(async () => {}),
      archives: [archive],
    });
    expect(await archive.headers(lost)).toEqual([]);
    await coord.loadParked(); // boot
    expect((await archive.headers(lost)).length).toBe(1);
    expect(await archive.headers(`__loom_redact__:${lost}`)).toEqual([]);
    // the operator verb on its own
    await archive.append(
      `__loom_redact__:${inbox("lost2")}`,
      buildReservedSegment([msg(inbox("lost2"), 1, "kim")], "inc")
    );
    expect(await coord.recoverRedactions()).toEqual([inbox("lost2")]);
    expect((await archive.headers(inbox("lost2"))).length).toBe(1);
  });

  it("N4: a crash between the delete and its record is finished by the retry from the journaled intent (never an unrecorded deletion)", async () => {
    const { store, index, archive, k1 } = await world();
    await archive.append("e1", buildSegment([ev("e1", 1, "STEP_COMPLETED", { s: "zed" })], "inc"));
    let crash = true;
    const crashing = Object.create(store) as InMemoryAsyncEventStore;
    crashing.append = async (e: EventEnvelope) => {
      if (crash && e.eventType === "ERASURE_ARCHIVE_DELETED") {
        crash = false;
        throw new Error("crashed after the delete, before the record");
      }
      return store.append(e);
    };
    const make = () =>
      new EraseCoordinator({
        index,
        eventStore: crashing,
        shred: vi.fn(async () => {}),
        archives: [archive],
      });
    await expect(make().eraseSubject("zed")).rejects.toThrow("crashed after the delete");
    expect(await archive.headers("e1")).toEqual([]); // the deletion happened...
    const journal = await store.read(ERASURE_STREAM);
    const intent = journal.find((e) => e.eventType === "ERASURE_ARCHIVE_DELETE_INTENDED");
    expect(intent).toBeDefined(); // ...and the intent was recorded BEFORE it
    expect((intent?.payload as { executions: string[] }).executions).toEqual(["e1"]);
    expect(journal.some((e) => e.eventType === "ERASURE_ARCHIVE_DELETED")).toBe(false);
    // the retry (nothing left to delete) still records the completion, naming the intent
    const r = await make().eraseSubject("zed");
    expect(r.archivedCopiesDeleted?.executions).toEqual(["e1"]);
    const done = (await store.read(ERASURE_STREAM)).filter(
      (e) => e.eventType === "ERASURE_ARCHIVE_DELETED"
    );
    expect(done).toHaveLength(1);
    expect((done[0]?.payload as { intentId: string }).intentId).toBe(intent?.id);
    // and a third call records nothing more
    await make().eraseSubject("zed");
    expect(
      (await store.read(ERASURE_STREAM)).filter((e) => e.eventType === "ERASURE_ARCHIVE_DELETED")
    ).toHaveLength(1);
    expect(k1).toBeDefined();
  });

  it("N5: a plaintext archive holding the subject as a SENDER that cannot swap a segment REFUSES before the shred (not a silent skip)", async () => {
    const { store, index, archive, k1 } = await world();
    const noReplace: ArchiveStore = {
      append: (id, seg) => archive.append(id, seg),
      headers: (id) => archive.headers(id),
      read: (id, range) => archive.read(id, range),
      listExecutions: (o) => archive.listExecutions(o),
      deleteExecution: (id) => archive.deleteExecution(id),
      close: () => archive.close(),
    };
    const shred = vi.fn(async () => {});
    const coord = new EraseCoordinator({ index, eventStore: store, shred, archives: [noReplace] });
    await expect(coord.eraseSubject("zed")).rejects.toThrow(SenderRedactionUnsupportedError);
    expect(shred).not.toHaveBeenCalled();
    expect((await sendersOf(archive, k1)).map((x) => x.actor)).toEqual(["zed", "kim"]); // untouched
    // an archive that holds NO copy of the subject as a sender is fine without replaceSegments
    const clean = new InMemoryArchiveStore();
    const cleanView: ArchiveStore = {
      append: (id, seg) => clean.append(id, seg),
      headers: (id) => clean.headers(id),
      read: (id, range) => clean.read(id, range),
      listExecutions: (o) => clean.listExecutions(o),
      deleteExecution: (id) => clean.deleteExecution(id),
      close: () => clean.close(),
    };
    await clean.append(inbox("x"), buildReservedSegment([msg(inbox("x"), 1, "kim")], "inc"));
    const ok = new EraseCoordinator({
      index,
      eventStore: store,
      shred: vi.fn(async () => {}),
      archives: [cleanView],
    });
    expect((await ok.eraseSubject("zed")).outcome).toBe("erased");
  });

  it("N6: the crypto layer's sender eraser runs after the shred, with the subject and the tenant partition", async () => {
    const { store, index, archive } = await world();
    const calls: string[] = [];
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: vi.fn(async () => {
        calls.push("shred");
      }),
      eraseSender: async (subject, tenant) => {
        calls.push(`eraseSender:${subject}:${tenant}`);
      },
      archives: [archive],
    });
    await coord.eraseSubject("zed");
    expect(calls).toEqual(["shred", "eraseSender:zed:"]);
  });
});

type ErasableArchiveLike = InMemoryArchiveStore;

describe("loadParked loads the parked set even when archive recovery fails (ADR 0139 D22)", () => {
  it("a failing archive is warned loudly, the parked erasure is still known, and recovery stays retryable", async () => {
    const store = new InMemoryAsyncEventStore();
    await seedStarted(store, "x1", "dan");
    const index = SubjectIndex.fromEvents(await store.read("x1"), subjectOf);
    await new EraseCoordinator({
      index,
      eventStore: store,
      shred: vi.fn(async () => {}),
    }).eraseSubject("dan"); // parks dan (a live execution)

    const inner = new InMemoryArchiveStore();
    let down = true;
    const flaky = Object.assign(Object.create(inner) as InMemoryArchiveStore, {
      listExecutions: async (...a: Parameters<InMemoryArchiveStore["listExecutions"]>) => {
        if (down) throw new Error("archive unreachable");
        return inner.listExecutions(...a);
      },
    });
    const warnings: string[] = [];
    const booted = new EraseCoordinator({
      index,
      eventStore: store,
      shred: vi.fn(async () => {}),
      archives: [flaky],
      onWarn: (m) => warnings.push(m),
    });
    await expect(booted.loadParked()).resolves.toBeUndefined(); // does not abort
    expect(booted.pendingSubjects()).toEqual(["dan"]); // the key-window guard's set is loaded
    expect(warnings.join("\n")).toMatch(/archive unreachable/);
    expect(warnings.join("\n")).toMatch(/recoverArchiveRedactions/);
    down = false;
    await expect(booted.recoverRedactions()).resolves.toEqual([]); // retry works
  });
});

describe("reinstateSender is a recorded operator verb (ADR 0139 D22, owner ruling 2026-10-31)", () => {
  it("journals the intent then the completion with who/when and a keyed ref, never the identity", async () => {
    const store = new InMemoryAsyncEventStore();
    const reinstate = vi.fn(async () => ({ reinstated: true, ref: "ref-123", epoch: 1 }));
    const coord = new EraseCoordinator({
      index: new SubjectIndex(subjectOf),
      eventStore: store,
      shred: vi.fn(async () => {}),
      reinstateSender: reinstate,
    });
    const r = await coord.reinstateSender("alice", "t1", { by: "ops-bob" });
    expect(r).toEqual({ reinstated: true, ref: "ref-123", epoch: 1 });
    expect(reinstate).toHaveBeenCalledWith("alice", "t1");
    const journal = await store.read(ERASURE_STREAM);
    expect(journal.map((e) => e.eventType)).toEqual([
      "SENDER_REINSTATE_INTENDED",
      "SENDER_REINSTATED",
    ]);
    expect(journal[1]?.payload).toMatchObject({
      by: "ops-bob",
      tenant: "t1",
      reinstated: true,
      ref: "ref-123",
      epoch: 1,
      intentId: journal[0]?.id,
    });
    expect(typeof (journal[1]?.payload as { at?: unknown }).at).toBe("number");
    expect(JSON.stringify(journal)).not.toContain("alice");
  });

  it("refuses when no reinstater is wired", async () => {
    const coord = new EraseCoordinator({
      index: new SubjectIndex(subjectOf),
      eventStore: new InMemoryAsyncEventStore(),
      shred: vi.fn(async () => {}),
    });
    await expect(coord.reinstateSender("alice")).rejects.toThrow(TypeError);
  });
});
