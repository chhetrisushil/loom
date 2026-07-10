import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { flameGraph, formatProfile, latencyBreakdown, profile } from "./profile";

let seq = 0;
/** Build an event with an explicit wall-clock timestamp (latency needs real times). */
function ev(eventType: string, ts: number, payload: unknown = {}): EventEnvelope {
  seq += 1;
  return {
    id: `e-${seq}`,
    workflowId: "wf",
    executionId: "x",
    eventType,
    sequence: seq,
    timestamp: ts,
    payload,
  };
}

// A run: sequential step a, then a parallel block (b, c), a suspend/resume gap, then step d.
function log(): EventEnvelope[] {
  seq = 0;
  return [
    ev("EXECUTION_STARTED", 0, { input: {} }),
    ev("STEP_STARTED", 10, { stepId: "a" }),
    ev("STEP_COMPLETED", 30, { stepId: "a" }), // 20ms
    ev("PARALLEL_STARTED", 30, { stepIds: ["b", "c"] }),
    ev("STEP_STARTED", 30, { stepId: "b" }),
    ev("STEP_STARTED", 31, { stepId: "c" }),
    ev("STEP_COMPLETED", 50, { stepId: "b" }), // 20ms
    ev("STEP_COMPLETED", 60, { stepId: "c" }), // 29ms
    ev("PARALLEL_COMPLETED", 60, {}),
    ev("EXECUTION_SUSPENDED", 60, { condition: { on: "Approved" } }),
    ev("EXECUTION_RESUMED", 100, {}), // 40ms suspended
    ev("STEP_STARTED", 100, { stepId: "d" }),
    ev("STEP_COMPLETED", 110, { stepId: "d" }), // 10ms
    ev("EXECUTION_COMPLETED", 110, {}),
  ];
}

describe("flameGraph (P1)", () => {
  it("builds an execution → {step, parallel{steps}} tree with self/total times", () => {
    const root = flameGraph(log());
    expect(root.kind).toBe("execution");
    expect(root.totalMs).toBe(110);
    const kinds = root.children.map((c) => `${c.kind}:${c.label}`);
    expect(kinds).toContain("step:a");
    const parallel = root.children.find((c) => c.kind === "parallel")!;
    expect(parallel.children.map((c) => c.label).sort()).toEqual(["b", "c"]);
    const a = root.children.find((c) => c.label === "a")!;
    expect(a.totalMs).toBe(20);
    expect(a.selfMs).toBe(20);
    expect(a.status).toBe("completed");
  });

  it("counts retries as attempts on the earliest span", () => {
    const events = [
      ev("EXECUTION_STARTED", 0, {}),
      ev("STEP_STARTED", 5, { stepId: "r" }),
      ev("STEP_RETRYING", 6, { stepId: "r", attempt: 2 }),
      ev("STEP_STARTED", 7, { stepId: "r" }),
      ev("STEP_COMPLETED", 20, { stepId: "r" }),
    ];
    seq = 0;
    const root = flameGraph(events);
    const r = root.children.find((c) => c.label === "r")!;
    expect(r.attempts).toBe(2);
    expect(r.totalMs).toBe(15); // earliest start (5) → end (20)
  });
});

describe("latencyBreakdown (P2)", () => {
  it("splits wall / busy / suspended and aggregates per step", () => {
    const l = latencyBreakdown(log());
    expect(l.executions).toBe(1);
    expect(l.wallMs).toBe(110);
    expect(l.busyMs).toBe(20 + 20 + 29 + 10); // a + b + c + d = 79
    expect(l.suspendedMs).toBe(40);
    expect(l.stepCount).toBe(4);
    expect(l.suspends).toBe(1);
    expect(l.resumes).toBe(1);
    expect(l.byStep.c?.totalMs).toBe(29);
    expect(l.steps.maxMs).toBe(29);
    // P3 ratios are inert until those seams exist
    expect(l.cacheHitRatio).toBeNull();
    expect(l.predictionAccuracy).toBeNull();
  });

  it("counts decisions", () => {
    seq = 0;
    const l = latencyBreakdown([
      ev("DECISION_RECORDED", 1, { decisionId: "d", choice: "x" }),
      ev("DECISION_RECORDED", 2, { decisionId: "e", choice: "y" }),
    ]);
    expect(l.decisions).toBe(2);
  });
});

describe("profile + formatProfile", () => {
  it("combines flame + latency for one execution and renders text", () => {
    const p = profile(log(), "x");
    expect(p.executionId).toBe("x");
    expect(p.flame.totalMs).toBe(110);
    expect(p.latency.busyMs).toBe(79);
    const text = formatProfile(p);
    expect(text).toContain("flame graph:");
    expect(text).toContain("latency:");
    expect(text).toContain("suspended 40ms");
  });
});
