import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { ReplayVM } from "./ReplayVM";
import { EVENT_SCHEMA_VERSION } from "./eventHandlers";
import { foldEvents } from "./foldEvents";

// ── 1.19.0 (ADR 0102) — the `_flowEmits` fold key ──────────────────────────────
//
// A flow-level emit is stamped `metadata.flowEmit = ordinal`; the fold keeps
// `_flowEmits = max(prev, ordinal + 1)` so a re-run knows how many of its emits
// the log already holds. Generic over event TYPE (a domain event has no handler),
// keyed only on the stamp — an unstamped log folds exactly as before.

function ev(
  sequence: number,
  eventType: string,
  payload: unknown = {},
  metadata?: Record<string, unknown>
): EventEnvelope {
  return {
    id: `x-${sequence}`,
    workflowId: "wf",
    executionId: "x",
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
    ...(metadata !== undefined && { metadata }),
  };
}

describe("_flowEmits fold (EVENT_SCHEMA 1.19.0, ADR 0102)", () => {
  it("declares 1.19.0", () => {
    expect(EVENT_SCHEMA_VERSION).toBe("1.19.0");
  });

  it("counts stamped emits of ANY type, including types the fold has no handler for", () => {
    const state = foldEvents([
      ev(0, "EXECUTION_STARTED", { input: {} }),
      ev(1, "response.committed", { m: 1 }, { flowEmit: 0 }),
      ev(2, "SURFACE_PATCH", { patches: [] }, { flowEmit: 1, fence: 3 }),
    ]);
    expect(state.variables._flowEmits).toBe(2);
  });

  it("is a high-water mark, never a decrement", () => {
    const state = foldEvents([
      ev(0, "EXECUTION_STARTED", { input: {} }),
      ev(1, "a", {}, { flowEmit: 4 }),
      ev(2, "b", {}, { flowEmit: 1 }),
    ]);
    expect(state.variables._flowEmits).toBe(5);
  });

  it("an unstamped log (legacy, or kernel facts only) never gains the key", () => {
    const state = foldEvents([
      ev(0, "EXECUTION_STARTED", { input: {} }),
      ev(1, "response.committed", {}),
      ev(2, "STEP_STARTED", { stepId: "s", input: {} }, { fence: 1 }),
      ev(3, "x", {}, { flowEmit: "0" }), // not a number → not a stamp
    ]);
    expect("_flowEmits" in state.variables).toBe(false);
  });

  it("copy-on-write: folding a stamp never mutates the prior state's variables", () => {
    const vm = new ReplayVM([ev(0, "EXECUTION_STARTED", { input: {} })]);
    const before = vm.getState().variables;
    vm.applyEvent(ev(1, "a", {}, { flowEmit: 0 }));
    expect("_flowEmits" in before).toBe(false);
    expect(vm.getState().variables._flowEmits).toBe(1);
  });

  it("survives a snapshot seed (the counter lives in folded state)", () => {
    const seeded = foldEvents(
      [ev(0, "EXECUTION_STARTED", { input: {} }), ev(1, "a", {}, { flowEmit: 0 })],
      { executionId: "x", workflowId: "wf", workflowVersion: "1" }
    );
    const tail = foldEvents([ev(2, "b", {}, { flowEmit: 1 })], seeded);
    expect(tail.variables._flowEmits).toBe(2);
  });
});
