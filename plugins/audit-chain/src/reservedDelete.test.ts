import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { hashChainedEventStore } from "./hashChain";

// ADR 0139 (review round): `deleteThrough` is gated like `truncatePrefix`. A delete that leaves a survivor
// chains it onto a deleted event, so a hash-chained store offers it only with `allowCompaction`; without it
// the kernel's reserved-stream delete refuses loudly (`ReservedStreamDeleteUnsupportedError`, pinned in
// the workflow-runtime suite) and keeps the stream whole.

const STREAM = "__loom_inbox__:audited";
const env = (seq: number): EventEnvelope => ({
  id: `${STREAM}-${seq}`,
  workflowId: "__loom_inbox__",
  executionId: STREAM,
  eventType: "INBOX_MESSAGE",
  sequence: seq,
  timestamp: 1_000 + seq,
  payload: { topic: "t", messageId: `m${seq}`, payload: seq, sender: {} },
});
const seed = async (store: ReturnType<typeof hashChainedEventStore>, n: number) => {
  for (let i = 0; i < n; i++) await store.append(env(i));
};

describe("hash-chained reserved-stream delete (ADR 0139 deleteThrough gate)", () => {
  it("without allowCompaction the store does NOT offer deleteThrough (so the kernel refuses and keeps the stream whole)", async () => {
    const chained = hashChainedEventStore(new InMemoryAsyncEventStore());
    expect(chained.deleteThrough).toBeUndefined();
    await seed(chained, 3);
    expect((await chained.verifyChain(STREAM)).ok).toBe(true);
  });

  it("with allowCompaction a delete that leaves a remainder is verified ACROSS the gap with the archived envelopes", async () => {
    const chained = hashChainedEventStore(new InMemoryAsyncEventStore(), { allowCompaction: true });
    await seed(chained, 4);
    const before = await chained.read(STREAM);
    // the archive holds 0..2 (the caller's move), a message raced in, and the bounded delete removes 0..2
    await chained.deleteThrough?.(STREAM, 2);
    expect((await chained.read(STREAM)).map((e) => e.sequence)).toEqual([3]);
    // the survivor's prevHash names a deleted event: a plain verify reports the break, truthfully ...
    expect((await chained.verifyChain(STREAM)).ok).toBe(false);
    // ... and verifying over archive u log passes
    expect((await chained.verifyChain(STREAM, { archived: before.slice(0, 3) })).ok).toBe(true);
  });

  it("over an inner store WITHOUT deleteThrough the decorator does not invent one, even with allowCompaction (a typed refusal upstream, never a whole-stream delete)", () => {
    const bare = Object.create(new InMemoryAsyncEventStore()) as InMemoryAsyncEventStore;
    (bare as { deleteThrough?: unknown }).deleteThrough = undefined;
    const chained = hashChainedEventStore(bare, { allowCompaction: true });
    expect(chained.deleteThrough).toBeUndefined();
  });
});
