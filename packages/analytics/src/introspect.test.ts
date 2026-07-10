import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import {
  dependencyGraph,
  executionNodes,
  formatIntrospection,
  introspect,
  resourceGraph,
  taskGraph,
} from "./introspect";

let seq = 0;
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

function log(): EventEnvelope[] {
  seq = 0;
  return [
    ev("EXECUTION_STARTED", 0, { input: {} }),
    ev("STEP_STARTED", 10, { stepId: "a" }),
    ev("RESOURCE_METERED", 15, { tokens: 100, costUsd: 0.5, ms: 5 }), // → step a
    ev("STEP_COMPLETED", 30, { stepId: "a" }),
    ev("PARALLEL_STARTED", 30, { stepIds: ["b", "c"] }),
    ev("STEP_STARTED", 30, { stepId: "b" }),
    ev("STEP_STARTED", 31, { stepId: "c" }),
    ev("STEP_COMPLETED", 50, { stepId: "b" }),
    ev("STEP_FAILED", 60, { stepId: "c", error: "boom" }),
    ev("PARALLEL_COMPLETED", 60, {}),
    ev("DECISION_RECORDED", 61, { decisionId: "route", choice: "opus", source: "reasoning" }),
    ev("OUTCOME_RECORDED", 62, { key: "route", success: true, decisionId: "route" }),
    ev("EXECUTION_SUSPENDED", 63, { condition: { on: "Approved" } }),
    ev("EXECUTION_RESUMED", 100, {}),
    ev("STEP_STARTED", 100, { stepId: "d" }),
    ev("RESOURCE_METERED", 105, { tokens: 20, costUsd: 0.1, ms: 2 }), // → step d
    ev("STEP_COMPLETED", 110, { stepId: "d" }),
    ev("EXECUTION_COMPLETED", 111, {}),
  ];
}

describe("executionNodes", () => {
  it("summarizes each execution with terminal status + step count", () => {
    const nodes = executionNodes(log());
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      executionId: "x",
      workflowId: "wf",
      status: "completed",
      steps: 4,
      startedAt: 0,
      completedAt: 111,
    });
  });

  it("reports suspended when the last lifecycle event is a suspend", () => {
    seq = 0;
    const nodes = executionNodes([
      ev("EXECUTION_STARTED", 0, {}),
      ev("EXECUTION_SUSPENDED", 5, { condition: { on: "x" } }),
    ]);
    expect(nodes[0]?.status).toBe("suspended");
  });
});

describe("taskGraph", () => {
  it("builds step nodes (with parallel flags) + execution-order edges", () => {
    const g = taskGraph(log());
    expect(g.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
    expect(g.nodes.find((n) => n.id === "c")).toMatchObject({ status: "failed", parallel: true });
    expect(g.nodes.find((n) => n.id === "a")?.parallel).toBe(false);
    expect(g.edges).toEqual([
      { from: "a", to: "b", kind: "next" },
      { from: "b", to: "c", kind: "next" },
      { from: "c", to: "d", kind: "next" },
    ]);
  });
});

describe("resourceGraph", () => {
  it("attributes metered usage to the running step and totals it", () => {
    const g = resourceGraph(log());
    expect(g.total).toEqual({ tokens: 120, costUsd: 0.6, ms: 7 });
    expect(g.byStep.find((n) => n.stepId === "a")).toEqual({
      stepId: "a",
      tokens: 100,
      costUsd: 0.5,
      ms: 5,
    });
    expect(g.byStep.find((n) => n.stepId === "d")).toEqual({
      stepId: "d",
      tokens: 20,
      costUsd: 0.1,
      ms: 2,
    });
  });
});

describe("dependencyGraph", () => {
  it("emits flow→tool (invokes) and principal→tool (grants) edges", () => {
    const g = dependencyGraph({
      flowTools: { f: ["a-tool"] },
      grants: { f: ["a-tool"], admin: "*" },
    });
    expect(g.edges).toContainEqual({ from: "f", to: "a-tool", kind: "invokes" });
    expect(g.edges).toContainEqual({ from: "f", to: "a-tool", kind: "grants" });
    expect(g.edges).toContainEqual({ from: "admin", to: "*", kind: "grants" });
    expect(g.nodes).toContain("a-tool");
  });
});

describe("introspect facade", () => {
  it("bundles log-derived graphs and reuses the decision graph", () => {
    const x = introspect(log());
    expect(x.executions).toHaveLength(1);
    expect(x.tasks.nodes).toHaveLength(4);
    expect(x.decisions.nodes.map((n) => n.decisionId)).toEqual(["route"]);
    expect(x.decisions.edges).toContainEqual({ from: "route", to: "route", kind: "outcome" });
    expect(x.resources.total.tokens).toBe(120);
    // no opts → no placement / dependencies
    expect(x.placement).toBeUndefined();
    expect(x.dependencies).toBeUndefined();
  });

  it("adds placement + dependency graphs when app projections are supplied", () => {
    const x = introspect(log(), "x", {
      targets: ["local", "cloud-run"],
      flowTools: { f: ["a-tool"] },
      grants: { f: ["a-tool"] },
    });
    expect(x.placement?.targets).toEqual(["local", "cloud-run"]);
    expect(x.dependencies?.edges).toContainEqual({ from: "f", to: "a-tool", kind: "invokes" });
  });
});

describe("formatIntrospection", () => {
  it("renders all sections by default", () => {
    const text = formatIntrospection(introspect(log()));
    for (const section of ["executions:", "tasks:", "decisions:", "resources:"]) {
      expect(text).toContain(section);
    }
  });

  it("renders only the selected graph", () => {
    const text = formatIntrospection(introspect(log()), "tasks");
    expect(text).toContain("tasks:");
    expect(text).not.toContain("resources:");
  });

  it("reports an unknown graph name", () => {
    expect(formatIntrospection(introspect(log()), "bogus")).toContain('unknown graph "bogus"');
  });
});
