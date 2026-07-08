import type { EventEnvelope } from "@loom/core";
import { bench, describe } from "vitest";
import { InMemoryAsyncEventStore } from "./InMemoryAsyncEventStore";
import { sliceBySequence } from "./sequenceRange";

// The fork/materialize hot path: extract a bounded [from..to] window from a long,
// sequence-sorted log. The baselines are the previous O(n) shapes (a `.filter`, and
// read()+sort()+filter) so the binary-search win is visible on a large history.

function ev(sequence: number): EventEnvelope {
  return {
    id: `e-${sequence}`,
    workflowId: "wf",
    executionId: "x",
    eventType: "STEP_STARTED",
    sequence,
    timestamp: sequence,
    payload: {},
  };
}

const N = 100_000;
const events = Array.from({ length: N }, (_, i) => ev(i));
// Fork early in the history — the pathological case for a full scan.
const FROM = 100;
const TO = 200;

describe("bounded range over a 100k-event log", () => {
  bench("filter baseline (previous shape)", () => {
    events.filter((e) => e.sequence >= FROM && e.sequence <= TO);
  });

  bench("sliceBySequence (binary search)", () => {
    sliceBySequence(events, FROM, TO);
  });
});

describe("InMemoryAsyncEventStore range read (100k events)", () => {
  const store = new InMemoryAsyncEventStore();
  // Prime the store once outside the measured loop.
  for (let i = 0; i < N; i++) void store.append(ev(i));

  bench("read()+sort()+filter baseline (previous shape)", async () => {
    const all = [...(await store.read("x"))].sort((a, b) => a.sequence - b.sequence);
    all.filter((e) => e.sequence >= FROM && e.sequence <= TO);
  });

  bench("readRange (binary search, no sort)", async () => {
    await store.readRange("x", FROM, TO);
  });
});
