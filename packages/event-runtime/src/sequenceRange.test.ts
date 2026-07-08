import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { InMemoryAsyncEventStore } from "./InMemoryAsyncEventStore";
import { lowerBoundBySequence, sliceBySequence } from "./sequenceRange";
import { type EventStore, readRangeOf } from "./types";

function ev(sequence: number): EventEnvelope {
  return {
    id: `x-${sequence}`,
    workflowId: "wf",
    executionId: "x",
    eventType: "STEP_STARTED",
    sequence,
    timestamp: sequence,
    payload: {},
  };
}

const seqs = (events: EventEnvelope[]): number[] => events.map((e) => e.sequence);

describe("sequenceRange helpers", () => {
  const events = [0, 1, 2, 5, 6, 9].map(ev);

  it("lowerBoundBySequence finds the first index >= seq", () => {
    expect(lowerBoundBySequence(events, 0)).toBe(0);
    expect(lowerBoundBySequence(events, 3)).toBe(3); // first with sequence >= 3 is `5`
    expect(lowerBoundBySequence(events, 9)).toBe(5);
    expect(lowerBoundBySequence(events, 10)).toBe(6); // past the end
  });

  it("sliceBySequence returns the inclusive [from..to] window", () => {
    expect(seqs(sliceBySequence(events, 2, 6))).toEqual([2, 5, 6]);
    expect(seqs(sliceBySequence(events, 0, 0))).toEqual([0]);
    expect(seqs(sliceBySequence(events, 3, 4))).toEqual([]); // gap
    expect(seqs(sliceBySequence(events, 0, 100))).toEqual([0, 1, 2, 5, 6, 9]);
  });

  it("sliceBySequence is empty when to < from", () => {
    expect(sliceBySequence(events, 6, 2)).toEqual([]);
  });
});

describe("InMemoryAsyncEventStore range reads", () => {
  it("readRange / readFrom return sequence-ordered windows", async () => {
    const store = new InMemoryAsyncEventStore();
    for (const s of [0, 1, 2, 3, 4]) await store.append(ev(s));

    expect(seqs(await store.readRange("x", 1, 3))).toEqual([1, 2, 3]);
    expect(seqs(await store.readFrom("x", 2))).toEqual([2, 3, 4]);
    expect(seqs(await store.read("x"))).toEqual([0, 1, 2, 3, 4]);
    expect(await store.readRange("x", 3, 1)).toEqual([]);
  });

  it("keeps the log sorted even when an event arrives out of order", async () => {
    const store = new InMemoryAsyncEventStore();
    for (const s of [0, 1, 4, 2, 3]) await store.append(ev(s)); // 2,3 arrive late
    expect(seqs(await store.read("x"))).toEqual([0, 1, 2, 3, 4]);
    expect(seqs(await store.readRange("x", 1, 3))).toEqual([1, 2, 3]);
  });

  it("readRangeOf falls back correctly for stores without readRange", async () => {
    const store = new InMemoryAsyncEventStore();
    for (const s of [0, 1, 2, 3]) await store.append(ev(s));
    // A store lacking the fast-path: readRangeOf must fall back to readFrom + slice.
    const noRange: EventStore = {
      append: (e) => store.append(e),
      read: (id) => store.read(id),
      readFrom: (id, from) => store.readFrom(id, from),
      subscribe: (id, h) => store.subscribe(id, h),
      close: () => store.close(),
    };
    expect(seqs(await readRangeOf(noRange, "x", 1, 2))).toEqual([1, 2]);
  });
});
