import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { bench, describe } from "vitest";
import { faultInjectingStore } from "./faultStore";
import { splitmix64 } from "./rng";

// DST's production overhead is ZERO by construction — no runtime package imports it.
// This bench characterizes the HARNESS's own per-append cost so it's measured, not
// assumed (the L4 maturity bar). With an empty fault model the wrapper adds a bounded
// constant per append (a counter increment + two undefined-model lookups + one async
// frame) and never touches the rng. Absolute hz are machine-relative; what matters is
// that the cost is a small constant factor, not growth with log size.

const env = (i: number): EventEnvelope => ({
  id: `e-${i}`,
  workflowId: "w",
  executionId: "bench",
  eventType: "STEP_COMPLETED",
  sequence: i,
  timestamp: i,
  payload: { stepId: "s" },
});

describe("faultInjectingStore append overhead", () => {
  bench("bare InMemoryAsyncEventStore", async () => {
    const store = new InMemoryAsyncEventStore();
    for (let i = 0; i < 100; i++) await store.append(env(i));
  });

  bench("faultInjectingStore (empty model)", async () => {
    const inner = new InMemoryAsyncEventStore();
    const fis = faultInjectingStore(inner, { mode: "explore", rng: splitmix64(1n), model: {} });
    for (let i = 0; i < 100; i++) await fis.store.append(env(i));
  });
});
