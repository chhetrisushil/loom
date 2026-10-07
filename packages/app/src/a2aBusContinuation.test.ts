import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InProcessA2ABus } from "./InProcessA2ABus";

// ADR 0109 D2/D6 — a task whose execution CONTINUES is still going: it is never reported as the
// failure the predecessor's missing output would suggest. The bus dispatches through the in-process
// worker, which follows the chain to its head, so the task's status is the head's.

const io = z.any();

function makeBus(runner: (ctx: never, input: unknown) => Promise<unknown>) {
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    continueAsNewEnabled: true,
    onWarn: () => {},
  });
  const flow = {
    definition: {
      _tag: "FlowDefinition" as const,
      id: "rot",
      name: "rot",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: io,
      steps: [],
    },
    runner,
  };
  runtime.registerFlow(flow.definition as never, flow.runner as never);
  const bus = new InProcessA2ABus(runtime);
  bus.registerAgent({ name: "a", description: "a", capabilities: [] } as never);
  bus.registerCapability("cap", "a", flow as never);
  return bus;
}

describe("InProcessA2ABus — a continued execution", () => {
  it("a task that continues into a completing head completes with the HEAD's output", async () => {
    const bus = makeBus((async (
      ctx: { continueAsNew(c: unknown): Promise<never> },
      input: { gen?: number } | undefined
    ) => {
      if (input?.gen === undefined) return ctx.continueAsNew({ gen: 1 });
      return "head output";
    }) as never);
    const result = await bus.dispatch("cap", {}, "go");
    expect(result.status).toBe("completed");
    expect(result.artifact).toBe("head output");
  });

  it("a task that continues into a head that parks is `working`, not failed", async () => {
    const bus = makeBus((async (
      ctx: { continueAsNew(c: unknown): Promise<never>; suspend(c: unknown): Promise<unknown> },
      input: { gen?: number } | undefined
    ) => {
      if (input?.gen === undefined) return ctx.continueAsNew({ gen: 1 });
      await ctx.suspend({ on: "ApprovalGranted" });
      return "approved";
    }) as never);
    const result = await bus.dispatch("cap", {}, "go");
    expect(result.status).toBe("working");
    expect(result.suspended?.gate).toBe("ApprovalGranted");
  });
});
