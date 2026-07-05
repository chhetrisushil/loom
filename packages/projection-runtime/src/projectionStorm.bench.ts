import type { EventEnvelope } from "@loom/core";
import { bench, describe } from "vitest";
import { InMemoryProjectionRuntime } from "./InMemoryProjectionRuntime";

// ── Projection storm baseline ─────────────────────────────────────────────────
// Streaming (e.g. LLM token-by-token) produces one event per token. Today each
// event synchronously notifies subscribers, so a subscriber fires once per event.
// This bench captures the pre-coalescing baseline: wall time AND subscriber-call
// count for a burst of N events. Phase 4 coalescing should keep this wall time
// flat (or better) while collapsing subscriber calls from O(events) to
// O(microtask flushes).

const EXECUTION_ID = "exec-1";
const PROJECTION_ID = "counter";

function makeRuntime(coalesce = false) {
  const runtime = new InMemoryProjectionRuntime({ coalesceNotifications: coalesce });
  runtime.register<{ count: number }>({
    id: PROJECTION_ID,
    initialState: { count: 0 },
    handlers: {
      TICK: (state) => ({ count: state.count + 1 }),
    },
  });
  return runtime;
}

function makeEvent(sequence: number): EventEnvelope {
  return {
    id: `e${sequence}`,
    workflowId: "wf",
    executionId: EXECUTION_ID,
    eventType: "TICK",
    sequence,
    timestamp: 0,
    payload: null,
  };
}

for (const burst of [100, 1000]) {
  describe(`projection storm / ${burst} events`, () => {
    const events = Array.from({ length: burst }, (_unused, i) => makeEvent(i));

    bench("handleEvent burst — synchronous notify (baseline)", () => {
      const runtime = makeRuntime(false);
      let notifications = 0;
      runtime.subscribe(PROJECTION_ID, EXECUTION_ID, () => {
        notifications++;
      });
      for (const event of events) runtime.handleEvent(event);
      // notifications === burst (per-event notify).
      void notifications;
    });

    bench("handleEvent burst — coalesced notify", async () => {
      const runtime = makeRuntime(true);
      let notifications = 0;
      runtime.subscribe(PROJECTION_ID, EXECUTION_ID, () => {
        notifications++;
      });
      for (const event of events) runtime.handleEvent(event);
      // Flush the coalesced microtask; notifications collapses to 1.
      await Promise.resolve();
      void notifications;
    });
  });
}
