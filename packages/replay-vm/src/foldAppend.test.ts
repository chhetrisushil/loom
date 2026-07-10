import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { foldEvents } from "./foldEvents";

const INITIAL = { executionId: "x", workflowId: "wf", workflowVersion: "1.0.0" };

function ev(sequence: number, eventType: string, payload: unknown): EventEnvelope {
  return {
    id: `x-${sequence}`,
    workflowId: "wf",
    executionId: "x",
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
  };
}

describe("fold audit-list append (O(1)-amortized, issue #82/DS&A)", () => {
  it("appends in order across a batch fold", () => {
    const events = [
      ev(0, "EXECUTION_STARTED", {}),
      ev(1, "OUTCOME_RECORDED", { key: "a", success: true }),
      ev(2, "OUTCOME_RECORDED", { key: "b", success: false }),
      ev(3, "OUTCOME_RECORDED", { key: "c" }),
    ];
    const state = foldEvents(events, INITIAL);
    expect((state.variables._outcomes as { key: string }[]).map((o) => o.key)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("does NOT mutate the caller's input/snapshot array (immutability)", () => {
    const snapshotOutcomes = [{ key: "seed" }];
    const initial = { ...INITIAL, variables: { _outcomes: snapshotOutcomes } };
    const state = foldEvents([ev(5, "OUTCOME_RECORDED", { key: "new" })], initial);
    // the folded state grew…
    expect((state.variables._outcomes as unknown[]).length).toBe(2);
    // …but the snapshot array the caller still holds is untouched
    expect(snapshotOutcomes).toEqual([{ key: "seed" }]);
    expect(state.variables._outcomes).not.toBe(snapshotOutcomes);
  });

  it("a second fold does not corrupt the first fold's returned array", () => {
    const s1 = foldEvents([ev(1, "TIMER_FIRED", { scheduleId: "t1" })], INITIAL);
    const before = [...(s1.variables._timers as unknown[])];
    // fold more events using s1 as the initial state
    foldEvents([ev(2, "TIMER_FIRED", { scheduleId: "t2" })], s1);
    expect(s1.variables._timers).toEqual(before); // s1 unchanged
  });

  it("rejects a reserved `__proto__` decisionId (fold hardening, F2)", () => {
    expect(() =>
      foldEvents([ev(1, "DECISION_RECORDED", { decisionId: "__proto__", choice: 1 })], INITIAL)
    ).toThrow(/__proto__/);
  });

  it("rejects a reserved `__proto__` stepId in PARALLEL_STARTED", () => {
    expect(() =>
      foldEvents([ev(1, "PARALLEL_STARTED", { stepIds: ["ok", "__proto__"] })], INITIAL)
    ).toThrow(/__proto__/);
  });
});
