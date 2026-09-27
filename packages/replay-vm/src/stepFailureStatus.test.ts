import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { knownEventTypes } from "./eventHandlers";
import { foldEvents, normalizeSnapshotState } from "./foldEvents";

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

describe("the status contract — no STEP_* event moves execution status (spec §fold, ADR 0105)", () => {
  // Property over EVERY step event the fold knows (a new STEP_* kind is covered by adding it)
  // × every non-terminal status an execution can be in when a step event lands.
  const stepTypes = knownEventTypes().filter((t) => t.startsWith("STEP_"));
  const statuses = ["pending", "running", "suspended"] as const;

  it("finds the step events (the sweep can't silently match nothing)", () => {
    expect(stepTypes).toEqual(
      expect.arrayContaining(["STEP_STARTED", "STEP_COMPLETED", "STEP_FAILED", "STEP_CANCELLED"])
    );
  });

  for (const type of stepTypes) {
    for (const status of statuses) {
      it(`${type} leaves "${status}" unchanged`, () => {
        const base = foldEvents([], {
          executionId: "x-1",
          workflowId: "w-1",
          status,
          ...(status === "suspended" && { suspendedOn: { on: "go" } }),
        });
        const payload = { stepId: "s1", attempt: 2, error: "e", output: 1, input: {} };
        expect(foldEvents([envelope(0, type, payload)], base).status).toBe(status);
      });
    }
  }
});

describe("a parallel sibling that fails after the flow parked (1.21.0)", () => {
  const parkedThenFailed = [
    ...prefix,
    envelope(2, "EXECUTION_SUSPENDED", { condition: { on: "Approval" } }),
    envelope(3, "STEP_FAILED", { stepId: "s1", error: "late boom" }),
  ];

  it("leaves the execution suspended on its gate", () => {
    const state = foldEvents(parkedThenFailed);
    expect(state.status).toBe("suspended");
    expect(state.suspendedOn).toEqual({ on: "Approval" });
  });

  it("pins the 1.21.0 fold: a following null resume is the parked gate's answer", () => {
    // 1.20.0 folded the failure to "failed", so `isStatusOnlyResume` read this null as a
    // status-only re-open (`_resumePayloads` undefined). Since 1.21.0 the execution is parked,
    // so the null answers the gate — `inspectStrayPassthroughs` flags the legacy shape.
    const state = foldEvents([...parkedThenFailed, envelope(4, "EXECUTION_RESUMED", null)]);
    expect(state.status).toBe("running");
    expect(state.variables._resumePayloads).toEqual([null]);
  });
});

describe("normalizeSnapshotState — a snapshot folded before 1.21.0 (ADR 0105)", () => {
  const legacy = {
    executionId: "x-1",
    workflowId: "w-1",
    workflowVersion: "1",
    status: "failed" as const,
    frames: { s1: { stepId: "s1", status: "failed" as const, attempts: 1, error: "boom" } },
    variables: { _input: {} },
    sequence: 2,
    startedAt: 1,
    updatedAt: 3,
  };

  it("reads a caught-failure artifact (failed, no _error, a failed frame) as running", () => {
    expect(normalizeSnapshotState(legacy).status).toBe("running");
  });

  it("reads it as suspended when the snapshot is parked (a sibling failed during the park)", () => {
    const parked = { ...legacy, suspendedOn: { on: "Approval" } };
    expect(normalizeSnapshotState(parked).status).toBe("suspended");
  });

  it("negative: a genuine failure (EXECUTION_FAILED always records _error) is untouched", () => {
    const failed = { ...legacy, variables: { _input: {}, _error: "Error: boom" } };
    expect(normalizeSnapshotState(failed)).toBe(failed);
  });

  it("negative: failed with no failed frame is not the artifact, and is untouched", () => {
    const noFrame = { ...legacy, frames: {} };
    expect(normalizeSnapshotState(noFrame)).toBe(noFrame);
  });

  it("every non-failed state is returned as the same object", () => {
    const running = { ...legacy, status: "running" as const };
    expect(normalizeSnapshotState(running)).toBe(running);
  });

  it("a normalized legacy snapshot plus its tail folds like the log would", () => {
    const tail = [
      envelope(3, "STEP_STARTED", { stepId: "s2" }),
      envelope(4, "STEP_COMPLETED", { stepId: "s2", output: 1 }),
    ];
    expect(foldEvents(tail, normalizeSnapshotState(legacy)).status).toBe("running");
    // …which is what the unrepaired snapshot got wrong.
    expect(foldEvents(tail, legacy).status).toBe("failed");
  });
});
