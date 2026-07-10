import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { advisoryPipeline, formatAdvisory } from "./advisory";

let seq = 0;
function ev(eventType: string, payload: unknown, executionId = "x"): EventEnvelope {
  seq += 1;
  return {
    id: `e-${seq}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence: seq,
    timestamp: seq,
    payload,
  };
}

// A log where "opus" was routed twice and its outcomes succeeded, plus a metered cost and
// a hot-failing step — enough signal for model-ranking, budget, and hot-failure recs.
function log(): EventEnvelope[] {
  seq = 0;
  return [
    ev("EXECUTION_STARTED", { input: {} }),
    ev("DECISION_RECORDED", { decisionId: "d1", choice: "opus", source: "reasoning" }),
    // Convention: the outcome key is the choice/model, so rankFromOutcomes ranks models.
    ev("OUTCOME_RECORDED", { key: "opus", success: true, decisionId: "d1" }),
    ev("DECISION_RECORDED", { decisionId: "d2", choice: "opus", source: "reasoning" }),
    ev("OUTCOME_RECORDED", { key: "opus", success: true, decisionId: "d2" }),
    ev("RESOURCE_METERED", { tokens: 100, costUsd: 2, ms: 20 }),
    ev("STEP_STARTED", { stepId: "flaky" }),
    ev("STEP_FAILED", { stepId: "flaky", error: "boom" }),
    ev("EXECUTION_FAILED", { error: "boom" }),
  ];
}

describe("advisoryPipeline (ADR 0034)", () => {
  it("observes telemetry, recommends, and surfaces feed-forward rankings", () => {
    const r = advisoryPipeline(log());
    expect(r.observe.costUsd).toBe(2);
    expect(r.observe.tokens).toBe(100);
    // a model-ranking recommendation for the routed model
    const modelRec = r.recommendations.find(
      (x) => x.kind === "model-ranking" && x.subject === "opus"
    );
    expect(modelRec).toBeDefined();
    expect(modelRec?.id).toMatch(/^rec:/);
    // learn: outcome-driven rankings are exposed for the next rankedRouter
    expect(Object.keys(r.rankings)).toContain("opus");
  });

  it("evaluates a recommendation against the outcomes it actually produced", () => {
    const r = advisoryPipeline(log());
    const evalForOpus = r.evaluations.find((e) => e.subject === "opus");
    expect(evalForOpus).toBeDefined();
    expect(evalForOpus?.adopted).toBe(2); // d1 + d2 chose opus
    expect(evalForOpus?.outcomes).toBe(2);
    expect(evalForOpus?.successes).toBe(2);
    expect(evalForOpus?.successRate).toBe(1);
  });

  it("is deterministic — same events yield an identical report", () => {
    expect(advisoryPipeline(log())).toEqual(advisoryPipeline(log()));
  });

  it("recommendation ids are stable/content-derived across runs", () => {
    const a = advisoryPipeline(log()).recommendations.map((r) => r.id);
    const b = advisoryPipeline(log()).recommendations.map((r) => r.id);
    expect(a).toEqual(b);
  });

  it("produces no recommendations for an empty log (never fabricates)", () => {
    seq = 0;
    const r = advisoryPipeline([]);
    expect(r.recommendations).toEqual([]);
    expect(r.evaluations).toEqual([]);
  });

  it("leaves successRate null when a recommended subject has no recorded outcome", () => {
    seq = 0;
    const r = advisoryPipeline([
      ev("EXECUTION_STARTED", {}),
      ev("DECISION_RECORDED", { decisionId: "d1", choice: "haiku", source: "reasoning" }),
      // no OUTCOME_RECORDED for d1
    ]);
    const e = r.evaluations.find((x) => x.subject === "haiku");
    expect(e?.adopted).toBe(1);
    expect(e?.outcomes).toBe(0);
    expect(e?.successRate).toBeNull();
  });

  it("formatAdvisory renders observe / recommendations / evaluation sections", () => {
    const text = formatAdvisory(advisoryPipeline(log()));
    expect(text).toContain("advisory optimization report");
    expect(text).toContain("recommendations:");
    expect(text).toContain("evaluation");
  });
});
