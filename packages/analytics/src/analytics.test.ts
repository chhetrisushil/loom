import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import {
  analyze,
  costAnalytics,
  executionAnalytics,
  failureAnalytics,
  reasoningAnalytics,
} from "./analyze";
import { hotFailures, rankModels, runtimeIntelligence } from "./intelligence";

let seq = 0;
function ev(eventType: string, payload: unknown = {}): EventEnvelope {
  seq += 1;
  return {
    id: `x-${seq}`,
    workflowId: "wf",
    executionId: "x",
    eventType,
    sequence: seq,
    timestamp: seq,
    payload,
  };
}

// A representative enriched log spanning M1–K3 event types.
function makeLog(): EventEnvelope[] {
  seq = 0;
  return [
    ev("EXECUTION_STARTED", { input: {} }),
    ev("STEP_STARTED", { stepId: "diagnose" }),
    ev("DECISION_RECORDED", {
      decisionId: "reason:agent:route",
      choice: "gemma",
      source: "reasoning",
    }),
    ev("DECISION_RECORDED", {
      decisionId: "reason:agent:elevate:1",
      choice: "opus",
      source: "reasoning",
    }),
    ev("RESOURCE_METERED", { tokens: 100, costUsd: 0.5, ms: 20 }),
    ev("STEP_COMPLETED", { stepId: "diagnose", output: { ok: true } }),
    ev("STEP_STARTED", { stepId: "remediate" }),
    ev("STEP_FAILED", { stepId: "remediate", error: "boom" }),
    ev("EFFECT_DENIED", { toolId: "danger-tool", stepId: "remediate", reason: "not granted" }),
    ev("RESOURCE_METERED", { tokens: 50, costUsd: 0.25, ms: 10 }),
    ev("QUOTA_EXCEEDED", { reason: "over budget" }),
    ev("EXECUTION_FAILED", { error: "boom" }),
  ];
}

describe("analytics (M9)", () => {
  it("summarizes execution", () => {
    const a = executionAnalytics(makeLog());
    expect(a).toMatchObject({
      steps: 2,
      completed: 1,
      failed: 1,
      suspended: false,
      resumes: 0,
      status: "failed",
    });
  });

  it("summarizes cost from RESOURCE_METERED / QUOTA_EXCEEDED", () => {
    expect(costAnalytics(makeLog())).toEqual({
      tokens: 150,
      costUsd: 0.75,
      ms: 30,
      meteredCalls: 2,
      quotaExceeded: true,
    });
  });

  it("summarizes reasoning routes and elevations from DECISION_RECORDED", () => {
    const r = reasoningAnalytics(makeLog());
    expect(r.decisions).toBe(2);
    expect(r.routes).toEqual({ gemma: 1, opus: 1 });
    expect(r.elevations).toBe(1);
    expect(r.bySource).toEqual({ reasoning: 2 });
  });

  it("summarizes failures, denials and quota breaches", () => {
    expect(failureAnalytics(makeLog())).toEqual({
      failures: 1,
      denials: 1,
      quotaExceeded: 1,
      failedSteps: ["remediate"],
      deniedTools: ["danger-tool"],
    });
  });

  it("analyze() combines all four lenses", () => {
    const a = analyze(makeLog());
    expect(a.execution.status).toBe("failed");
    expect(a.cost.costUsd).toBe(0.75);
    expect(a.reasoning.decisions).toBe(2);
    expect(a.failure.failures).toBe(1);
  });
});

describe("self-optimization (M10) + runtime intelligence (M11)", () => {
  it("rankModels reflects historical route frequency", () => {
    const log = [...makeLog(), ...makeLog()]; // two executions
    expect(rankModels(log)).toEqual({ gemma: 2, opus: 2 });
  });

  it("hotFailures ranks the flakiest steps first", () => {
    const log = [
      ev("STEP_FAILED", { stepId: "a" }),
      ev("STEP_FAILED", { stepId: "b" }),
      ev("STEP_FAILED", { stepId: "a" }),
    ];
    expect(hotFailures(log)).toEqual(["a", "b"]);
  });

  it("runtimeIntelligence composes analytics + advisory recommendations", () => {
    const report = runtimeIntelligence(makeLog());
    expect(report.analytics.cost.costUsd).toBe(0.75);
    expect(report.recommendations.modelRankings).toEqual({ gemma: 1, opus: 1 });
    expect(report.recommendations.hotFailures).toEqual(["remediate"]);
    // 0.75 * 1.5 headroom = 1.125 → 1.13
    expect(report.recommendations.suggestedBudgetUsd).toBe(1.13);
  });

  it("omits a budget suggestion when nothing was metered", () => {
    const report = runtimeIntelligence([ev("STEP_COMPLETED", { stepId: "s" })]);
    expect(report.recommendations.suggestedBudgetUsd).toBeUndefined();
  });
});

describe("`continued` is terminal and NOT completed (ADR 0109 D2)", () => {
  const kernelContinued = (): EventEnvelope => ({
    ...ev("EXECUTION_CONTINUED", { successorId: "x~1", chainId: "x", generation: 1 }),
    metadata: { kernel: true },
  });

  it("executionAnalytics and analyze report `continued`, never `completed`", () => {
    seq = 0;
    const log = [ev("EXECUTION_STARTED", { input: {} }), kernelContinued()];
    expect(executionAnalytics(log).status).toBe("continued");
    expect(analyze(log).execution.status).toBe("continued");
  });

  it("an UNSTAMPED app event named EXECUTION_CONTINUED changes nothing", () => {
    seq = 0;
    const log = [
      ev("EXECUTION_STARTED", { input: {} }),
      ev("EXECUTION_CONTINUED", { successorId: "x~1" }),
    ];
    expect(executionAnalytics(log).status).toBeUndefined();
    expect(analyze(log).execution.status).toBeUndefined();
  });
});
