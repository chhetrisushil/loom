import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InProcessA2ABus } from "./InProcessA2ABus";

const io = z.object({}).passthrough();

function makeBus(maxTasks?: number) {
  const effects = new EffectRuntime();
  effects.register("noop", new ToolEffect(async () => ({ ok: true })));
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const stepDef = step$({
    id: "s0",
    name: "s0",
    toolId: "noop",
    inputSchema: io,
    outputSchema: io,
  });
  const flow = {
    definition: {
      _tag: "FlowDefinition" as const,
      id: "f",
      name: "f",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: io,
      steps: [stepDef],
    },
    runner: async (ctx: { run: (s: unknown, i: unknown) => Promise<unknown> }) => {
      await ctx.run(stepDef, {});
      return { ok: true };
    },
  };
  runtime.registerFlow(flow.definition as never, flow.runner as never);
  const bus = new InProcessA2ABus(runtime, undefined, maxTasks !== undefined ? { maxTasks } : {});
  bus.registerAgent({ name: "a", description: "a", capabilities: [] } as never);
  bus.registerCapability("cap", "a", flow as never);
  return bus;
}

describe("InProcessA2ABus — task retention", () => {
  it("does not grow without bound across many submits", async () => {
    const bus = makeBus(10);
    for (let i = 0; i < 60; i++) await bus.dispatch("cap", {}, "go");
    // Every submit used to record a task result that nothing ever removed, holding its
    // artifact text for the life of the process.
    expect(bus.retainedTasks).toBeLessThanOrEqual(10);
  });

  it("keeps the most recent tasks retrievable", async () => {
    const bus = makeBus(5);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await bus.dispatch("cap", {}, "go")).taskId);
    const recent = ids.slice(-5);
    for (const id of recent) expect(bus.getTask(id)).toBeDefined();
    // Evicted tasks answer the same way an unknown id always did.
    expect(bus.getTask(ids[0] as string)).toBeUndefined();
  });

  it("mints unique execution ids even though eviction shrinks the map", async () => {
    const bus = makeBus(4);
    // Ids were derived from `tasks.size`. That is fine while the map only grows, and breaks
    // the moment it evicts — so capping retention REQUIRES a monotonic counter, or capping
    // would have introduced an id-collision bug instead of fixing a leak.
    const results = await Promise.all(
      Array.from({ length: 25 }, () => bus.dispatch("cap", {}, "go"))
    );
    const ids = results.map((r) => r.taskId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
