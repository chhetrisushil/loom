import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TimerService } from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { reconcileTimers } from "./reconcileTimers";
import type { FlowRunner } from "./types";

// ── ADR 0105 — a timed park whose timer row was retired ───────────────────────
//
// Before EVENT_SCHEMA 1.21.0, a parallel sibling failing after a timed park folded the
// execution to "failed", so `TimerService` retired its row as obsolete. After the fix the
// execution reads `suspended` again with a past `wakeAt` and no row: nothing wakes it until
// `reconcileTimers` re-asserts the row.

const io = { inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) };
const slow = step$({ id: "slow", name: "slow", toolId: "tool-slow", ...io });

function boot() {
  const effects = new EffectRuntime();
  effects.register(
    "tool-slow",
    new ToolEffect(async () => {
      await new Promise((r) => setTimeout(r, 20));
      throw new Error("late boom");
    })
  );
  const eventStore = new InMemoryAsyncEventStore();
  const timerStore = new InMemoryTimerStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    timerStore,
  });
  const definition: FlowDefinition<Record<string, never>, { ok: boolean }> = {
    _tag: "FlowDefinition",
    id: "timed",
    name: "timed",
    version: "1.0.0",
    inputSchema: io.inputSchema,
    outputSchema: io.outputSchema,
    steps: [slow],
  };
  const runner: FlowRunner<Record<string, never>, { ok: boolean }> = async (ctx) => {
    await Promise.all([ctx.run(slow, {}).catch(() => "caught"), ctx.sleep(30)]);
    return { ok: true };
  };
  runtime.registerFlow(definition, runner);
  return { runtime, eventStore, timerStore, flow: { definition, runner } };
}

describe("reconcileTimers (ADR 0105)", () => {
  it("re-arms a timed park whose row the pre-1.21.0 service retired, and the service then wakes it", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, {}, { executionId: "t1" });
    const parked = await handle.waitForSuspend();
    await new Promise((r) => setTimeout(r, 60)); // the sibling fails after the park
    const wakeAt = parked.suspendedOn?.wakeAt as number;
    expect((await app.runtime.loadState("t1"))?.status).toBe("suspended");

    // What the old service did when the old fold read "failed": retire the row as obsolete.
    await app.timerStore.complete("t1", wakeAt);
    const service = new TimerService(app.runtime, app.timerStore);
    await service.tick(wakeAt + 1_000);
    expect((await app.runtime.loadState("t1"))?.status).toBe("suspended"); // stranded

    const dry = await reconcileTimers(app.runtime, {
      source: app.eventStore,
      timers: app.timerStore,
      dryRun: true,
    });
    expect(dry).toMatchObject({ timedParks: 1, scheduled: 0 });
    expect(await app.timerStore.due(wakeAt + 1_000)).toEqual([]);

    const seen: Array<[string, number]> = [];
    const summary = await reconcileTimers(app.runtime, {
      source: app.eventStore,
      timers: app.timerStore,
      onTimedPark: (id, at) => seen.push([id, at]),
    });
    expect(summary).toMatchObject({ scanned: 1, timedParks: 1, scheduled: 1 });
    expect(seen).toEqual([["t1", wakeAt]]);

    await service.tick(wakeAt + 1_000);
    expect((await app.runtime.loadState("t1"))?.status).toBe("completed");
  });

  it("is idempotent, and ignores executions not parked on a wake time", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, {}, { executionId: "t2" });
    await handle.waitForSuspend();
    await reconcileTimers(app.runtime, { source: app.eventStore, timers: app.timerStore });
    await reconcileTimers(app.runtime, { source: app.eventStore, timers: app.timerStore });
    expect(await app.timerStore.due(Number.MAX_SAFE_INTEGER)).toHaveLength(1);

    await new TimerService(app.runtime, app.timerStore).tick(Number.MAX_SAFE_INTEGER);
    expect((await app.runtime.loadState("t2"))?.status).toBe("completed");
    const after = await reconcileTimers(app.runtime, {
      source: app.eventStore,
      timers: app.timerStore,
    });
    expect(after).toMatchObject({ scanned: 1, timedParks: 0, scheduled: 0 });
  });
});
