import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { decisionGraph, decisionRecords, decisionStore, outcomeRecords } from "./decisions";

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

function log(): EventEnvelope[] {
  seq = 0;
  return [
    ev("EXECUTION_STARTED", { input: {} }),
    ev("DECISION_RECORDED", {
      decisionId: "route",
      choice: "opus",
      source: "reasoning",
      alternatives: ["haiku", "opus"],
      estimatedCostUsd: 0.12,
      confidence: 0.9,
    }),
    ev("DECISION_RECORDED", { decisionId: "ranker", choice: "A", source: "analytics" }),
    ev("OUTCOME_RECORDED", { key: "route", success: true, decisionId: "route" }),
    // a second execution with its own decision
    ev("DECISION_RECORDED", { decisionId: "route2", choice: "haiku", source: "reasoning" }, "y"),
  ];
}

describe("decisionRecords / outcomeRecords", () => {
  it("materializes decisions with D1 fields + provenance", () => {
    const recs = decisionRecords(log());
    expect(recs).toHaveLength(3);
    const route = recs.find((r) => r.decisionId === "route")!;
    expect(route.choice).toBe("opus");
    expect(route.alternatives).toEqual(["haiku", "opus"]);
    expect(route.estimatedCostUsd).toBe(0.12);
    expect(route.confidence).toBe(0.9);
    expect(route.executionId).toBe("x");
    expect(typeof route.sequence).toBe("number");
  });

  it("materializes outcomes with the decision link", () => {
    const outs = outcomeRecords(log());
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ key: "route", success: true, decisionId: "route" });
  });
});

describe("decisionStore (D2)", () => {
  it("queries by id, execution, source, and outcome linkage", () => {
    const store = decisionStore(log());
    expect(store.records).toHaveLength(3);
    expect(store.byId("route")).toHaveLength(1);
    expect(store.byExecution("x").map((r) => r.decisionId)).toEqual(["route", "ranker"]);
    expect(store.byExecution("y").map((r) => r.decisionId)).toEqual(["route2"]);
    expect(
      store
        .bySource("reasoning")
        .map((r) => r.decisionId)
        .sort()
    ).toEqual(["route", "route2"]);
    expect(store.outcomesOf("route")).toHaveLength(1);
    expect(store.query({ hasOutcome: true }).map((r) => r.decisionId)).toEqual(["route"]);
    expect(
      store
        .query({ hasOutcome: false })
        .map((r) => r.decisionId)
        .sort()
    ).toEqual(["ranker", "route2"]);
    expect(store.query({ executionId: "x", source: "analytics" }).map((r) => r.decisionId)).toEqual(
      ["ranker"]
    );
  });
});

describe("decisionGraph (D3)", () => {
  it("links decisions to outcomes and to the next decision in the same execution", () => {
    const g = decisionGraph(log());
    expect(g.nodes.find((n) => n.decisionId === "route")?.outcomes).toHaveLength(1);
    expect(g.edges).toContainEqual({ from: "route", to: "route", kind: "outcome" });
    // sequence edge within execution "x": route → ranker
    expect(g.edges).toContainEqual({ from: "route", to: "ranker", kind: "sequence" });
    // no cross-execution sequence edge (route2 is in a different execution)
    expect(g.edges.some((e) => e.kind === "sequence" && e.to === "route2")).toBe(false);
  });
});
