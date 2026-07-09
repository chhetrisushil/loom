import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { foldEvents } from "./foldEvents";

const EXEC = "exec-indoubt";

function makeEvent(sequence: number, eventType: string, payload: unknown = {}): EventEnvelope {
  return {
    id: `${EXEC}-${sequence}`,
    workflowId: "wf",
    executionId: EXEC,
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
  };
}

// K9 — EFFECT_INDOUBT is a pure audit fact: it appends to the reserved
// `_indoubt` list and never touches frame/execution status (the
// EXECUTION_SUSPENDED that follows owns the status change).
describe("EFFECT_INDOUBT fold (K9)", () => {
  it("appends to variables._indoubt without changing status or frames", () => {
    const state = foldEvents([
      makeEvent(0, "EXECUTION_STARTED", { input: {} }),
      makeEvent(1, "STEP_STARTED", { stepId: "pay", input: { amountUsd: 42 } }),
      makeEvent(2, "EFFECT_INDOUBT", {
        stepId: "pay",
        toolId: "pay-tool",
        attempts: 1,
        idempotencyKey: `${EXEC}:pay`,
      }),
      makeEvent(3, "EXECUTION_SUSPENDED", {
        condition: { on: "EffectInDoubtResolved", correlationKey: "pay" },
      }),
    ]);

    expect(state.variables._indoubt).toEqual([
      { stepId: "pay", toolId: "pay-tool", attempts: 1, idempotencyKey: `${EXEC}:pay` },
    ]);
    // The audit fact itself left the frame in-flight; suspension owns status.
    expect(state.frames.pay?.status).toBe("running");
    expect(state.status).toBe("suspended");
  });

  it("accumulates one entry per fact — the per-step count is the durable key epoch", () => {
    const state = foldEvents([
      makeEvent(0, "EXECUTION_STARTED", { input: {} }),
      makeEvent(1, "EFFECT_INDOUBT", { stepId: "pay", attempts: 1 }),
      makeEvent(2, "EFFECT_INDOUBT", { stepId: "pay", attempts: 2 }),
      makeEvent(3, "EFFECT_INDOUBT", { stepId: "audit", attempts: 1 }),
    ]);

    const entries = state.variables._indoubt as Array<{ stepId: string }>;
    expect(entries.filter((e) => e.stepId === "pay").length).toBe(2);
    expect(entries.filter((e) => e.stepId === "audit").length).toBe(1);
  });
});
