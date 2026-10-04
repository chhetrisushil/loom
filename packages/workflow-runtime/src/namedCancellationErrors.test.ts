import type { FlowDefinition } from "@loom/core";
import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { DecideScopeClosedError, ExecutionCancelledError } from "./index";
import type { FlowRunner } from "./types";

// L33 — loom's cancellation errors are NAMED, so a consumer that cannot import this
// package (loom-ui's planner) classifies a control-plane refusal by `err.name`.

const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;

function boot(runner: FlowRunner<Record<string, unknown>, Record<string, unknown>>) {
  const effects = new EffectRuntime();
  const seen: { signal?: AbortSignal; err?: unknown } = {};
  effects.register(
    "hang",
    new ToolEffect(
      (_i: unknown, ctx: EffectContext) =>
        new Promise((_res, rej) => {
          seen.signal = ctx.signal;
          ctx.signal?.addEventListener("abort", () => rej(ctx.signal?.reason), { once: true });
        })
    )
  );
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    onWarn: () => {},
  });
  const definition: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
    _tag: "FlowDefinition",
    id: "f",
    name: "f",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [],
  };
  runtime.registerFlow(definition, runner);
  return { runtime, definition, seen };
}

const noopStep = step$({
  id: "noop",
  name: "noop",
  toolId: "never-reached",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
});

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("ExecutionCancelledError", () => {
  it("is exported, named, and an Error", () => {
    const e = new ExecutionCancelledError();
    expect(e.name).toBe("ExecutionCancelledError");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ExecutionCancelledError);
    expect(e.message).toBe("execution cancelled");
  });

  it.each([
    ["no reason", undefined],
    ["a string reason", "stop"],
  ])("cancel() with %s aborts scope calls with the named error", async (_n, reason) => {
    const { runtime, definition, seen } = boot(async (ctx) => ({
      r: await ctx.decide("d", (s) => s.invokeTransient("hang", {})),
    }));
    const h = await runtime.start(definition, {}, { executionId: "x1" });
    const done = h.waitForCompletion();
    const rejected = done.catch((e) => e);
    await tick();
    await runtime.cancel("x1", reason);
    const err = await rejected;
    expect(err).toBeInstanceOf(ExecutionCancelledError);
    expect((err as Error).name).toBe("ExecutionCancelledError");
    expect((err as Error).message).toBe("Execution cancelled");
    expect(seen.signal?.reason).toBeInstanceOf(ExecutionCancelledError);
    if (reason !== undefined)
      expect((seen.signal?.reason as ExecutionCancelledError).reason).toBe(reason);
    // ONE object: the signal's reason IS the completion rejection, and it is an operator cancel.
    expect(seen.signal?.reason).toBe(err);
    expect((err as ExecutionCancelledError).kind).toBe("cancel");
  });

  it("a deadline breach aborts with the named error (message unchanged)", async () => {
    const effects = new EffectRuntime();
    effects.register(
      "hang",
      new ToolEffect(
        (_i: unknown, ctx: EffectContext) =>
          new Promise((_res, rej) => {
            ctx.signal?.addEventListener("abort", () => rej(ctx.signal?.reason), { once: true });
          })
      )
    );
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
      onWarn: () => {},
    });
    const definition: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
      _tag: "FlowDefinition",
      id: "dl",
      name: "dl",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: io,
      steps: [],
      deadlineMs: 30,
    };
    runtime.registerFlow(definition, async (ctx) => ({
      r: await ctx.decide("d", (s) => s.invokeTransient("hang", {})),
    }));
    const h = await runtime.start(definition, {}, { executionId: "dl1" });
    const err = await h.waitForCompletion().catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionCancelledError);
    expect((err as Error).message).toMatch(/^execution deadline exceeded \(deadlineMs=30\)$/);
    // Same name as an operator cancel (classified alike), told apart by `kind`.
    expect((err as ExecutionCancelledError).kind).toBe("deadline");
  });

  it("a caller-supplied Error reason is kept as-is, never wrapped", async () => {
    const own = new Error("operator pulled the plug");
    const { runtime, definition, seen } = boot(async (ctx) => ({
      r: await ctx.decide("d", (s) => s.invokeTransient("hang", {})),
    }));
    const h = await runtime.start(definition, {}, { executionId: "x2" });
    const rejected = h.waitForCompletion().catch((e) => e);
    await tick();
    await runtime.cancel("x2", own);
    expect(await rejected).toBe(own);
    expect(seen.signal?.reason).toBe(own);
  });

  it('a ctx call after cancel(id, "stop") throws the named error', async () => {
    // Cancelled while the flow is between operations: the next ctx call throws.
    let gate!: () => void;
    const wait = new Promise<void>((r) => {
      gate = r;
    });
    let thrown: unknown;
    const { runtime, definition } = boot(async (ctx) => {
      await wait;
      try {
        await ctx.run(noopStep, {});
      } catch (e) {
        thrown = e;
        throw e;
      }
      return {};
    });
    const h = await runtime.start(definition, {}, { executionId: "x3" });
    const rejected = h.waitForCompletion().catch((e) => e);
    await tick();
    await runtime.cancel("x3", "stop");
    gate();
    await rejected;
    await tick();
    expect(thrown).toBeInstanceOf(ExecutionCancelledError);
  });
});

describe("DecideScopeClosedError", () => {
  it("is exported, named, and an Error", () => {
    const e = new DecideScopeClosedError("pick");
    expect(e.name).toBe("DecideScopeClosedError");
    expect(e).toBeInstanceOf(Error);
    expect(e.decisionId).toBe("pick");
    expect(e.message).toBe('decide("pick"): decider settled');
  });

  it("a call on a settled scope rejects with the named error (message unchanged)", async () => {
    let leaked: { invokeTransient: (t: string, i: unknown) => Promise<unknown> } | undefined;
    const { runtime, definition } = boot(async (ctx) => {
      await ctx.decide("pick", (scope) => {
        leaked = scope;
        return 1;
      });
      return {};
    });
    await (await runtime.start(definition, {}, { executionId: "d1" })).waitForCompletion();
    const err = await leaked?.invokeTransient("hang", {}).catch((e) => e);
    expect(err).toBeInstanceOf(DecideScopeClosedError);
    expect((err as Error).name).toBe("DecideScopeClosedError");
    expect((err as Error).message).toMatch(/scope is closed/);
  });

  it("an unawaited call is aborted with the named error when the decider settles", async () => {
    let started: Promise<unknown> | undefined;
    const { runtime, definition, seen } = boot(async (ctx) => {
      await ctx.decide("pick", (scope) => {
        started = scope.invokeTransient("hang", {});
        started.catch(() => {});
        return 1;
      });
      return {};
    });
    await (await runtime.start(definition, {}, { executionId: "d2" })).waitForCompletion();
    expect(seen.signal?.reason).toBeInstanceOf(DecideScopeClosedError);
    expect((seen.signal?.reason as Error).name).toBe("DecideScopeClosedError");
  });
});
