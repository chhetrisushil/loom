import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { replayCost, schedulerSnapshot } from "./replay";

let seq = 0;
function ev(eventType: string, executionId = "x"): EventEnvelope {
  seq += 1;
  return {
    id: `e-${seq}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence: seq,
    timestamp: seq,
    payload: {},
  };
}

describe("replayCost", () => {
  it("counts fold work: folds, frame allocations, audit appends, histogram", () => {
    seq = 0;
    const events = [
      ev("EXECUTION_STARTED"),
      ev("STEP_STARTED"),
      ev("DECISION_RECORDED"),
      ev("RESOURCE_METERED"),
      ev("STEP_COMPLETED"),
      ev("STEP_STARTED"),
      ev("OUTCOME_RECORDED"),
      ev("EXECUTION_COMPLETED"),
    ];
    const rc = replayCost(events);
    expect(rc.events).toBe(8);
    expect(rc.folds).toBe(8);
    expect(rc.executions).toBe(1);
    expect(rc.frameAllocations).toBe(2); // two STEP_STARTED
    expect(rc.auditAppends).toBe(3); // DECISION_RECORDED + RESOURCE_METERED + OUTCOME_RECORDED
    expect(rc.byType.STEP_STARTED).toBe(2);
  });

  it("counts distinct executions", () => {
    seq = 0;
    expect(replayCost([ev("STEP_STARTED", "a"), ev("STEP_STARTED", "b")]).executions).toBe(2);
  });

  it("is empty for no events", () => {
    expect(replayCost([])).toMatchObject({
      events: 0,
      folds: 0,
      frameAllocations: 0,
      auditAppends: 0,
    });
  });
});

describe("schedulerSnapshot", () => {
  it("reads live inFlight/pending counters (structural)", () => {
    expect(schedulerSnapshot({ inFlight: 2, pending: 5 })).toEqual({ inFlight: 2, pending: 5 });
  });
});
