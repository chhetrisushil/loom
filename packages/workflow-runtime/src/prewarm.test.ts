import { schedule$, step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { Effect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner } from "./types";

const io = { inputSchema: z(), outputSchema: z() };
function z() {
  const { z } = require("zod");
  return z.object({});
}

const FLOW = "warm-flow";
const firstStep = step$({ id: "first", name: "first", toolId: "first-tool", ...io });
const secondStep = step$({ id: "second", name: "second", toolId: "second-tool", ...io });

// A warm-capable effect (like IsolatedToolEffect / a wired LLM effect).
function warmable(): Effect & { warmCalls: number } {
  const e = {
    kind: "tool" as const,
    warmCalls: 0,
    warm() {
      e.warmCalls++;
    },
    execute: async () => ({}),
  };
  return e;
}

function boot() {
  const effects = new EffectRuntime();
  const first = warmable();
  effects.register("first-tool", first as Effect);
  effects.register("second-tool", new ToolEffect(async () => ({})));
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const runner: FlowRunner<unknown, unknown> = async (ctx, input) => {
    await ctx.run(firstStep, input);
    await ctx.run(secondStep, input);
    return {};
  };
  const definition: FlowDefinition = {
    _tag: "FlowDefinition",
    id: FLOW,
    name: FLOW,
    version: "1.0.0",
    ...io,
    steps: [firstStep, secondStep],
  };
  runtime.registerFlow(definition, runner);
  return { runtime, first };
}

describe("WorkflowRuntime.warmFlow — advisory pre-warm of a flow's first step", () => {
  it("warms the FIRST step's effect (the initial-latency one), not the rest", () => {
    const app = boot();
    app.runtime.warmFlow(FLOW);
    expect(app.first.warmCalls).toBe(1);
  });

  it("is a no-op for an unknown flow", () => {
    const app = boot();
    expect(() => app.runtime.warmFlow("nope")).not.toThrow();
  });
});

describe("TimerService warmLeadMs — pre-warm a scheduled flow before it fires", () => {
  const MINUTE = 60_000;
  const nextMinute = (t: number) => (Math.floor(t / MINUTE) + 1) * MINUTE;

  function svc(warmLeadMs: number) {
    const app = boot();
    const timerStore = new InMemoryTimerStore();
    const sched = schedule$({ id: "audit-schedule", cron: "* * * * *", flowId: FLOW });
    const service = new TimerService(app.runtime, timerStore, { schedules: [sched], warmLeadMs });
    return { ...app, service };
  }

  it("warms the flow when the next occurrence is within the lead window — once per occurrence", async () => {
    const s = svc(10_000); // 10s lead
    const occurrence = nextMinute(Date.now());
    // Poll 5s before the occurrence → within the 10s window → warm once.
    await s.service.tick(occurrence - 5_000);
    expect(s.first.warmCalls).toBe(1);
    // A second poll still before the same occurrence → NOT warmed again (deduped).
    await s.service.tick(occurrence - 4_000);
    expect(s.first.warmCalls).toBe(1);
  });

  it("does not warm when the occurrence is beyond the lead window", async () => {
    const s = svc(1_000); // 1s lead
    const occurrence = nextMinute(Date.now());
    await s.service.tick(occurrence - 30_000); // 30s out, lead is 1s
    expect(s.first.warmCalls).toBe(0);
  });

  it("is off by default (warmLeadMs unset ⇒ no warming)", async () => {
    const app = boot();
    const service = new TimerService(app.runtime, new InMemoryTimerStore(), {
      schedules: [schedule$({ id: "s", cron: "* * * * *", flowId: FLOW })],
    });
    await service.tick(nextMinute(Date.now()) - 1_000);
    expect(app.first.warmCalls).toBe(0);
  });
});
