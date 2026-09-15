import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── A declared deadline that nothing can fire ────────────────────────────────
//
// `suspend({ timeout })` only becomes a durable `wakeAt` when a TimerStore is wired.
// Unwired, the condition is committed without one — byte-identically, and silently.
// That is invisible while everything runs in one process, and becomes a permanently
// parked execution the moment compute is split: a worker built as "a runtime with the
// flows registered" drops every timeout of every execution it suspends.

const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ done: z.boolean() });
type In = { n: number };
type Out = { done: boolean };

const afterStep = step$({
  id: "after",
  name: "After",
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

function boot(flow: RegisteredFlow<In, Out>, opts: { timers: boolean }) {
  const effects = new EffectRuntime();
  effects.register("after-tool", new ToolEffect(async () => ({ done: true })));
  const eventStore = new InMemoryAsyncEventStore();
  const onWarn = vi.fn();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    onWarn,
    ...(opts.timers && { timerStore: new InMemoryTimerStore() }),
  });
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, eventStore, onWarn };
}

const timedGate = (flowId: string, timeout?: number) =>
  makeFlow(flowId, async (ctx, input) => {
    await ctx.suspend({ on: "Approval", ...(timeout !== undefined && { timeout }) });
    return await ctx.run(afterStep, input);
  });

describe("a timeout no runtime can honour is said out loud", () => {
  it("warns, naming the flow and the gate, when no TimerStore is wired", async () => {
    const flow = timedGate("no-store", 60_000);
    const app = boot(flow, { timers: false });
    await (await app.runtime.start(flow, { n: 1 }, { executionId: "d1" })).waitForSuspend();

    expect(app.onWarn).toHaveBeenCalledTimes(1);
    const msg = String(app.onWarn.mock.calls[0]?.[0]);
    expect(msg).toContain("no-store");
    expect(msg).toContain("Approval");
    expect(msg).toContain("TimerStore");
  });

  it("says nothing when the deadline IS recorded", async () => {
    const flow = timedGate("with-store", 60_000);
    const app = boot(flow, { timers: true });
    const state = await (
      await app.runtime.start(flow, { n: 1 }, { executionId: "d2" })
    ).waitForSuspend();

    expect(state.suspendedOn?.wakeAt).toBeDefined();
    expect(app.onWarn).not.toHaveBeenCalled();
  });

  it("says nothing about an untimed gate — an open-ended wait is not a dropped deadline", async () => {
    const flow = timedGate("untimed"); // suspend({ on }) with no timeout
    const app = boot(flow, { timers: false });
    await (await app.runtime.start(flow, { n: 1 }, { executionId: "d3" })).waitForSuspend();

    expect(app.onWarn).not.toHaveBeenCalled();
  });

  it("warns once per gate, not once per execution", async () => {
    const flow = timedGate("repeat", 60_000);
    const app = boot(flow, { timers: false });
    for (const id of ["r1", "r2", "r3"]) {
      await (await app.runtime.start(flow, { n: 1 }, { executionId: id })).waitForSuspend();
    }
    expect(app.onWarn).toHaveBeenCalledTimes(1);
  });

  it("changes nothing in the log (G2) — it is a diagnostic, not a behaviour", async () => {
    const flow = timedGate("g2", 60_000);
    const loud = boot(flow, { timers: false });
    await (await loud.runtime.start(flow, { n: 1 }, { executionId: "g2a" })).waitForSuspend();
    const events = await loud.eventStore.read("g2a");
    const suspended = events.find((e: EventEnvelope) => e.eventType === "EXECUTION_SUSPENDED");
    const condition = (suspended?.payload as { condition?: Record<string, unknown> }).condition;

    // Exactly what an unwired runtime committed before this warning existed: the timeout
    // is preserved verbatim and no wakeAt was invented.
    expect(condition).toEqual({ on: "Approval", timeout: 60_000 });
  });
});
