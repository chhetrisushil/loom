import type { FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { ExecutionPackage } from "@loom/worker-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalWorkerRuntime } from "./LocalWorkerRuntime";

// ADR 0109 D6 — a dispatch of an execution that CONTINUES reports what the HEAD of its chain did,
// not a failure (the interim mapping W2-0 shipped) and never a completion of the predecessor.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const definition = (id: string): FlowDefinition<unknown, unknown> => ({
  _tag: "FlowDefinition",
  id,
  name: id,
  version: "1.0.0",
  ...io,
  steps: [],
});

function setup(runner: FlowRunner<unknown, unknown>, maxChainHops?: number) {
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    continueAsNewEnabled: true,
    ...(maxChainHops !== undefined && { maxChainHops }),
    onWarn: () => {},
  });
  runtime.registerFlow(definition("rot"), runner);
  const worker = new LocalWorkerRuntime(runtime);
  const pkg = (id: string, input: unknown = {}): ExecutionPackage => ({
    executionId: id,
    workflowId: "rot",
    flowId: "rot",
    input,
  });
  return { runtime, worker, pkg };
}

describe("LocalWorkerRuntime — follow-to-head (ADR 0109 D6)", () => {
  it("a dispatch that continues into a SUSPENDED head reports `suspended`, under the dispatched id", async () => {
    const { worker, pkg } = setup(async (ctx, input) => {
      if ((input as { gen?: number } | undefined)?.gen === undefined) {
        return ctx.continueAsNew({ gen: 1 });
      }
      await ctx.suspend({ on: "approval" });
      return "approved";
    });
    const lease = await worker.allocate({ executionId: "d1", workflowId: "rot" } as never);
    const result = await worker.execute(lease, pkg("d1"));
    expect(result.status).toBe("suspended"); // the head is parked: a normal, non-terminal outcome
    expect(result.executionId).toBe("d1");
    expect(result.state?.status).toBe("suspended");
    expect(result.suspendedOn?.on).toBe("approval");
  });

  it("a dispatch that continues into a COMPLETING head reports `completed` with the head's output", async () => {
    const { worker, pkg } = setup(async (ctx, input) => {
      const gen = (input as { gen?: number } | undefined)?.gen ?? 0;
      if (gen < 2) return ctx.continueAsNew({ gen: gen + 1 });
      return { finishedIn: gen };
    });
    const lease = await worker.allocate({ executionId: "d2", workflowId: "rot" } as never);
    const result = await worker.execute(lease, pkg("d2"));
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ finishedIn: 2 });
    expect(result.executionId).toBe("d2");
  });

  it("a redispatch of an already-continued execution follows the chain too (the recovery short-circuit)", async () => {
    const { worker, pkg } = setup(async (ctx, input) => {
      if ((input as { gen?: number } | undefined)?.gen === undefined) {
        return ctx.continueAsNew({ gen: 1 });
      }
      return "done";
    });
    const lease = await worker.allocate({ executionId: "d3", workflowId: "rot" } as never);
    await worker.execute(lease, pkg("d3"));
    const again = await worker.allocate({ executionId: "d3", workflowId: "rot" } as never);
    const redispatched = await worker.execute(again, pkg("d3"));
    expect(redispatched.status).toBe("completed");
    expect(redispatched.output).toBe("done");
  });

  it("an unreadable chain is reported as the fail-safe `failed`, never as `completed`", async () => {
    const { runtime, worker, pkg } = setup(async (ctx) => ctx.continueAsNew({ gen: 1 }));
    // a log that says "continued to x" where x does not exist (retention-deleted, say)
    await runtime.events.append({
      id: "g-0",
      workflowId: "rot",
      executionId: "g",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: { input: {} },
    });
    await runtime.events.append({
      id: "g-1",
      workflowId: "rot",
      executionId: "g",
      eventType: "EXECUTION_CONTINUED",
      sequence: 1,
      timestamp: 2,
      payload: { successorId: "g~1", chainId: "g", generation: 1 },
      metadata: { kernel: true },
    });
    const lease = await worker.allocate({ executionId: "g", workflowId: "rot" } as never);
    const result = await worker.execute(lease, pkg("g"));
    expect(result.status).toBe("failed");
  });

  it("a flow that rotates 10 times (more than maxChainHops) and then completes is a COMPLETION, not a failure", async () => {
    const { worker, pkg } = setup(async (ctx, input) => {
      const gen = (input as { gen?: number } | undefined)?.gen ?? 0;
      if (gen < 10) return ctx.continueAsNew({ gen: gen + 1 });
      return { finishedIn: gen };
    });
    const lease = await worker.allocate({ executionId: "ten", workflowId: "rot" } as never);
    const result = await worker.execute(lease, pkg("ten"));
    expect(result.status).toBe("completed");
    expect(result.executionId).toBe("ten");
    expect(result.output).toEqual({ finishedIn: 10 });
  });

  it("an unverifiable deepest generation past maxChainHops is a failed dispatch, never a throw or a completion", async () => {
    const { runtime, worker, pkg } = setup(async (ctx, input) => {
      const gen = (input as { gen?: number } | undefined)?.gen ?? 0;
      if (gen < 6) return ctx.continueAsNew({ gen: gen + 1 });
      await ctx.suspend({ on: "end" });
      return "end";
    }, 2);
    const h = await runtime.start(runtime.getFlow("rot")!, {}, { executionId: "sq" });
    await h.waitForCompletion().catch(() => undefined);
    for (let i = 0; i < 200 && (await runtime.loadState("sq~6"))?.status !== "suspended"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await runtime.events.append({
      id: "sq~7-0",
      workflowId: "rot",
      executionId: "sq~7",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: {
        input: {},
        chainId: "sq",
        generation: 7,
        continuedFrom: { executionId: "elsewhere" },
      },
    });
    const lease = await worker.allocate({ executionId: "sq", workflowId: "rot" } as never);
    const result = await worker.execute(lease, pkg("sq"));
    expect(result.status).toBe("failed");
  });
});
