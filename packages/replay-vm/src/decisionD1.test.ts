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

// ADR 0079 (T2) — `context` (the observation the policy saw) and `policy` (which policy
// saw it, plus the propensity that makes off-policy evaluation unbiased) extend the same
// DESCRIPTIVE contract. The whole point of the field is that it is inert on replay: it
// turns the log into a learnable (state, action, propensity) dataset without giving the
// fold one new input.
describe("DECISION_RECORDED context/policy fields (ADR 0079)", () => {
  const events = [
    ev(0, "EXECUTION_STARTED", { input: {} }),
    ev(1, "DECISION_RECORDED", {
      decisionId: "route",
      choice: "opus",
      context: { intent: "summarize", tokens: 4096, tenant: "acme" },
      policy: { id: "linucb", version: "3", propensity: 0.7 },
    }),
    ev(2, "DECISION_RECORDED", { decisionId: "legacy", choice: "x" }),
  ];

  it("folds context and policy into the _decisions entry", () => {
    const state = foldEvents(events, INITIAL);
    const decisions = state.variables._decisions as Record<string, Record<string, unknown>>;
    expect(decisions.route).toEqual({
      choice: "opus",
      context: { intent: "summarize", tokens: 4096, tenant: "acme" },
      policy: { id: "linucb", version: "3", propensity: 0.7 },
    });
  });

  it("getDecision still returns only the choice — the observation is never a replay input", () => {
    const vm = new ReplayVM(events);
    expect(vm.getDecision("route")).toBe("opus");
  });

  it("a log whose decisions carry neither field folds exactly as it did at 1.17.0", () => {
    // The compatibility claim behind the MINOR bump. Folding the same legacy events
    // under the extended handler must produce a decision entry with `choice` and
    // nothing else — no `context: undefined` key, no `policy: undefined` key.
    const legacyOnly = [events[0] as EventEnvelope, events[2] as EventEnvelope];
    const state = foldEvents(legacyOnly, INITIAL);
    const decisions = state.variables._decisions as Record<string, Record<string, unknown>>;
    expect(decisions).toEqual({ legacy: { choice: "x" } });
    expect(Object.keys(decisions.legacy as object)).toEqual(["choice"]);
  });
});
