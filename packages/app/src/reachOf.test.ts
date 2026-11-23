import { SkillRegistry } from "@loomwork/agent";
import { agent$, flow$, skill$, step$, tool$ } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { WorkflowRuntime } from "@loomwork/workflow-runtime";
import type { FlowRunner } from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentLoopReach } from "./reachCore";
import { reachOf } from "./reachOf";

const mkTool = (id: string) =>
  tool$({
    id,
    name: id,
    description: id,
    kind: "tool",
    inputSchema: z.object({}),
    outputSchema: z.object({}),
  });

const mkStep = (toolId: string) =>
  step$({
    id: `s-${toolId}`,
    name: toolId,
    toolId,
    inputSchema: z.object({}),
    outputSchema: z.object({}),
  });

function runtimeOf(flows: Record<string, string[]>): WorkflowRuntime {
  const effects = new EffectRuntime();
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  for (const [id, toolIds] of Object.entries(flows)) {
    for (const t of toolIds) effects.register(t, new ToolEffect(async () => ({})));
    runtime.registerFlow(
      flow$({
        id,
        name: id,
        version: "1.0.0",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        steps: toolIds.map(mkStep),
      }),
      (async () => ({})) as FlowRunner<unknown, unknown>
    );
  }
  return runtime;
}

const loop = (tools: string[], skillTools: string[] = [], catalog: string[] = []) => ({
  definition: agent$({ id: "a", name: "a", tools: tools.map(mkTool) } as never),
  skills: new SkillRegistry().register(
    skill$({
      id: "sk",
      name: "sk",
      description: "sk",
      instructions: "x",
      tools: skillTools.map(mkTool),
    } as never)
  ),
  toolSearch: { catalog: catalog.map(mkTool) },
});

describe("reachOf (ADR 0150 D9, S-R5)", () => {
  it("returns a flow's step effects, sorted", () => {
    const rt = runtimeOf({ f: ["b", "a"] });
    expect(reachOf(rt, "f")).toEqual(["a", "b"]);
  });

  it("follows declared child flows transitively and survives a cycle", () => {
    // kills: an implementation that reads only the root flow, or recurses forever
    const rt = runtimeOf({ p: ["p1"], c: ["c1"], g: ["g1"], other: ["x"] });
    const children = { p: ["c"], c: ["g", "p"] };
    expect(reachOf(rt, "p", { children })).toEqual(["c1", "g1", "p1"]);
    expect(reachOf(rt, "c", { children })).toEqual(["c1", "g1", "p1"]);
    expect(reachOf(rt, "p")).toEqual(["p1"]);
  });

  it("an agentLoop$ reach is its tools + EVERY skill's tools + the toolSearch catalog", () => {
    // kills: tools-only, tools+catalog without skills, or catalog dropped
    const l = loop(["own"], ["skill-tool"], ["cat"]);
    expect(agentLoopReach(l)).toEqual(["cat", "own", "skill-tool"]);
    const rt = runtimeOf({ f: ["step"] });
    expect(reachOf(rt, "f", { agentLoops: { f: [l] } })).toEqual([
      "cat",
      "own",
      "skill-tool",
      "step",
    ]);
  });

  it("an unknown flow reaches nothing, and an inherited key is not a flow", () => {
    const rt = runtimeOf({ f: ["a"] });
    expect(reachOf(rt, "nope")).toEqual([]);
    expect(reachOf(rt, "f", { children: { f: [] }, agentLoops: {} })).toEqual(["a"]);
    expect(reachOf(rt, "constructor", { children: {}, agentLoops: {} })).toEqual([]);
  });

  describe("agentLoopReach: the loop's own ring-routed effects (R30 I1)", () => {
    const base = { definition: agent$({ id: "a", name: "a", tools: [] } as never) };
    const reach = (c: object) => agentLoopReach({ ...base, ...c } as never);

    it("includes modelToolId", () => {
      // kills: reach without the model call, which a derived grant would then deny
      expect(reach({ modelToolId: "llm" })).toEqual(["llm"]);
    });
    it("includes a string reasoningToolId", () => {
      expect(reach({ reasoningToolId: "model:r" })).toEqual(["model:r"]);
    });
    it("expands a per-route reasoningToolId over the reasoning runtime's routes", () => {
      // kills: ignoring a function reasoningToolId, or calling it with no routes
      const reasoning = { availableRoutes: [{ id: "fast" }, { id: "deep" }] };
      expect(reach({ reasoning, reasoningToolId: (r: string) => `model:${r}` })).toEqual([
        "model:deep",
        "model:fast",
      ]);
    });
    it("includes recall.toolId and compaction.toolId", () => {
      expect(reach({ recall: { toolId: "recall" }, compaction: { toolId: "sum" } })).toEqual([
        "recall",
        "sum",
      ]);
    });
    it("includes writeBack.toolId only for an object that has one", () => {
      // kills: reading toolId off `false` / an allowDirect config
      expect(reach({ writeBack: { toolId: "wb" } })).toEqual(["wb"]);
      expect(reach({ writeBack: { allowDirect: true } })).toEqual([]);
      expect(reach({ writeBack: false })).toEqual([]);
    });
    it("reachOf (the input to deriveGrant) contains the loop's model tool id", () => {
      const rt = runtimeOf({ f: ["step"] });
      const l = { ...loop(["own"]), modelToolId: "llm" };
      // deriveGrant(reach).effects is exactly reach (see its own test), so this is the grant's effects
      expect(reachOf(rt, "f", { agentLoops: { f: [l] } })).toContain("llm");
    });
  });
});
