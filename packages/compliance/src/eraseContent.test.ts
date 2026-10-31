import type { EventEnvelope } from "@loom/core";
import {
  InMemoryArchiveStore,
  InMemoryAsyncEventStore,
  brandPayloadShredded,
  buildSegment,
} from "@loom/event-runtime";
import { foldEvents } from "@loom/replay-vm";
import { describe, expect, it, vi } from "vitest";
import { SubjectIndex } from "./SubjectIndex";
import { ContentCopiesRemainError, ERASURE_STREAM, EraseCoordinator } from "./eraseSubject";
import { exportSubject } from "./exportSubject";

// ADR 0140 D8 - erasure reaches the claim-checked blobs a plaintext content store holds.

const subjectOf = (e: EventEnvelope): string | undefined =>
  e.eventType === "EXECUTION_STARTED"
    ? (e.payload as { input?: { userId?: string } }).input?.userId
    : undefined;

const env = (address: string) => ({
  __loomClaimCheck: true,
  ref: { __loomContent: address },
  size: 5000,
});

function ev(id: string, seq: number, eventType: string, payload: unknown): EventEnvelope {
  return {
    id: `${id}-${seq}`,
    workflowId: "wf",
    executionId: id,
    eventType,
    sequence: seq,
    timestamp: 1000 + seq,
    payload,
  };
}

async function world() {
  const store = new InMemoryAsyncEventStore();
  const put = async (id: string, user: string, outputs: string[]) => {
    await store.append(ev(id, 0, "EXECUTION_STARTED", { input: { userId: user } }));
    let seq = 1;
    for (const a of outputs) {
      await store.append(
        ev(id, seq++, "STEP_COMPLETED", { stepId: `${id}#turn:0:tool:0`, output: env(a) })
      );
    }
    await store.append(ev(id, seq, "EXECUTION_COMPLETED", { output: null }));
  };
  await put("a1", "ann", ["own", "shared"]);
  await put("b1", "bob", ["shared"]);
  const index = SubjectIndex.fromEvents(
    [...(await store.read("a1")), ...(await store.read("b1"))],
    subjectOf
  );
  const blobs = new Map<string, Uint8Array>(
    ["own", "shared"].map((a) => [a, new TextEncoder().encode(`"${a}"`)])
  );
  // SPI 1.3.0 conditional delete: a `touch` after the plan's cutoff spares the blob.
  let clock = 0;
  const touched = new Map<string, number>();
  const content = {
    delete: vi.fn(async (ref: { __loomContent: string }) => void blobs.delete(ref.__loomContent)),
    get: async (ref: { __loomContent: string }) => blobs.get(ref.__loomContent) ?? null,
    touchClock: async () => ++clock,
    touch: (address: string) => void touched.set(address, ++clock),
    deleteIfUntouchedSince: async (ref: { __loomContent: string }, cutoff: number) => {
      if ((touched.get(ref.__loomContent) ?? 0) > cutoff) return false;
      return blobs.delete(ref.__loomContent);
    },
  };
  return { store, index, blobs, content, put };
}

describe("EraseCoordinator over a plaintext content store (ADR 0140)", () => {
  it("deletes only blobs no other execution cites, intent before completion", async () => {
    const { store, index, blobs, content } = await world();
    const shred = vi.fn(async () => {});
    const coord = new EraseCoordinator({ index, eventStore: store, shred, content });
    const r = await coord.eraseSubject("ann");
    expect(r.contentDeleted).toEqual({ deleted: 1, retained: 1 });
    expect([...blobs.keys()]).toEqual(["shared"]);
    const types = (await store.read(ERASURE_STREAM)).map((e) => e.eventType);
    expect(types).toEqual(["ERASURE_CONTENT_DELETE_INTENDED", "ERASURE_CONTENT_DELETED"]);
  });

  it("REFUSES before the shred when blobs are cited and no content store is wired", async () => {
    const { store, index } = await world();
    const shred = vi.fn(async () => {});
    const coord = new EraseCoordinator({ index, eventStore: store, shred });
    await expect(coord.eraseSubject("ann")).rejects.toThrow(ContentCopiesRemainError);
    expect(shred).not.toHaveBeenCalled();
  });

  it("REFUSES before the shred when the event store cannot be enumerated", async () => {
    const { store, index, content } = await world();
    const shred = vi.fn(async () => {});
    const noList = { read: store.read.bind(store), append: store.append.bind(store) };
    const coord = new EraseCoordinator({ index, eventStore: noList, shred, content });
    await expect(coord.eraseSubject("ann")).rejects.toThrow(/cannot be enumerated/);
    expect(shred).not.toHaveBeenCalled();
    expect(content.delete).not.toHaveBeenCalled();
  });

  it("a crash after the shred is finished by the retry from the journaled intent", async () => {
    const { store, index, blobs, content } = await world();
    let calls = 0;
    const flaky = {
      ...content,
      deleteIfUntouchedSince: async (ref: { __loomContent: string }) => {
        if (calls++ === 0) throw new Error("store down");
        return blobs.delete(ref.__loomContent);
      },
    };
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: async () => {},
      content: flaky,
    });
    await expect(coord.eraseSubject("ann")).rejects.toThrow(/store down/);
    expect(blobs.has("own")).toBe(true);
    const r = await coord.eraseSubject("ann");
    expect(r.contentDeleted?.deleted).toBe(1);
    expect(blobs.has("own")).toBe(false);
  });

  it("REFUSES before the shred when the store lacks the conditional delete: never an unconditional delete of a shared-addressable blob", async () => {
    const { store, index, blobs, content } = await world();
    const shred = vi.fn(async () => {});
    for (const missing of ["deleteIfUntouchedSince", "touchClock"] as const) {
      const partial = { ...content, [missing]: undefined };
      const coord = new EraseCoordinator({ index, eventStore: store, shred, content: partial });
      await expect(coord.eraseSubject("ann")).rejects.toThrow(/deleteIfUntouchedSince/);
    }
    expect(shred).not.toHaveBeenCalled();
    expect(content.delete).not.toHaveBeenCalled();
    expect([...blobs.keys()].sort()).toEqual(["own", "shared"]);
  });

  it("a blob re-put (cited) between the plan and the delete is KEPT and counted retained", async () => {
    const { store, index, blobs, content } = await world();
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: async () => content.touch("own"), // another execution cites "own" after the plan
      content,
    });
    const r = await coord.eraseSubject("ann");
    expect(r.contentDeleted).toEqual({ deleted: 0, retained: 2 });
    expect(blobs.has("own")).toBe(true);
    expect(content.delete).not.toHaveBeenCalled();
  });

  it("a NESTED lookalike envelope in another execution's tool output is NOT a citation (ADR 0140 D11)", async () => {
    const { store, index, blobs, content, put } = await world();
    // carol's unlisted tool returned data that merely LOOKS like a retained envelope for ann's blob
    await store.append(ev("c1", 0, "EXECUTION_STARTED", { input: { userId: "carol" } }));
    await store.append(
      ev("c1", 1, "STEP_COMPLETED", {
        stepId: "c1#turn:0:tool:0",
        output: { rows: [{ ...env("own"), retain: true }] },
      })
    );
    void put;
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: async () => {},
      content,
    });
    const r = await coord.eraseSubject("ann");
    expect(r.contentDeleted).toEqual({ deleted: 1, retained: 1 }); // "own" deleted, "shared" kept
    expect(blobs.has("own")).toBe(false);
  });

  it("an envelope at the TOP of another execution's step output still counts (control)", async () => {
    const { store, index, blobs, content } = await world();
    await store.append(ev("c1", 0, "EXECUTION_STARTED", { input: { userId: "carol" } }));
    await store.append(
      ev("c1", 1, "STEP_COMPLETED", {
        stepId: "c1#turn:0:tool:0",
        output: { __loomTainted: { origin: "mcp:x" }, value: env("own") },
      })
    );
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: async () => {},
      content,
    });
    const r = await coord.eraseSubject("ann");
    expect(r.contentDeleted).toEqual({ deleted: 0, retained: 2 });
    expect(blobs.has("own")).toBe(true);
  });

  // ADR 0143 D5: a sealing store proves OWNERSHIP of each cited blob; a citation alone deletes nothing.
  const sealing = (
    content: Awaited<ReturnType<typeof world>>["content"],
    owned: ReadonlySet<string>
  ) => ({
    ...content,
    sealsContent: true,
    ownedBy: vi.fn(async (ref: { __loomContent: string }) => owned.has(ref.__loomContent)),
  });

  it("a store that seals per subject (ADR 0143): the shred erases what the subject OWNS; the erasure RECORDS it and deletes the ciphertext", async () => {
    const { store, index, content, blobs } = await world();
    const order: string[] = [];
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: async () => void order.push("shred"),
      content: sealing(content, new Set(["own", "shared"])),
    });
    const r = await coord.eraseSubject("ann");
    // no owner-set scan and no conditional delete: sealed addresses are subject-scoped
    expect(r.contentDeleted).toEqual({ deleted: 2, retained: 0, sealed: 2, foreign: 0 });
    expect(content.delete).toHaveBeenCalledTimes(2);
    expect(blobs.size).toBe(0);
    const control = (await store.read("__loom_erasure__")).map((e) => e.eventType);
    expect(control).toContain("ERASURE_CONTENT_DELETE_INTENDED");
    expect(control.indexOf("ERASURE_CONTENT_DELETE_INTENDED")).toBeLessThan(
      control.indexOf("ERASURE_CONTENT_DELETED")
    );
  });

  it("a cited blob the subject does NOT own is never deleted and is journaled retained/foreign (ADR 0143 D5)", async () => {
    const { store, index, content, blobs } = await world();
    const sealed = sealing(content, new Set(["own"])); // "shared" is cited, but another subject's
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: async () => {},
      content: sealed,
    });
    const r = await coord.eraseSubject("ann");
    expect(r.contentDeleted).toEqual({ deleted: 1, retained: 1, sealed: 1, foreign: 1 });
    expect(blobs.has("shared")).toBe(true);
    expect(blobs.has("own")).toBe(false);
    // the proof ran under the CITING execution (its subject), before the shred
    expect(sealed.ownedBy).toHaveBeenCalledWith(
      { __loomContent: "shared" },
      { executionId: "a1", workflowId: "wf" }
    );
    const done = (await store.read("__loom_erasure__")).find(
      (e) => e.eventType === "ERASURE_CONTENT_DELETED"
    );
    expect(done?.payload).toMatchObject({ deleted: 1, retained: 1, foreign: 1 });
  });

  it("a sealing store WITHOUT ownedBy is refused before the shred when the subject cites a blob (fail closed)", async () => {
    const { store, index, content, blobs } = await world();
    const shred = vi.fn(async () => {});
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred,
      content: { ...content, sealsContent: true },
    });
    await expect(coord.eraseSubject("ann")).rejects.toBeInstanceOf(ContentCopiesRemainError);
    expect(shred).not.toHaveBeenCalled();
    expect(blobs.size).toBe(2);
  });

  it("an undecidable proof (key not on this node) fails the erasure loudly, nothing shredded", async () => {
    const { store, index, content } = await world();
    const shred = vi.fn(async () => {});
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred,
      content: {
        ...content,
        sealsContent: true,
        ownedBy: async () => {
          throw new Error("key unavailable");
        },
      },
    });
    await expect(coord.eraseSubject("ann")).rejects.toThrow(/key unavailable/);
    expect(shred).not.toHaveBeenCalled();
  });

  it("a sealing store that cannot delete: erasure completes and records the sealed blobs, deleting none", async () => {
    const { store, index } = await world();
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: async () => {},
      content: { sealsContent: true, ownedBy: async () => true } as never,
    });
    const r = await coord.eraseSubject("ann");
    expect(r.contentDeleted).toEqual({ deleted: 0, retained: 0, sealed: 2, foreign: 0 });
  });

  it("a subject with no claim-checked blobs records nothing over a sealing store", async () => {
    const { store, index, content } = await world();
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: async () => {},
      content: { ...content, sealsContent: true },
    });
    const r = await coord.eraseSubject("nobody-here");
    expect(r.contentDeleted).toBeUndefined();
  });
});

describe("exportSubject resolves claim-checked blobs (ADR 0140)", () => {
  it("returns the value behind each envelope, and marks an absent blob missing", async () => {
    const { store, index, blobs, content } = await world();
    blobs.delete("shared");
    const out = await exportSubject("ann", { index, eventStore: store, content });
    expect(out.executions[0]?.claimChecked).toEqual([
      { address: "own", size: 5000, value: "own" },
      { address: "shared", size: 5000, missing: true },
    ]);
  });
});

describe("exportSubject over a sealing store (ADR 0143)", () => {
  it("passes the owning execution, reads a blob whose key is destroyed as missing, and keeps other failures loud", async () => {
    const { store, index } = await world();
    const seen: unknown[] = [];
    const shredded = Object.assign(new Error("key destroyed"), {});
    brandPayloadShredded(shredded);
    const content = {
      get: async (ref: { __loomContent: string }, access?: unknown) => {
        seen.push(access);
        if (ref.__loomContent === "own") throw shredded;
        return new TextEncoder().encode('"shared"');
      },
    };
    const out = await exportSubject("ann", { index, eventStore: store, content });
    expect(seen).toEqual([
      { executionId: "a1", workflowId: "wf" },
      { executionId: "a1", workflowId: "wf" },
    ]);
    expect(out.executions[0]?.claimChecked).toEqual([
      { address: "own", size: 5000, missing: true },
      { address: "shared", size: 5000, value: "shared" },
    ]);
    const broken = { get: async () => Promise.reject(new Error("blob did not open")) };
    await expect(
      exportSubject("ann", { index, eventStore: store, content: broken })
    ).rejects.toThrow(/did not open/);
  });
});

describe("ref collection reaches archives and snapshots (ADR 0140 D8)", () => {
  const completed = (id: string, seq: number, address: string) =>
    ev(id, seq, "STEP_COMPLETED", { stepId: `${id}#turn:0:tool:0`, output: env(address) });
  async function base() {
    const store = new InMemoryAsyncEventStore();
    const blobs = new Map<string, Uint8Array>(
      ["arch", "snap", "other-snap", "other-arch"].map((a) => [a, new TextEncoder().encode(a)])
    );
    let clock = 0;
    const content = {
      delete: vi.fn(async (ref: { __loomContent: string }) => void blobs.delete(ref.__loomContent)),
      touchClock: async () => ++clock,
      deleteIfUntouchedSince: async (ref: { __loomContent: string }) =>
        blobs.delete(ref.__loomContent),
    };
    return { store, blobs, content };
  }
  const seed = async (store: InMemoryAsyncEventStore, id: string, user: string) => {
    await store.append(ev(id, 0, "EXECUTION_STARTED", { input: { userId: user } }));
    await store.append(ev(id, 1, "EXECUTION_COMPLETED", { output: null }));
  };

  it("deletes a blob only the subject's ARCHIVE SEGMENT cites, keeps one another execution's archive cites", async () => {
    const { store, blobs, content } = await base();
    await seed(store, "a1", "ann");
    await seed(store, "b1", "bob");
    const archive = new InMemoryArchiveStore();
    await archive.append(
      "a1",
      buildSegment([completed("a1", 2, "arch"), completed("a1", 3, "other-arch")], "inc")
    );
    await archive.append("b1", buildSegment([completed("b1", 2, "other-arch")], "inc"));
    const index = SubjectIndex.fromEvents(
      [...(await store.read("a1")), ...(await store.read("b1"))],
      subjectOf
    );
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: async () => {},
      content,
      archives: [archive],
    });
    const r = await coord.eraseSubject("ann");
    expect(r.contentDeleted).toEqual({ deleted: 1, retained: 1 });
    expect(blobs.has("arch")).toBe(false);
    expect(blobs.has("other-arch")).toBe(true);
  });

  it("deletes a blob only the subject's SNAPSHOT cites; another execution's snapshot-only cite keeps its blob", async () => {
    const { store, blobs, content } = await base();
    await seed(store, "a1", "ann");
    await seed(store, "b1", "bob"); // bob's step history is gone: his checkpoint is the sole evidence
    const withVars = (id: string, address: string) => ({
      ...foldEvents(
        [ev(id, 0, "EXECUTION_STARTED", { input: {} }), ev(id, 1, "EXECUTION_COMPLETED", {})],
        {
          executionId: id,
        }
      ),
      executionId: id,
      workflowId: "wf",
      variables: { out: env(address) },
    });
    const snapshotStore = {
      loadLatest: async (id: string) =>
        id === "a1"
          ? { sequence: 1, state: withVars("a1", "snap") }
          : id === "b1"
            ? { sequence: 1, state: withVars("b1", "other-snap") }
            : null,
    };
    const index = SubjectIndex.fromEvents(
      [...(await store.read("a1")), ...(await store.read("b1"))],
      subjectOf
    );
    // ann also cites "other-snap" in her snapshot, so bob's snapshot-only cite must keep it
    const both = {
      loadLatest: async (id: string) => {
        const r = await snapshotStore.loadLatest(id);
        if (id === "a1" && r !== null) {
          return {
            ...r,
            state: { ...r.state, variables: { out: env("snap"), also: env("other-snap") } },
          };
        }
        return r;
      },
    };
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      snapshotStore: both,
      shred: async () => {},
      content,
    });
    const r = await coord.eraseSubject("ann");
    expect(r.contentDeleted).toEqual({ deleted: 1, retained: 1 });
    expect(blobs.has("snap")).toBe(false);
    expect(blobs.has("other-snap")).toBe(true);
  });

  it("an OPAQUE (sealed, key gone) snapshot of another execution cites nothing readable: pinned behaviour", async () => {
    const { store, blobs, content } = await base();
    await seed(store, "a1", "ann");
    await store.append(
      ev("a1", 2, "STEP_COMPLETED", { stepId: "a1#turn:0:tool:0", output: env("snap") })
    );
    await seed(store, "b1", "bob");
    const snapshotStore = {
      loadLatest: async (id: string) => {
        if (id === "b1") throw brandPayloadShredded(new Error("PayloadShreddedError: key gone"));
        return null;
      },
      loadLatestSealed: async (id: string) =>
        id === "b1" ? { sequence: 1, state: { __loomEnc: "ciphertext" } as never } : null,
    };
    const index = SubjectIndex.fromEvents(
      [...(await store.read("a1")), ...(await store.read("b1"))],
      subjectOf
    );
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      snapshotStore,
      shred: async () => {},
      content,
    });
    const r = await coord.eraseSubject("ann");
    expect(r.outcome).toBe("erased");
    expect(blobs.has("snap")).toBe(false); // nothing readable cites it, so it is deleted
  });
});
