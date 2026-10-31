import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
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
  const content = {
    delete: vi.fn(async (ref: { __loomContent: string }) => void blobs.delete(ref.__loomContent)),
    get: async (ref: { __loomContent: string }) => blobs.get(ref.__loomContent) ?? null,
  };
  return { store, index, blobs, content };
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
      delete: async (ref: { __loomContent: string }) => {
        if (calls++ === 0) throw new Error("store down");
        blobs.delete(ref.__loomContent);
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

  it("a store that seals per subject needs nothing: the shred erases it", async () => {
    const { store, index, content } = await world();
    const coord = new EraseCoordinator({
      index,
      eventStore: store,
      shred: async () => {},
      content: { ...content, sealsContent: true },
    });
    const r = await coord.eraseSubject("ann");
    expect(r.contentDeleted).toBeUndefined();
    expect(content.delete).not.toHaveBeenCalled();
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
