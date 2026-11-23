import { step$ } from "@loomwork/core";
import type { FlowDefinition } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import type { EffectMiddleware } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner } from "./types";

// ── ADR 0151 D6: `EffectContext.resources` is a COPY, never the fold-owned `_resources` ────────
//
// A middleware that mutates `ctx.resources` (or its `custom`) must not change the execution's live
// fold: the K3 metering, nestedBudget and lease reads, and replay, all read that fold.

const io = { inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) };
const stepA = step$({ id: "a", name: "A", toolId: "tool-a", ...io });
const stepB = step$({ id: "b", name: "B", toolId: "tool-b", ...io });

type Res = { tokens?: number; custom?: Record<string, number> };
const resOf = (vars: Record<string, unknown>): Res => (vars._resources ?? {}) as Res;

const isB = (id: string): boolean => id === "b" || id === "tool-b";

function boot(mode: "step" | "decide", eventStore = new InMemoryAsyncEventStore()) {
  const seen: Res[] = [];
  // Meters once per tool-a call; everything else only reads.
  const meter: EffectMiddleware = async (ctx, _i, next) => {
    if (ctx.stepId === "a") {
      ctx.emit("RESOURCE_METERED", { tokens: 5, custom: { x: 1 } });
      await ctx.flush?.();
    }
    return next();
  };
  // Mutates what it was handed, on the tool that runs AFTER the meter landed in the fold.
  const mutator: EffectMiddleware = async (ctx, _i, next) => {
    if (isB(ctx.stepId)) {
      const r = ctx.resources as { tokens?: number; custom?: Record<string, number> };
      r.tokens = 0;
      if (r.custom !== undefined) r.custom.x = 999;
      (r as Record<string, unknown>).injected = true;
    }
    return next();
  };
  const reader: EffectMiddleware = async (ctx, _i, next) => {
    if (isB(ctx.stepId) && ctx.readResources !== undefined) {
      seen.push(ctx.readResources() as Res);
    }
    return next();
  };
  const effects = new EffectRuntime([meter, mutator, reader]);
  effects.register("tool-a", new ToolEffect(async () => ({ ok: true })));
  effects.register("tool-b", new ToolEffect(async () => ({ ok: true })));
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    onWarn: () => {},
  });
  const runner: FlowRunner<Record<string, never>, { ok: boolean }> = async (ctx) => {
    await ctx.run(stepA, {});
    if (mode === "step") await ctx.run(stepB, {});
    else await ctx.decide("d", (scope) => scope.invokeTransient("tool-b", {}));
    return { ok: true };
  };
  const definition: FlowDefinition<Record<string, never>, { ok: boolean }> = {
    _tag: "FlowDefinition",
    id: "res",
    name: "res",
    version: "1.0.0",
    inputSchema: io.inputSchema,
    outputSchema: io.outputSchema,
    steps: [stepA, stepB],
  };
  runtime.registerFlow(definition, runner);
  return { runtime, flow: { definition, runner }, seen };
}

describe("ADR 0151 D6: ctx.resources is a copy", () => {
  it("a middleware mutating ctx.resources / custom does not change the fold or a later readResources()", async () => {
    const a = boot("step");
    const h = await a.runtime.start(a.flow, {}, { executionId: "res-1" });
    await h.waitForCompletion();
    expect(a.seen).toHaveLength(1);
    expect(a.seen[0]?.tokens).toBe(5);
    expect(a.seen[0]?.custom?.x).toBe(1);
    expect(a.seen[0]).not.toHaveProperty("injected");
    const state = await a.runtime.loadState("res-1", a.runtime.systemOptions());
    const r = resOf(state?.variables ?? {});
    expect(r.tokens).toBe(5);
    expect(r.custom?.x).toBe(1);
    expect(r).not.toHaveProperty("injected");
  });

  it("the decide scope's transient call gets a copy too", async () => {
    const a = boot("decide");
    const h = await a.runtime.start(a.flow, {}, { executionId: "res-2" });
    await h.waitForCompletion();
    const state = await a.runtime.loadState("res-2", a.runtime.systemOptions());
    const r = resOf(state?.variables ?? {});
    expect(r.tokens).toBe(5);
    expect(r.custom?.x).toBe(1);
    expect(r).not.toHaveProperty("injected");
  });

  it("a replay after such a mutation does not diverge", async () => {
    const store = new InMemoryAsyncEventStore();
    const a = boot("step", store);
    const h = await a.runtime.start(a.flow, {}, { executionId: "res-3" });
    await h.waitForCompletion();
    const live = resOf(
      (await a.runtime.loadState("res-3", a.runtime.systemOptions()))?.variables ?? {}
    );
    // A fresh fold of the log (what a replay produces) equals the totals the middleware could not change.
    const b = boot("step", store);
    const replayed = resOf(
      (await b.runtime.loadState("res-3", b.runtime.systemOptions()))?.variables ?? {}
    );
    expect(live.tokens).toBe(5);
    expect(replayed).toEqual(live);
  });
});
