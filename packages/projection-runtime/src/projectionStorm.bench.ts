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

// ── Selector fan-out ──────────────────────────────────────────────────────────
// A dashboard with W widgets bound to distinct slices of one projection. When a
// single slice changes, whole-state `subscribe` invokes ALL W handlers (each then
// diffs its own slice DOWNSTREAM — e.g. a React getSnapshot + scheduler ping);
// slice-scoped `subscribeSelector` invokes only the ONE whose slice changed.
//
// Honest reading of this bench: it measures RUNTIME dispatch cost only (setup is
// hoisted out of the timed fn). At the runtime level the selector path is not
// cheaper — it evaluates W selectors + W equality checks to decide whom to wake,
// versus whole-state calling W (here no-op) handlers — so expect roughly comparable
// (often modestly slower) wall time. The actual payoff is the DOWNSTREAM handler-
// invocation count, W → (changed slices), which this micro-bench cannot see and the
// unit tests assert directly. This bench exists to prove the filtering overhead
// stays bounded, not to claim a runtime speedup.

const WIDE_PROJECTION = "wide";

function makeWideRuntime(widgetCount: number) {
  const runtime = new InMemoryProjectionRuntime();
  const initialState: Record<string, number> = {};
  for (let i = 0; i < widgetCount; i++) initialState[`w${i}`] = 0;
  runtime.register<Record<string, number>>({
    id: WIDE_PROJECTION,
    initialState,
    // BUMP increments exactly one field, named in the event payload.
    handlers: {
      BUMP: (state, event) => {
        const field = (event.payload as { field: string }).field;
        return { ...state, [field]: (state[field] ?? 0) + 1 };
      },
    },
  });
  return runtime;
}

function bumpEvent(sequence: number, field: string): EventEnvelope {
  return {
    id: `b${sequence}`,
    workflowId: "wf",
    executionId: EXECUTION_ID,
    eventType: "BUMP",
    sequence,
    timestamp: 0,
    payload: { field },
  };
}

for (const widgets of [100, 1000]) {
  describe(`selector fan-out / ${widgets} widgets — dispatch cost (setup hoisted)`, () => {
    // Setup once at collection time — NOT inside the timed fn — so the bench reflects
    // per-dispatch cost, not the O(W) cost of wiring up subscriptions.
    const wholeStateRuntime = makeWideRuntime(widgets);
    for (let i = 0; i < widgets; i++) {
      wholeStateRuntime.subscribe(WIDE_PROJECTION, EXECUTION_ID, () => {});
    }

    const selectorRuntime = makeWideRuntime(widgets);
    for (let i = 0; i < widgets; i++) {
      const field = `w${i}`;
      selectorRuntime.subscribeSelector<Record<string, number>, number>(
        WIDE_PROJECTION,
        EXECUTION_ID,
        (state) => state[field] ?? 0,
        () => {}
      );
    }

    let seq = 0;

    bench("whole-state subscribe — invokes all W handlers per dispatch", () => {
      wholeStateRuntime.handleEvent(bumpEvent(seq++, "w0"));
    });

    bench("subscribeSelector — invokes only the changed handler per dispatch", () => {
      selectorRuntime.handleEvent(bumpEvent(seq++, "w0"));
    });
  });
}
