import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TimerService } from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { TIMER_FIRED } from "./types";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── T1 — durable timers: ctx.sleep / ctx.sleepUntil / suspend({ timeout }) ────

const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ done: z.boolean() });
type In = { n: number };
type Out = { done: boolean };

const afterStep = step$({
  id: "after-wake",
  name: "After wake",
  toolId: "after-tool",
  inputSchema,
  outputSchema,
});

function makeFlow(flowId: string, runner: FlowRunner<In, Out>): RegisteredFlow<In, Out> {
  const definition: FlowDefinition<In, Out> = {
    _tag: "FlowDefinition",
    id: flowId,
    name: flowId,
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: [afterStep],
  };
  return { definition, runner };
}

function boot(
  flow: RegisteredFlow<In, Out>,
  shared?: {
    eventStore: InMemoryAsyncEventStore;
    snapshotStore: InMemoryAsyncSnapshotStore;
    timerStore: InMemoryTimerStore;
  },
  afterFn: () => Promise<Out> = async () => ({ done: true }),
  withTimerStore = true
) {
  const effects = new EffectRuntime();
  effects.register("after-tool", new ToolEffect(afterFn));
  // Share ONLY the stores — each boot gets its own runtime/effects.
  const stores = shared
    ? {
        eventStore: shared.eventStore,
        snapshotStore: shared.snapshotStore,
        timerStore: shared.timerStore,
      }
    : {
        eventStore: new InMemoryAsyncEventStore(),
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        timerStore: new InMemoryTimerStore(),
      };
  const runtime = new WorkflowRuntime({
    eventStore: stores.eventStore,
    snapshotStore: stores.snapshotStore,
    effectRuntime: effects,
    ...(withTimerStore && { timerStore: stores.timerStore }),
  });
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, ...stores };
}

describe("T1.1 — ctx.sleep / ctx.sleepUntil record the wake in the log", () => {
  it("sleep suspends durably with wakeAt in the EXECUTION_SUSPENDED condition + a timer row", async () => {
    const flow = makeFlow("sleepy", async (ctx, input) => {
      await ctx.sleep(60_000);
      return await ctx.run(afterStep, input);
    });
    const app = boot(flow);

    const before = Date.now();
    const handle = await app.runtime.start(flow, { n: 1 }, { executionId: "t1-1" });
    const state = await handle.waitForSuspend();

    expect(state.status).toBe("suspended");
    expect(state.suspendedOn?.on).toBe(TIMER_FIRED);
    const wakeAt = state.suspendedOn?.wakeAt;
    expect(wakeAt).toBeGreaterThanOrEqual(before + 60_000);

    // The wake time entered the LOG exactly once (P9).
    const events = await app.eventStore.read("t1-1");
    const suspended = events.find((e: EventEnvelope) => e.eventType === "EXECUTION_SUSPENDED");
    expect((suspended?.payload as { condition?: { wakeAt?: number } }).condition?.wakeAt).toBe(
      wakeAt
    );

    // …and is findable without scanning logs: the timer row exists.
    expect(await app.timerStore.due(Number.MAX_SAFE_INTEGER)).toEqual([
      { executionId: "t1-1", wakeAt },
    ]);
  });

  it("TimerService fires a due wake: TIMER_FIRED logged, flow continues past the sleep", async () => {
    const afterFn = vi.fn(async () => ({ done: true }));
    const flow = makeFlow("sleepy-fire", async (ctx, input) => {
      await ctx.sleepUntil(Date.now() + 30); // near-immediate wake
      return await ctx.run(afterStep, input);
    });
    const app = boot(flow, undefined, afterFn);
    const service = new TimerService(app.runtime, app.timerStore);

    const handle = await app.runtime.start(flow, { n: 1 }, { executionId: "t1-2" });
    await handle.waitForSuspend();
    expect(afterFn).not.toHaveBeenCalled();

    await service.tick(Date.now() + 60); // deterministic poll past the wake

    const state = await app.runtime.loadState("t1-2");
    expect(state?.status).toBe("completed");
    expect(afterFn).toHaveBeenCalledTimes(1);

    const events = await app.eventStore.read("t1-2");
    const fired = events.filter((e: EventEnvelope) => e.eventType === "TIMER_FIRED");
    expect(fired.length).toBe(1);
    // Folded audit: scheduled wakeAt + actual firedAt.
    const timers = state?.variables._timers as Array<{ wakeAt?: number; firedAt?: number }>;
    expect(timers?.length).toBe(1);
    expect(timers?.[0]?.wakeAt).toBeDefined();
    // Retired: no longer due.
    expect(await app.timerStore.due(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("the wake SURVIVES a restart: a fresh runtime + service over the same stores fires it", async () => {
    const flow = makeFlow("sleepy-restart", async (ctx, input) => {
      await ctx.sleepUntil(Date.now() + 20);
      return await ctx.run(afterStep, input);
    });
    const a = boot(flow);
    const handle = await a.runtime.start(flow, { n: 1 }, { executionId: "t1-3" });
    await handle.waitForSuspend();
    // "Process kill": runtime A is abandoned; no service ever ran on it.

    const b = boot(flow, a); // fresh runtime over the SAME stores
    const service = new TimerService(b.runtime, b.timerStore);
    await service.tick(Date.now() + 60);

    expect((await b.runtime.loadState("t1-3"))?.status).toBe("completed");
  });

  it("wakes exactly once: repeated polls never double-fire", async () => {
    const flow = makeFlow("sleepy-once", async (ctx, input) => {
      await ctx.sleepUntil(Date.now() + 10);
      return await ctx.run(afterStep, input);
    });
    const app = boot(flow);
    const service = new TimerService(app.runtime, app.timerStore);

    const handle = await app.runtime.start(flow, { n: 1 }, { executionId: "t1-4" });
    await handle.waitForSuspend();

    await service.tick(Date.now() + 50);
    await service.tick(Date.now() + 100);
    await service.tick(Date.now() + 150);

    const events = await app.eventStore.read("t1-4");
    expect(events.filter((e: EventEnvelope) => e.eventType === "TIMER_FIRED").length).toBe(1);
    expect(events.filter((e: EventEnvelope) => e.eventType === "EXECUTION_RESUMED").length).toBe(1);
  });

  it("a manual resume beats the timer: the stale timer retires without firing (idempotent)", async () => {
    const flow = makeFlow("sleepy-raced", async (ctx, input) => {
      await ctx.sleepUntil(Date.now() + 10);
      return await ctx.run(afterStep, input);
    });
    const app = boot(flow);
    const service = new TimerService(app.runtime, app.timerStore);

    const handle = await app.runtime.start(flow, { n: 1 }, { executionId: "t1-5" });
    await handle.waitForSuspend();

    // An operator resumes by hand before the poller gets there.
    const resumed = await app.runtime.resume("t1-5", { eventType: "ManualWake", payload: {} });
    await resumed.waitForCompletion();

    await service.tick(Date.now() + 50);
    const events = await app.eventStore.read("t1-5");
    expect(events.some((e: EventEnvelope) => e.eventType === "TIMER_FIRED")).toBe(false);
    expect(await app.timerStore.due(Number.MAX_SAFE_INTEGER)).toEqual([]); // retired anyway
  });
});

describe("T1 (A3) — suspend({ timeout }) unification", () => {
  const gated = (flowId: string) =>
    makeFlow(flowId, async (ctx, input) => {
      await ctx.suspend({ on: "Approval", timeout: 40 });
      return await ctx.run(afterStep, input);
    });

  it("with a timer store wired, the timeout becomes a durable wake and fires", async () => {
    const app = boot(gated("gated-wired"));
    const service = new TimerService(app.runtime, app.timerStore);

    const handle = await app.runtime.start(gated("gated-wired"), { n: 1 }, { executionId: "t1-6" });
    const state = await handle.waitForSuspend();
    expect(state.suspendedOn?.wakeAt).toBeDefined(); // derived ONCE, recorded durably

    await service.tick(Date.now() + 100);
    expect((await app.runtime.loadState("t1-6"))?.status).toBe("completed");
  });

  it("UNWIRED, the timeout stays historical no-fire metadata — byte-identical condition (G2)", async () => {
    const app = boot(gated("gated-unwired"), undefined, async () => ({ done: true }), false);

    const handle = await app.runtime.start(
      gated("gated-unwired"),
      { n: 1 },
      { executionId: "t1-7" }
    );
    const state = await handle.waitForSuspend();

    expect(state.suspendedOn?.wakeAt).toBeUndefined();
    expect(await app.timerStore.due(Number.MAX_SAFE_INTEGER)).toEqual([]); // nothing scheduled
    expect((await app.runtime.loadState("t1-7"))?.status).toBe("suspended"); // never fires
  });
});
