import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { foldEvents } from "./foldEvents";

// ── ADR 0105 — STEP_FAILED fails the STEP; only EXECUTION_FAILED fails the execution ──
//
// A flow may catch a step's throw and carry on, so the step event cannot know whether the
// execution failed. The kernel commits EXECUTION_FAILED when a failure escapes the runner;
// that event owns the terminal status, exactly as EXECUTION_CANCELLED does for STEP_CANCELLED.

function envelope(sequence: number, eventType: string, payload: unknown): EventEnvelope {
  return {
    id: `e-${sequence}`,
    executionId: "x-1",
    workflowId: "w-1",
    eventType,
    sequence,
    timestamp: 1_000 + sequence,
    payload,
  };
}

const prefix = [
  envelope(0, "EXECUTION_STARTED", { input: {} }),
  envelope(1, "STEP_STARTED", { stepId: "s1" }),
];

describe("STEP_FAILED leaves the execution status alone (ADR 0105)", () => {
  it("a failed step (untyped) leaves the execution running, with the failure on its frame", () => {
    const state = foldEvents([
      ...prefix,
      envelope(2, "STEP_FAILED", { stepId: "s1", error: "boom" }),
    ]);
    expect(state.status).toBe("running");
    expect(state.frames.s1).toMatchObject({ status: "failed", error: "boom" });
  });

  it("a typed failure (DE-4) — the canonical caught failure — leaves it running too", () => {
    const state = foldEvents([
      ...prefix,
      envelope(2, "STEP_FAILED", { stepId: "s1", error: "e", channel: "drift", payload: {} }),
    ]);
    expect(state.status).toBe("running");
  });

  it("a caught failure followed by more work and a completion folds to completed", () => {
    const state = foldEvents([
      ...prefix,
      envelope(2, "STEP_FAILED", { stepId: "s1", error: "boom" }),
      envelope(3, "STEP_STARTED", { stepId: "fallback" }),
      envelope(4, "STEP_COMPLETED", { stepId: "fallback", output: 1 }),
      envelope(5, "EXECUTION_COMPLETED", { output: 1 }),
    ]);
    expect(state.status).toBe("completed");
  });

  it("a caught failure then a park folds to suspended, and a resume back to running", () => {
    const parked = foldEvents([
      ...prefix,
      envelope(2, "STEP_FAILED", { stepId: "s1", error: "boom" }),
      envelope(3, "EXECUTION_SUSPENDED", { condition: { on: "go" } }),
    ]);
    expect(parked.status).toBe("suspended");
    const resumed = foldEvents([envelope(4, "EXECUTION_RESUMED", { ok: true })], parked);
    expect(resumed.status).toBe("running");
  });

  it("negative: an escaped failure — STEP_FAILED then EXECUTION_FAILED — folds to failed", () => {
    const state = foldEvents([
      ...prefix,
      envelope(2, "STEP_FAILED", { stepId: "s1", error: "boom" }),
      envelope(3, "EXECUTION_FAILED", { error: "Error: boom" }),
    ]);
    expect(state.status).toBe("failed");
    expect(state.variables._error).toBe("Error: boom");
  });

  it("negative: EXECUTION_FAILED with no step failure before it still folds to failed", () => {
    const state = foldEvents([...prefix, envelope(2, "EXECUTION_FAILED", { error: "x" })]);
    expect(state.status).toBe("failed");
  });
});
