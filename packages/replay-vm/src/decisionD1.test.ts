import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { ReplayVM } from "./ReplayVM";
import { foldEvents } from "./foldEvents";

// ADR 0030 D1 — the richer DECISION_RECORDED payload (alternatives / estimatedCostUsd /
// estimatedLatencyMs / confidence) is DESCRIPTIVE. It must fold into the decision entry
// but NEVER influence replay: getDecision returns only `choice` (P9). Legacy events
// (without the fields) must fold byte-identically.

const EXEC = "exec-d1";
const INITIAL = { executionId: EXEC, workflowId: "wf", workflowVersion: "1.0.0" };

function ev(sequence: number, eventType: string, payload: unknown): EventEnvelope {
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

describe("DECISION_RECORDED D1 materialization fields", () => {
  const events = [
    ev(0, "EXECUTION_STARTED", { input: {} }),
    ev(1, "DECISION_RECORDED", {
      decisionId: "route",
      choice: "opus",
      source: "reasoning",
      alternatives: ["haiku", "opus"],
      estimatedCostUsd: 0.12,
      estimatedLatencyMs: 800,
      confidence: 0.9,
    }),
    ev(2, "DECISION_RECORDED", { decisionId: "legacy", choice: "x" }),
  ];

  it("getDecision returns only the choice (descriptive fields never affect replay)", () => {
    const vm = new ReplayVM(events);
    expect(vm.getDecision("route")).toBe("opus");
    expect(vm.getDecision("legacy")).toBe("x");
    expect(vm.hasDecision("route")).toBe(true);
  });

  it("folds the descriptive fields into the _decisions entry", () => {
    const state = foldEvents(events, INITIAL);
    const decisions = state.variables._decisions as Record<string, Record<string, unknown>>;
    expect(decisions.route).toMatchObject({
      choice: "opus",
      source: "reasoning",
      alternatives: ["haiku", "opus"],
      estimatedCostUsd: 0.12,
      estimatedLatencyMs: 800,
      confidence: 0.9,
    });
  });

  it("folds a legacy decision (no D1 fields) with only choice", () => {
    const state = foldEvents(events, INITIAL);
    const decisions = state.variables._decisions as Record<string, Record<string, unknown>>;
    expect(decisions.legacy).toEqual({ choice: "x" });
  });
});
