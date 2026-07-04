import { describe, expect, it } from "vitest";
import { z } from "zod";
import { flow$, step$, handler$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { capability$, CapabilityCatalog } from "@loom/capability";
import type { LlmProvider } from "@loom/llm";
import { PlannerRuntime } from "./PlannerRuntime";

const noopStep = step$({
  id: "noop",
  name: "Noop",
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  handler: handler$(async () => ({ ok: true })),
});
const noopRunner: FlowRunner<{ text: string }, { ok: boolean }> = (ctx, input) =>
  ctx.run(noopStep, { text: input.text });
const makeFlow = (id: string): RegisteredFlow<{ text: string }, { ok: boolean }> => ({
  definition: flow$({
    id,
    name: id,
    version: "1.0.0",
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ ok: z.boolean() }),
    steps: [noopStep],
  }),
  runner: noopRunner,
});

function makeCatalog(): CapabilityCatalog {
  return new CapabilityCatalog()
    .register(
      capability$({
        id: "collect-metrics",
        intent: "Collect metrics from a cluster",
        tags: ["metrics"],
        inputSchema: z.object({ text: z.string() }),
        flow: makeFlow("collect-metrics"),
      })
    )
    .register(
      capability$({
        id: "root-cause",
        intent: "Analyze metrics to find the root cause",
        tags: ["analysis"],
        inputSchema: z.object({ text: z.string() }),
        flow: makeFlow("root-cause"),
      })
    );
}

describe("PlannerRuntime", () => {
  it("builds a heuristic plan from the catalog when no provider is set", async () => {
    const planner = new PlannerRuntime({ catalog: makeCatalog() });
    const plan = await planner.plan("collect metrics then find root cause");
    expect(plan.goal).toContain("metrics");
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps.map((s) => s.capabilityId)).toContain("collect-metrics");
  });

  it("builds an ordered plan from the model when a provider is set", async () => {
    const provider: LlmProvider = {
      complete: async () => ({
        content:
          'Here is the plan: [{"capabilityId":"collect-metrics","rationale":"gather data"},' +
          '{"capabilityId":"root-cause","rationale":"analyze"}]',
        stopReason: "end_turn",
      }),
    };
    const planner = new PlannerRuntime({ catalog: makeCatalog(), provider });
    const plan = await planner.plan("diagnose the incident");
    expect(plan.steps.map((s) => s.capabilityId)).toEqual(["collect-metrics", "root-cause"]);
    expect(plan.steps[0]?.rationale).toBe("gather data");
  });

  it("drops model steps that reference unknown capability ids", async () => {
    const provider: LlmProvider = {
      complete: async () => ({
        content: '[{"capabilityId":"made-up"},{"capabilityId":"root-cause"}]',
        stopReason: "end_turn",
      }),
    };
    const planner = new PlannerRuntime({ catalog: makeCatalog(), provider });
    const plan = await planner.plan("x");
    expect(plan.steps.map((s) => s.capabilityId)).toEqual(["root-cause"]);
  });

  it("respects maxSteps", async () => {
    const planner = new PlannerRuntime({ catalog: makeCatalog(), maxSteps: 1 });
    const plan = await planner.plan("metrics analysis root cause");
    expect(plan.steps.length).toBeLessThanOrEqual(1);
  });
});
