import { step$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow, WorkflowContext } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type FlowResolver, simulateDeploy } from "./deploySim";

const io = { inputSchema: z.object({}), outputSchema: z.object({}) };
const aStep = step$({ id: "a", name: "A", toolId: "a-tool", ...io });
const bStep = step$({ id: "b", name: "B", toolId: "b-tool", ...io });

const straightRunner: FlowRunner<unknown, unknown> = async (ctx) => {
  await ctx.run(aStep, {});
  await ctx.run(bStep, {});
  return { done: true };
};
const gatedRunner: FlowRunner<unknown, unknown> = async (ctx: WorkflowContext) => {
  await ctx.run(aStep, {});
  await ctx.suspend({ on: "Approved" });
  await ctx.run(bStep, {});
  return { done: true };
};

function def(version = "1.0.0") {
  return {
    _tag: "FlowDefinition",
    id: "flow",
    name: "Flow",
    version,
    ...io,
    steps: [aStep, bStep],
  };
}

async function record(runner: FlowRunner<unknown, unknown>): Promise<EventEnvelope[]> {
  const effects = new EffectRuntime();
  effects.register("a-tool", new ToolEffect(async () => ({ ok: 1 })));
  effects.register("b-tool", new ToolEffect(async () => ({ ok: 2 })));
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const flow = { definition: def(), runner } as RegisteredFlow;
  runtime.registerFlow(flow.definition, flow.runner);
  const handle = await runtime.start(flow, {});
  await Promise.race([handle.waitForCompletion(), handle.waitForSuspend()]);
  return eventStore.read(handle.executionId);
}

/** A resolver exposing a chosen new definition (or nothing, to simulate removal). */
function resolver(newDef?: ReturnType<typeof def>): FlowResolver {
  return { getFlow: (id) => (newDef && id === "flow" ? { definition: newDef } : undefined) };
}

describe("simulateDeploy", () => {
  it("passes when the new deployment is identical", async () => {
    const log = await record(straightRunner);
    const report = simulateDeploy([log], resolver(def()));
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(1);
    expect(report.issues.filter((i) => i.severity === "breaking")).toEqual([]);
  });

  it("flags a breaking flow removal (in-flight run stranded)", async () => {
    const log = await record(straightRunner);
    const report = simulateDeploy([log], resolver(undefined));
    expect(report.ok).toBe(false);
    expect(report.issues[0]?.kind).toBe("flow-missing");
  });

  it("flags a breaking step rename that orphans a recorded output", async () => {
    const log = await record(straightRunner);
    const renamed = {
      ...def(),
      steps: [step$({ id: "a-renamed", name: "A", toolId: "a-tool", ...io }), bStep],
    };
    const report = simulateDeploy([log], resolver(renamed));
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === "step-removed" && i.detail.includes('"a"'))).toBe(
      true
    );
  });

  it("warns about an in-flight suspended execution carried across the deploy", async () => {
    const log = await record(gatedRunner);
    const report = simulateDeploy([log], resolver(def()));
    expect(report.ok).toBe(true); // suspended-carryover is a warning, not breaking
    const carry = report.issues.find((i) => i.kind === "suspended-carryover");
    expect(carry?.detail).toContain("Approved");
  });
});
