import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { ReplayVM } from "./ReplayVM";
import { foldEvents } from "./foldEvents";

function makeEvent(
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown = {}
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "test-flow",
    executionId,
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
  };
}

const EXECUTION_ID = "exec-replay-test";
const INITIAL = { executionId: EXECUTION_ID, workflowId: "test-flow", workflowVersion: "1.0.0" };

describe("foldEvents", () => {
  it("starts with pending status", () => {
    const state = foldEvents([], INITIAL);
    expect(state.status).toBe("pending");
    expect(state.frames).toEqual({});
  });

  it("transitions to running on EXECUTION_STARTED", () => {
    const events = [makeEvent(EXECUTION_ID, 0, "EXECUTION_STARTED", { input: { id: "abc" } })];
    const state = foldEvents(events, INITIAL);
    expect(state.status).toBe("running");
    expect(state.startedAt).toBe(1000);
  });

  it("records STEP_STARTED and STEP_COMPLETED correctly", () => {
    const events = [
      makeEvent(EXECUTION_ID, 0, "EXECUTION_STARTED"),
      makeEvent(EXECUTION_ID, 1, "STEP_STARTED", { stepId: "step-a", input: { x: 1 } }),
      makeEvent(EXECUTION_ID, 2, "STEP_COMPLETED", { stepId: "step-a", output: { y: 2 } }),
    ];
    const state = foldEvents(events, INITIAL);
    expect(state.frames["step-a"]?.status).toBe("completed");
    expect(state.frames["step-a"]?.output).toEqual({ y: 2 });
    expect(state.frames["step-a"]?.input).toEqual({ x: 1 });
  });

  it("sets status to suspended on EXECUTION_SUSPENDED", () => {
    const condition = { on: "ApprovalGranted", correlationKey: "abc" };
    const events = [
      makeEvent(EXECUTION_ID, 0, "EXECUTION_STARTED"),
      makeEvent(EXECUTION_ID, 1, "EXECUTION_SUSPENDED", { condition }),
    ];
    const state = foldEvents(events, INITIAL);
    expect(state.status).toBe("suspended");
    expect(state.suspendedOn).toEqual(condition);
  });

  it("clears suspendedOn and becomes running on EXECUTION_RESUMED", () => {
    const events = [
      makeEvent(EXECUTION_ID, 0, "EXECUTION_STARTED"),
      makeEvent(EXECUTION_ID, 1, "EXECUTION_SUSPENDED", { condition: { on: "ApprovalGranted" } }),
      makeEvent(EXECUTION_ID, 2, "EXECUTION_RESUMED", { approved: true }),
    ];
    const state = foldEvents(events, INITIAL);
    expect(state.status).toBe("running");
    expect(state.suspendedOn).toBeUndefined();
    expect(state.variables._resumePayload).toEqual({ approved: true });
  });

  it("reaches completed status on EXECUTION_COMPLETED", () => {
    const events = [
      makeEvent(EXECUTION_ID, 0, "EXECUTION_STARTED"),
      makeEvent(EXECUTION_ID, 1, "EXECUTION_COMPLETED", { output: { done: true } }),
    ];
    const state = foldEvents(events, INITIAL);
    expect(state.status).toBe("completed");
  });

  it("tracks sequence number from last event", () => {
    const events = [
      makeEvent(EXECUTION_ID, 0, "EXECUTION_STARTED"),
      makeEvent(EXECUTION_ID, 1, "STEP_STARTED", { stepId: "s1" }),
      makeEvent(EXECUTION_ID, 2, "STEP_COMPLETED", { stepId: "s1" }),
    ];
    const state = foldEvents(events, INITIAL);
    expect(state.sequence).toBe(2);
  });

  it("is deterministic — same events always produce same state", () => {
    const events = [
      makeEvent(EXECUTION_ID, 0, "EXECUTION_STARTED"),
      makeEvent(EXECUTION_ID, 1, "STEP_STARTED", { stepId: "step-b", input: { val: 99 } }),
      makeEvent(EXECUTION_ID, 2, "STEP_COMPLETED", { stepId: "step-b", output: { result: "ok" } }),
      makeEvent(EXECUTION_ID, 3, "EXECUTION_COMPLETED", { output: { result: "ok" } }),
    ];
    const s1 = foldEvents(events, INITIAL);
    const s2 = foldEvents(events, INITIAL);
    expect(s1).toEqual(s2);
  });

  it("handles full 10-event lifecycle", () => {
    const events: EventEnvelope[] = [
      makeEvent(EXECUTION_ID, 0, "EXECUTION_STARTED", { input: { incidentId: "cpu-001" } }),
      makeEvent(EXECUTION_ID, 1, "STEP_STARTED", {
        stepId: "fetch-metrics",
        input: { incidentId: "cpu-001" },
      }),
      makeEvent(EXECUTION_ID, 2, "STEP_COMPLETED", {
        stepId: "fetch-metrics",
        output: { cpu: 87 },
      }),
      makeEvent(EXECUTION_ID, 3, "STEP_STARTED", {
        stepId: "fetch-logs",
        input: { incidentId: "cpu-001" },
      }),
      makeEvent(EXECUTION_ID, 4, "STEP_COMPLETED", { stepId: "fetch-logs", output: { logs: [] } }),
      makeEvent(EXECUTION_ID, 5, "STEP_STARTED", { stepId: "request-approval" }),
      makeEvent(EXECUTION_ID, 6, "EXECUTION_SUSPENDED", {
        condition: { on: "ApprovalGranted", correlationKey: "cpu-001" },
      }),
      makeEvent(EXECUTION_ID, 7, "EXECUTION_RESUMED", { approved: true, approver: "alice" }),
      makeEvent(EXECUTION_ID, 8, "STEP_COMPLETED", {
        stepId: "request-approval",
        output: { approved: true },
      }),
      makeEvent(EXECUTION_ID, 9, "EXECUTION_COMPLETED", { output: { resolved: true } }),
    ];

    const state = foldEvents(events, INITIAL);
    expect(state.status).toBe("completed");
    expect(state.frames["fetch-metrics"]?.status).toBe("completed");
    expect(state.frames["fetch-metrics"]?.output).toEqual({ cpu: 87 });
    expect(state.frames["fetch-logs"]?.status).toBe("completed");
    expect(state.frames["request-approval"]?.status).toBe("completed");
    expect(state.sequence).toBe(9);
    expect(state.suspendedOn).toBeUndefined();
  });
});

describe("ReplayVM", () => {
  it("hasCompleted returns true for completed steps", () => {
    const events = [
      makeEvent(EXECUTION_ID, 0, "EXECUTION_STARTED"),
      makeEvent(EXECUTION_ID, 1, "STEP_STARTED", { stepId: "s1" }),
      makeEvent(EXECUTION_ID, 2, "STEP_COMPLETED", { stepId: "s1", output: { x: 1 } }),
    ];
    const vm = new ReplayVM(events, INITIAL);
    expect(vm.hasCompleted("s1")).toBe(true);
    expect(vm.hasCompleted("s2")).toBe(false);
  });

  it("getOutput returns the stored output", () => {
    const events = [
      makeEvent(EXECUTION_ID, 0, "EXECUTION_STARTED"),
      makeEvent(EXECUTION_ID, 1, "STEP_STARTED", { stepId: "s1" }),
      makeEvent(EXECUTION_ID, 2, "STEP_COMPLETED", { stepId: "s1", output: { result: "done" } }),
    ];
    const vm = new ReplayVM(events, INITIAL);
    expect(vm.getOutput("s1")).toEqual({ result: "done" });
  });

  // ── copy-on-write correctness (perf optimization) ──────────────────────────
  it("shares untouched frames by reference and never mutates a prior state", () => {
    const base = foldEvents(
      [
        makeEvent(EXECUTION_ID, 0, "EXECUTION_STARTED"),
        makeEvent(EXECUTION_ID, 1, "STEP_STARTED", { stepId: "a" }),
        makeEvent(EXECUTION_ID, 2, "STEP_COMPLETED", { stepId: "a", output: 1 }),
        makeEvent(EXECUTION_ID, 3, "STEP_STARTED", { stepId: "b" }),
      ],
      INITIAL
    );
    const frameABefore = base.frames.a;
    const seqBefore = base.sequence;

    // Fold one more event that only touches frame "b".
    const next = foldEvents(
      [makeEvent(EXECUTION_ID, 4, "STEP_COMPLETED", { stepId: "b", output: 2 })],
      base
    );

    // Untouched frame "a" is shared by reference (copy-on-write, no deep clone).
    expect(next.frames.a).toBe(frameABefore);
    // The prior state is not mutated (no in-place sequence bleed onto the caller's state).
    expect(base.sequence).toBe(seqBefore);
    expect(base.frames.b?.status).toBe("running");
    expect(next.frames.b?.status).toBe("completed");
  });
});

describe("prototype-chain event types fold to a no-op", () => {
  // `eventType` is caller-controlled all the way from an ingress adapter: `runtime.resume`
  // takes it verbatim, and A2A `provideInput` forwards a network-supplied ResumeEvent. Plain
  // `handlers[eventType]` resolves `"__proto__"` to `Object.prototype` — TRUTHY, so the
  // `if (handler)` guard admitted it and the fold then called a non-function, turning a
  // hostile event name into a TypeError out of the kernel's most load-bearing function.
  const HOSTILE = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];

  it("does not throw, and leaves state untouched", () => {
    for (const eventType of HOSTILE) {
      const base = foldEvents([makeEvent("e1", 0, "EXECUTION_STARTED", { input: { a: 1 } })], {
        executionId: "e1",
      });
      const withHostile = foldEvents(
        [
          makeEvent("e1", 0, "EXECUTION_STARTED", { input: { a: 1 } }),
          makeEvent("e1", 1, eventType, { evil: true }),
        ],
        { executionId: "e1" }
      );
      // Unrecognised → no-op, exactly like any other unknown event type. Sequence still
      // advances, because every event advances it.
      expect(withHostile.status).toBe(base.status);
      expect(withHostile.variables).toEqual(base.variables);
      expect(withHostile.sequence).toBe(1);
    }
  });

  it("is identical to an ordinary unknown event type", () => {
    const shape = (eventType: string) =>
      foldEvents(
        [
          makeEvent("e1", 0, "EXECUTION_STARTED", { input: {} }),
          makeEvent("e1", 1, eventType, { x: 1 }),
        ],
        { executionId: "e1" }
      );
    const reference = shape("SOME_UNKNOWN_APP_EVENT");
    for (const eventType of HOSTILE) {
      expect(shape(eventType)).toEqual(reference);
    }
  });
});
