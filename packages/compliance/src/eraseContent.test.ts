import type { EventEnvelope } from "@loom/core";
import {
  InMemoryArchiveStore,
  InMemoryAsyncEventStore,
  brandPayloadShredded,
  buildReservedSegment,
  buildSegment,
} from "@loom/event-runtime";
import { foldEvents } from "@loom/replay-vm";
import { describe, expect, it, vi } from "vitest";
import { SubjectIndex } from "./SubjectIndex";
import {
  ContentCopiesRemainError,
  ControlStreamKeyError,
  ERASURE_STREAM,
  EraseCoordinator,
} from "./eraseSubject";
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
    expect(r.contentDeleted).toEqual({
      deleted: 2,
      retained: 0,
      sealed: 2,
      foreign: 0,
      unprovable: 0,
    });
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
    expect(r.contentDeleted).toEqual({
      deleted: 1,
      retained: 1,
      sealed: 1,
      foreign: 1,
      unprovable: 0,
    });
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

  // Compliance subject = user; crypto subject = execution (they differ): one data subject spans executions
  // with distinct keys, and a blob put by one is cited first by another.
  async function crossWorld() {
    const store = new InMemoryAsyncEventStore();
    for (const [id, outs] of [
      ["u1", ["x", "y"]], // u1 cites x (put by u2) first, and y (its own)
      ["u2", ["x"]],
      ["z1", ["w"]], // another user's blob, never the subject's
    ] as const) {
      await store.append(
        ev(id, 0, "EXECUTION_STARTED", { input: { userId: id === "z1" ? "zed" : "ann" } })
      );
      let seq = 1;
      for (const a of outs) {
        await store.append(
          ev(id, seq++, "STEP_COMPLETED", { stepId: `${id}#turn:0:tool:0`, output: env(a) })
        );
      }
      await store.append(ev(id, seq, "EXECUTION_COMPLETED", { output: null }));
    }
    const index = SubjectIndex.fromEvents(
      [...(await store.read("u1")), ...(await store.read("u2")), ...(await store.read("z1"))],
      subjectOf
    );
    const blobs = new Map<string, Uint8Array>(
      ["x", "y", "w"].map((a) => [a, new TextEncoder().encode(a)])
    );
    const putBy: Record<string, string> = { x: "u2", y: "u1", w: "z1" };
    const content = {
      sealsContent: true,
      delete: vi.fn(async (ref: { __loomContent: string }) => void blobs.delete(ref.__loomContent)),
      ownedBy: vi.fn(
        async (ref: { __loomContent: string }, access: { executionId: string }) =>
          putBy[ref.__loomContent] === access.executionId
      ),
    };
    return { store, index, blobs, content };
  }

  it("compliance and crypto subjects differ: a blob put by one execution of the subject and first cited by another is DELETED and counted, not foreign (ADR 0143 D5)", async () => {
    const { store, index, blobs, content } = await crossWorld();
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: async () => {},
      content,
    });
    const r = await coord.eraseSubject("ann");
    expect(r.contentDeleted).toEqual({
      deleted: 2,
      retained: 0,
      sealed: 2,
      foreign: 0,
      unprovable: 0,
    });
    expect([...blobs.keys()]).toEqual(["w"]);
  });

  it("a citation-only blob (no execution of the subject put it) stays foreign even with several citers", async () => {
    const { store, index, blobs, content } = await crossWorld();
    // u2 now also cites w, which only z1 (another user) put
    await store.append(
      ev("u2", 5, "STEP_COMPLETED", { stepId: "u2#turn:0:tool:1", output: env("w") })
    );
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: async () => {},
      content,
    });
    const r = await coord.eraseSubject("ann");
    expect(r.contentDeleted).toEqual({
      deleted: 2,
      retained: 1,
      sealed: 2,
      foreign: 1,
      unprovable: 0,
    });
    expect(blobs.has("w")).toBe(true);
  });

  it("a re-erasure whose key is already destroyed journals the cited blobs UNPROVABLE (not foreign) and deletes none (ADR 0143 D5)", async () => {
    const { store, index, blobs, content } = await crossWorld();
    const destroyed = Object.assign(new Error("key destroyed"), {});
    brandPayloadShredded(destroyed);
    const gone = {
      ...content,
      ownedBy: vi.fn(async () => {
        throw destroyed;
      }),
    };
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: async () => {},
      content: gone,
    });
    const r = await coord.eraseSubject("ann");
    expect(r.contentDeleted).toEqual({
      deleted: 0,
      retained: 2,
      sealed: 0,
      foreign: 0,
      unprovable: 2,
    });
    expect(blobs.size).toBe(3);
    const done = (await store.read("__loom_erasure__")).find(
      (e) => e.eventType === "ERASURE_CONTENT_DELETED"
    );
    expect(done?.payload).toMatchObject({ foreign: 0, unprovable: 2 });
  });

  it("a crash after the intent and the shred: the retry deletes the intent's addresses and keeps foreign stable (every proof now throws)", async () => {
    const { store, index, blobs, content } = await crossWorld();
    await store.append(
      ev("u2", 5, "STEP_COMPLETED", { stepId: "u2#turn:0:tool:1", output: env("w") })
    );
    const destroyed = Object.assign(new Error("key destroyed"), {});
    brandPayloadShredded(destroyed);
    let shredded = false;
    let failDelete = true;
    const flaky = {
      ...content,
      ownedBy: vi.fn(async (ref: { __loomContent: string }, access: { executionId: string }) => {
        if (shredded) throw destroyed;
        return content.ownedBy(ref, access);
      }),
      delete: vi.fn(async (ref: { __loomContent: string }) => {
        if (failDelete) throw new Error("store down");
        blobs.delete(ref.__loomContent);
      }),
    };
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: async () => {
        shredded = true;
      },
      content: flaky,
    });
    await expect(coord.eraseSubject("ann")).rejects.toThrow(/store down/);
    expect(blobs.size).toBe(3);
    failDelete = false;
    const r = await coord.eraseSubject("ann");
    expect(r.contentDeleted).toEqual({
      deleted: 2,
      retained: 1,
      sealed: 2,
      foreign: 1,
      unprovable: 0,
    });
    expect([...blobs.keys()]).toEqual(["w"]);
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
    expect(r.contentDeleted).toEqual({
      deleted: 0,
      retained: 0,
      sealed: 2,
      foreign: 0,
      unprovable: 0,
    });
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

// A principal keyed under a pseudonymous subject AND its own id: with `controlStreamKey` erasing both
// leaves no row on the control stream that names either, so the stream cannot pair them.
describe("controlStreamKey keeps subject ids off the erasure control stream", () => {
  const PSEUDO = "anon-7f3c";
  const REAL = "alice@example.com";
  const KEY = "control-stream-secret-0001";
  const OLD_KEY = "control-stream-secret-0000";
  const inbox = (c: string) => `__loom_inbox__:${c}`;
  const msg = (key: string, seq: number, actor: string) => ({
    ...ev(key, seq, "INBOX_MESSAGE", {
      topic: "t",
      messageId: `m${seq}`,
      payload: "x",
      sender: { actor },
    }),
    workflowId: "__loom_inbox__",
  });
  async function principal() {
    const store = new InMemoryAsyncEventStore();
    const blobs = new Map<string, Uint8Array>();
    const put = async (id: string, user: string, address: string, done = true) => {
      blobs.set(address, new TextEncoder().encode(`"${address}"`));
      await store.append(ev(id, 0, "EXECUTION_STARTED", { input: { userId: user } }));
      await store.append(ev(id, 1, "STEP_COMPLETED", { stepId: `${id}#t`, output: env(address) }));
      if (done) await store.append(ev(id, 2, "EXECUTION_COMPLETED", { output: null }));
    };
    await put("p1", PSEUDO, "blob-p");
    await put("r1", REAL, "blob-r");
    const index = SubjectIndex.fromEvents(
      [...(await store.read("p1")), ...(await store.read("r1"))],
      subjectOf
    );
    const archive = new InMemoryArchiveStore();
    for (const id of ["p1", "r1"]) {
      await archive.append(id, buildSegment([ev(id, 1, "STEP_COMPLETED", {})], "inc"));
    }
    // another chain's archived inbox, where both identities sent a message
    const other = inbox("other");
    await archive.append(
      other,
      buildReservedSegment([msg(other, 1, PSEUDO), msg(other, 2, REAL)], "inc")
    );
    let failNextDelete = false;
    const content = {
      delete: vi.fn(async (ref: { __loomContent: string }) => void blobs.delete(ref.__loomContent)),
      get: async (ref: { __loomContent: string }) => blobs.get(ref.__loomContent) ?? null,
      touchClock: async () => 0,
      deleteIfUntouchedSince: async (ref: { __loomContent: string }) => {
        if (failNextDelete) {
          failNextDelete = false;
          throw new Error("store down");
        }
        return blobs.delete(ref.__loomContent);
      },
    };
    const coordinator = (key: string | undefined = KEY, previous?: string[]) =>
      new EraseCoordinator({
        index,
        eventStore: store,
        shred: async () => {},
        content,
        archives: [archive],
        ...(key !== undefined && { controlStreamKey: key }),
        ...(previous !== undefined && { previousControlStreamKeys: previous }),
      });
    return {
      store,
      blobs,
      archive,
      coordinator,
      failNext: () => {
        failNextDelete = true;
      },
    };
  }
  const controlText = async (store: InMemoryAsyncEventStore) =>
    JSON.stringify(await store.read(ERASURE_STREAM));

  it("erasing both subjects (content, archive copies, sender copies) leaves no row naming either", async () => {
    const { store, blobs, archive, coordinator } = await principal();
    const coord = coordinator();
    const a = await coord.eraseSubject(PSEUDO);
    const b = await coord.eraseSubject(REAL);
    expect([a.outcome, b.outcome]).toEqual(["erased", "erased"]);
    expect(a.contentDeleted?.deleted).toBe(1);
    expect(b.archivedCopiesDeleted?.executions).toEqual(["r1"]);
    expect(b.senderRedactions).toEqual([{ streamId: inbox("other"), envelopes: 1 }]);
    expect(blobs.size).toBe(0);
    expect(JSON.stringify(await archive.read(inbox("other")))).not.toContain(REAL);
    const rows = await store.read(ERASURE_STREAM);
    // every kind of subject-naming row was written...
    expect(new Set(rows.map((e) => e.eventType))).toEqual(
      new Set([
        "ERASURE_CONTENT_DELETE_INTENDED",
        "ERASURE_CONTENT_DELETED",
        "ERASURE_ARCHIVE_DELETE_INTENDED",
        "ERASURE_ARCHIVE_DELETED",
        "ERASURE_SENDER_REDACTION_INTENDED",
        "ERASURE_SENDER_REDACTED",
      ])
    );
    // ...and none names either subject: each carries a keyed digest, the same one per subject
    const text = await controlText(store);
    for (const id of [PSEUDO, REAL, "alice", "7f3c"]) expect(text).not.toContain(id);
    const refs = new Set(rows.map((e) => (e.payload as { subjectRef?: string }).subjectRef));
    expect(refs.size).toBe(2);
    for (const r of refs) expect(r).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    for (const e of rows) expect(e.payload).not.toHaveProperty("subjectId");
  });

  it("a crash between INTENDED and DELETED is finished by a RESTARTED coordinator from the keyed intent", async () => {
    const { store, blobs, coordinator, failNext } = await principal();
    failNext();
    await expect(coordinator().eraseSubject(PSEUDO)).rejects.toThrow(/store down/);
    expect(blobs.has("blob-p")).toBe(true);
    const intents = async () =>
      (await store.read(ERASURE_STREAM)).filter(
        (e) => e.eventType === "ERASURE_CONTENT_DELETE_INTENDED"
      );
    expect(await intents()).toHaveLength(1);

    const restarted = coordinator(); // a new process: same key, nothing in memory
    await restarted.loadParked();
    const r = await restarted.eraseSubject(PSEUDO);
    expect(r).toMatchObject({ outcome: "erased", contentDeleted: { deleted: 1 } });
    expect(blobs.has("blob-p")).toBe(false);
    // the retry FOUND the open intent (no second one) and completed it
    expect(await intents()).toHaveLength(1);
    const [intent] = await intents();
    const completed = (await store.read(ERASURE_STREAM)).filter(
      (e) => e.eventType === "ERASURE_CONTENT_DELETED"
    );
    expect(completed.map((e) => (e.payload as { intentId?: string }).intentId)).toEqual([
      intent?.id,
    ]);
    expect(await controlText(store)).not.toContain(PSEUDO);
  });

  it("a PARKED request is a keyed row, restored after a restart, listed, and auto-completed", async () => {
    const store = new InMemoryAsyncEventStore();
    await store.append(ev("live", 0, "EXECUTION_STARTED", { input: { userId: REAL } }));
    const index = SubjectIndex.fromEvents(await store.read("live"), subjectOf);
    const shred = vi.fn(async () => {});
    const make = () =>
      new EraseCoordinator({ index, eventStore: store, shred, controlStreamKey: KEY });
    expect((await make().eraseSubject(REAL)).outcome).toBe("parked");
    const [row] = await store.read(ERASURE_STREAM);
    expect(row?.eventType).toBe("ERASURE_PENDING");
    expect(JSON.stringify(row)).not.toContain(REAL);

    const restarted = make();
    await restarted.loadParked();
    expect(restarted.pendingSubjects()).toEqual([REAL]);
    const done = ev("live", 1, "EXECUTION_COMPLETED", {});
    await store.append(done);
    await restarted.handleEvent(done);
    expect(shred).toHaveBeenCalledWith(REAL, ["live"]);
    expect(restarted.pendingSubjects()).toEqual([]);
  });

  it("a PLAINTEXT row written before the key was set is still honoured (parked and intents)", async () => {
    const { store, blobs, coordinator, failNext } = await principal();
    failNext();
    await expect(coordinator(undefined).eraseSubject(PSEUDO)).rejects.toThrow(/store down/);
    const r = await coordinator().eraseSubject(PSEUDO); // now keyed: resumes the plaintext intent
    expect(r.contentDeleted?.deleted).toBe(1);
    expect(blobs.has("blob-p")).toBe(false);
    expect(
      (await store.read(ERASURE_STREAM)).filter(
        (e) => e.eventType === "ERASURE_CONTENT_DELETE_INTENDED"
      )
    ).toHaveLength(1);

    const s2 = new InMemoryAsyncEventStore();
    await s2.append(ev("live", 0, "EXECUTION_STARTED", { input: { userId: REAL } }));
    const index = SubjectIndex.fromEvents(await s2.read("live"), subjectOf);
    const shred = vi.fn(async () => {});
    await new EraseCoordinator({ index, eventStore: s2, shred }).eraseSubject(REAL); // plaintext park
    const keyed = new EraseCoordinator({ index, eventStore: s2, shred, controlStreamKey: KEY });
    await keyed.loadParked();
    expect(keyed.pendingSubjects()).toEqual([REAL]);
    const done = ev("live", 1, "EXECUTION_COMPLETED", {});
    await s2.append(done);
    await keyed.handleEvent(done);
    expect(shred).toHaveBeenCalledOnce();
  });

  it("a ROTATED key fails closed on an open intent it cannot attribute, and resumes it once the old key is listed", async () => {
    const { store, blobs, coordinator, failNext } = await principal();
    failNext();
    await expect(coordinator(OLD_KEY).eraseSubject(PSEUDO)).rejects.toThrow(/store down/);
    const [intent] = (await store.read(ERASURE_STREAM)).filter(
      (e) => e.eventType === "ERASURE_CONTENT_DELETE_INTENDED"
    );
    // the new key alone cannot tell whose intent it is: refuse rather than re-plan past it
    const err = await coordinator(KEY)
      .eraseSubject(PSEUDO)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlStreamKeyError);
    expect((err as ControlStreamKeyError).intentId).toBe(intent?.id);
    expect((err as ControlStreamKeyError).keyId).toBe((intent?.payload as { keyId: string }).keyId);
    // removing the key altogether fails closed too
    await expect(coordinator(undefined).eraseSubject(PSEUDO)).rejects.toThrow(
      ControlStreamKeyError
    );
    // with the old key listed the open intent is found and completed (no second intent)
    const r = await coordinator(KEY, [OLD_KEY]).eraseSubject(PSEUDO);
    expect(r.contentDeleted?.deleted).toBe(1);
    expect(blobs.has("blob-p")).toBe(false);
    expect(
      (await store.read(ERASURE_STREAM)).filter(
        (e) => e.eventType === "ERASURE_CONTENT_DELETE_INTENDED"
      )
    ).toHaveLength(1);
  });

  it("a parked row under a key the coordinator does not hold is WARNED at loadParked", async () => {
    const store = new InMemoryAsyncEventStore();
    await store.append(ev("live", 0, "EXECUTION_STARTED", { input: { userId: REAL } }));
    const index = SubjectIndex.fromEvents(await store.read("live"), subjectOf);
    const shred = vi.fn(async () => {});
    await new EraseCoordinator({
      index,
      eventStore: store,
      shred,
      controlStreamKey: OLD_KEY,
    }).eraseSubject(REAL);
    const warnings: string[] = [];
    const rotated = new EraseCoordinator({
      index,
      eventStore: store,
      shred,
      controlStreamKey: KEY,
      onWarn: (m) => warnings.push(m),
    });
    await rotated.loadParked();
    expect(warnings.join("\n")).toMatch(/does not hold/);
    const listed = new EraseCoordinator({
      index,
      eventStore: store,
      shred,
      controlStreamKey: KEY,
      previousControlStreamKeys: [OLD_KEY],
      onWarn: (m) => warnings.push(m),
    });
    const before = warnings.length;
    await listed.loadParked();
    expect(warnings).toHaveLength(before);
    expect(listed.pendingSubjects()).toEqual([REAL]);
  });

  it("refuses a short key, and previous keys without a current one", () => {
    const store = new InMemoryAsyncEventStore();
    const index = SubjectIndex.fromEvents([], subjectOf);
    const base = { index, eventStore: store, shred: async () => {} };
    expect(() => new EraseCoordinator({ ...base, controlStreamKey: "" })).toThrow(
      /at least 16 bytes/
    );
    expect(() => new EraseCoordinator({ ...base, controlStreamKey: "short" })).toThrow(
      /at least 16/
    );
    expect(
      () =>
        new EraseCoordinator({ ...base, controlStreamKey: KEY, previousControlStreamKeys: ["x"] })
    ).toThrow(/at least 16/);
    expect(() => new EraseCoordinator({ ...base, previousControlStreamKeys: [KEY] })).toThrow(
      /needs a controlStreamKey/
    );
    expect(
      () => new EraseCoordinator({ ...base, controlStreamKey: new Uint8Array(16) })
    ).not.toThrow();
  });

  it("a TENANT is not written either, and one subject id in two tenants gets two digests", async () => {
    const store = new InMemoryAsyncEventStore();
    const tenantOf = (e: EventEnvelope) =>
      (e.payload as { input?: { tenant?: string } }).input?.tenant;
    for (const [id, tenant] of [
      ["t-a", "acme-corp"],
      ["t-b", "globex-inc"],
    ] as const) {
      await store.append(ev(id, 0, "EXECUTION_STARTED", { input: { userId: REAL, tenant } }));
    }
    const index = SubjectIndex.fromEvents(
      [...(await store.read("t-a")), ...(await store.read("t-b"))],
      subjectOf,
      { tenantOf }
    );
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: async () => {},
      controlStreamKey: KEY,
    });
    expect((await coord.eraseSubject(REAL, "acme-corp")).outcome).toBe("parked");
    expect((await coord.eraseSubject(REAL, "globex-inc")).outcome).toBe("parked");
    const rows = await store.read(ERASURE_STREAM);
    const text = JSON.stringify(rows);
    for (const id of [REAL, "acme-corp", "globex-inc"]) expect(text).not.toContain(id);
    const refs = rows.map((e) => (e.payload as { subjectRef: string }).subjectRef);
    expect(new Set(refs).size).toBe(2);
  });
});
