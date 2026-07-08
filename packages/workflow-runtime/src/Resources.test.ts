import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { meteringMiddleware } from "@loom/middleware";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { FlowRunner, RegisteredFlow } from "./types";
import { WorkflowRuntime } from "./WorkflowRuntime";

// K3 integration: resource accounting accumulates across a flow's effects, and a
// budget denies further effects once spent (admission control) — all durably folded
// into variables._resources.

const mkStep = (id: string) =>
  step$({
    id,
    name: id,
    toolId: `${id}-tool`,
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
  });
const [A, B, C] = [mkStep("a"), mkStep("b"), mkStep("c")];

function makeFlow(runner: FlowRunner<Record<string, never>, unknown>): RegisteredFlow {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: "metered-flow",
      name: "Metered Flow",
      version: "1.0.0",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      steps: [A, B, C],
    },
    runner: runner as FlowRunner<unknown, unknown>,
  };
}

function makeRuntime(budgetUsd: number) {
  const effectRuntime = new EffectRuntime([
    // Each effect costs $1; clock fixed so ms is deterministic.
    meteringMiddleware({ pricing: () => ({ costUsd: 1 }), budget: { maxCostUsd: budgetUsd }, clock: () => 0 }),
  ]);
  for (const id of ["a", "b", "c"]) {
    effectRuntime.register(`${id}-tool`, new ToolEffect(async () => ({ ok: true })));
  }
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime,
  });
  return runtime;
}

const runner: FlowRunner<Record<string, never>, unknown> = async (ctx) => {
  await ctx.run(A, {});
  await ctx.run(B, {});
  await ctx.run(C, {});
  return {};
};

describe("K3 — resource accounting & quotas in a durable flow", () => {
  it("accumulates cost and denies the effect that would exceed the budget", async () => {
    const runtime = makeRuntime(2); // budget $2 ⇒ A,B run (total $2), C denied
    const handle = await runtime.start(makeFlow(runner), {});
    await expect(handle.waitForCompletion()).rejects.toThrow(/Quota exceeded/);
    const state = handle.getState();

    expect(state.status).toBe("failed");
    expect(state.frames.a?.status).toBe("completed");
    expect(state.frames.b?.status).toBe("completed");
    expect(state.frames.c?.status).toBe("failed");

    const r = state.variables._resources as {
      costUsd: number;
      count: number;
      exceeded?: boolean;
    };
    expect(r.costUsd).toBe(2);
    expect(r.count).toBe(2); // only A and B were metered
    expect(r.exceeded).toBe(true);
  });

  it("runs everything when within budget and totals the spend", async () => {
    const runtime = makeRuntime(10);
    const handle = await runtime.start(makeFlow(runner), {});
    const state = await handle.waitForCompletion();

    expect(state.status).toBe("completed");
    const r = state.variables._resources as { costUsd: number; count: number; exceeded?: boolean };
    expect(r.costUsd).toBe(3);
    expect(r.count).toBe(3);
    expect(r.exceeded).toBeUndefined();
  });
});
