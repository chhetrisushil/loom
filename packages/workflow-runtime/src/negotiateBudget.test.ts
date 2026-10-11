import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { type Budget, type ResourceDelta, meteringMiddleware } from "@loom/middleware";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// ADR 0032 — additional resource dimensions (R1) + bounded budget negotiation (R2).

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
      id: "f",
      name: "f",
      version: "1.0.0",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      steps: [A, B, C],
    },
    runner: runner as FlowRunner<unknown, unknown>,
  };
}

function makeRuntime(pricing: () => ResourceDelta, budget?: Budget) {
  const effectRuntime = new EffectRuntime([
    meteringMiddleware({ pricing, ...(budget !== undefined && { budget }), clock: () => 0 }),
  ]);
  for (const id of ["a", "b", "c"]) {
    effectRuntime.register(`${id}-tool`, new ToolEffect(async () => ({ ok: true })));
  }
  return new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime,
  });
}

const threeSteps: FlowRunner<Record<string, never>, unknown> = async (ctx) => {
  await ctx.run(A, {});
  await ctx.run(B, {});
  await ctx.run(C, {});
  return {};
};

describe("R1 — additional resource dimensions", () => {
  it("folds memBytes into _resources and enforces maxMemBytes (admission control)", async () => {
    const runtime = makeRuntime(() => ({ memBytes: 100 }), { maxMemBytes: 200 });
    const handle = await runtime.start(makeFlow(threeSteps), {});
    await expect(handle.waitForCompletion()).rejects.toThrow(/Quota exceeded/);
    const r = handle.getState().variables._resources as { memBytes?: number; count: number };
    expect(r.memBytes).toBe(200); // A + B metered, C denied
    expect(r.count).toBe(2);
  });

  it("meters netBytes/wallMs additively when the pricing reports them", async () => {
    const runtime = makeRuntime(() => ({ netBytes: 10, wallMs: 3 }));
    const handle = await runtime.start(makeFlow(threeSteps), {});
    const state = await handle.waitForCompletion();
    const r = state.variables._resources as { netBytes?: number; wallMs?: number };
    expect(r.netBytes).toBe(30);
    expect(r.wallMs).toBe(9);
  });

  it("leaves _resources byte-identical when no new dimension is metered", async () => {
    const runtime = makeRuntime(() => ({ costUsd: 1 }));
    const handle = await runtime.start(makeFlow(threeSteps), {});
    const r = (await handle.waitForCompletion()).variables._resources as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(["costUsd", "count", "ms", "tokens"]);
  });
});

describe("R2 — bounded budget negotiation", () => {
  it("grants min(request, ceiling) with no prior spend, recorded for replay", async () => {
    const runtime = makeRuntime(() => ({ costUsd: 0 }));
    const runner: FlowRunner<Record<string, never>, unknown> = async (ctx) => {
      await ctx.negotiateBudget("costUsd", 100, { id: "n", ceiling: 30 });
      return {};
    };
    const state = await (await runtime.start(makeFlow(runner), {})).waitForCompletion();
    const decisions = state.variables._decisions as Record<
      string,
      { choice: number; source?: string }
    >;
    expect(decisions.n).toMatchObject({ choice: 30, source: "negotiate" });
  });

  it("subtracts already-spent from the ceiling", async () => {
    const runtime = makeRuntime(() => ({ costUsd: 10 }));
    const runner: FlowRunner<Record<string, never>, unknown> = async (ctx) => {
      await ctx.run(A, {}); // spends $10
      await ctx.negotiateBudget("costUsd", 100, { id: "n", ceiling: 30 });
      return {};
    };
    const state = await (await runtime.start(makeFlow(runner), {})).waitForCompletion();
    const decisions = state.variables._decisions as Record<string, { choice: number }>;
    expect(decisions.n?.choice).toBe(20); // min(100, 30 − 10)
  });

  it("grants the full request when no ceiling is given (advisory, never throws)", async () => {
    const runtime = makeRuntime(() => ({ costUsd: 0 }));
    const runner: FlowRunner<Record<string, never>, unknown> = async (ctx) => {
      await ctx.negotiateBudget("tokens", 50, { id: "n" });
      return {};
    };
    const state = await (await runtime.start(makeFlow(runner), {})).waitForCompletion();
    expect(state.status).toBe("completed");
    const decisions = state.variables._decisions as Record<string, { choice: number }>;
    expect(decisions.n?.choice).toBe(50);
  });
});
