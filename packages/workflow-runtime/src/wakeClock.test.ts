import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TimerService } from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── L27 — a wake time and the clock that judges it are the SAME clock ────────
//
// `ctx.sleep` / `suspend({ timeout })` compute `wakeAt`; `TimerService` compares it. Before
// L27 the first read raw `Date.now()` and the second its own `now`, so one simulated clock
// handed to both never fired (clock behind the wall) or fired at once (clock ahead).

const io = z.object({});
const after = step$({ id: "after", name: "After", toolId: "t", inputSchema: io, outputSchema: io });

function flowOf(id: string, runner: FlowRunner<Record<string, never>, Record<string, never>>) {
  const definition: FlowDefinition<Record<string, never>, Record<string, never>> = {
    _tag: "FlowDefinition",
    id,
    name: id,
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [after],
  };
  return { definition, runner } as RegisteredFlow<Record<string, never>, Record<string, never>>;
}

function boot(flow: ReturnType<typeof flowOf>, clock: { t: number }) {
  const effects = new EffectRuntime();
  effects.register("t", new ToolEffect(async () => ({})));
  const timerStore = new InMemoryTimerStore();
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    timerStore,
    now: () => clock.t,
  });
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, timerStore };
}

const cases: Array<[string, (ctx: never) => Promise<unknown>]> = [
  ["ctx.sleep", (ctx) => (ctx as { sleep(ms: number): Promise<void> }).sleep(500)],
  [
    "suspend({ timeout })",
    (ctx) =>
      (ctx as { suspend(c: unknown): Promise<unknown> }).suspend({ on: "Gate", timeout: 500 }),
  ],
];

describe("L27 — shared simulated clock", () => {
  for (const [label, park] of cases) {
    for (const start of [1_000_000, 4_000_000_000_000_000]) {
      it(`${label} at clock=${start}: fires exactly when the clock passes wakeAt`, async () => {
        const clock = { t: start };
        const flow = flowOf(`f-${label}-${start}`, async (ctx) => {
          await park(ctx as never);
          return {};
        });
        const app = boot(flow, clock);
        // No `now` option: the service must inherit the runtime's clock.
        const service = new TimerService(app.runtime, app.timerStore);

        const handle = await app.runtime.start(flow, {}, { executionId: "x" });
        await handle.waitForSuspend();
        const wakeAt = (await app.runtime.loadState("x"))?.suspendedOn?.wakeAt;
        expect(wakeAt).toBe(start + 500);

        await service.tick(); // clock has not advanced: not due
        expect((await app.runtime.loadState("x"))?.status).toBe("suspended");

        clock.t = start + 499;
        await service.tick();
        expect((await app.runtime.loadState("x"))?.status).toBe("suspended");

        clock.t = start + 500;
        await service.tick();
        expect((await app.runtime.loadState("x"))?.status).toBe("completed");
      });
    }
  }

  it("an explicit TimerService `now` still overrides the runtime's clock", async () => {
    const clock = { t: 1_000_000 };
    const flow = flowOf("override", async (ctx) => {
      await ctx.sleep(500);
      return {};
    });
    const app = boot(flow, clock);
    const other = { t: 0 };
    const service = new TimerService(app.runtime, app.timerStore, { now: () => other.t });
    const handle = await app.runtime.start(flow, {}, { executionId: "y" });
    await handle.waitForSuspend();

    await service.tick(); // service clock (0) is behind wakeAt
    expect((await app.runtime.loadState("y"))?.status).toBe("suspended");
    other.t = 2_000_000; // disagreeing clock ahead: fires early relative to the runtime's
    await service.tick();
    expect((await app.runtime.loadState("y"))?.status).toBe("completed");
  });
});
