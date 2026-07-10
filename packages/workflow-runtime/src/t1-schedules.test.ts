import { schedule$, step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TimerService } from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── T1.2 — schedule$: cron occurrences with deterministic, idempotent starts ──

const inputSchema = z.object({ label: z.string() });
const outputSchema = z.object({ done: z.boolean() });
type In = { label: string };
type Out = { done: boolean };

const auditStep = step$({
  id: "audit",
  name: "Audit",
  toolId: "audit-tool",
  inputSchema,
  outputSchema,
});

const FLOW = "nightly-audit";

function makeFlow(): RegisteredFlow<In, Out> {
  const runner: FlowRunner<In, Out> = async (ctx, input) => ctx.run(auditStep, input);
  const definition: FlowDefinition<In, Out> = {
    _tag: "FlowDefinition",
    id: FLOW,
    name: FLOW,
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: [auditStep],
  };
  return { definition, runner };
}

function boot(shared?: {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
  timerStore: InMemoryTimerStore;
}) {
  const auditFn = vi.fn(async () => ({ done: true }));
  const effects = new EffectRuntime();
  effects.register("audit-tool", new ToolEffect(auditFn));
  // Share ONLY the stores — each boot gets its own runtime/effects/spies.
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
    timerStore: stores.timerStore,
  });
  const flow = makeFlow();
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, auditFn, ...stores };
}

const everyMinute = schedule$<In>({
  id: "audit-schedule",
  cron: "* * * * *",
  flowId: FLOW,
  input: { label: "cron" },
});

const MINUTE = 60_000;
/** The next whole minute strictly after `t` — a cron occurrence boundary. */
const nextMinute = (t: number) => (Math.floor(t / MINUTE) + 1) * MINUTE;

describe("T1.2 — schedule$ firing", () => {
  it("fires a due occurrence with the deterministic scheduleId@occurrence executionId", async () => {
    const app = boot();
    const service = new TimerService(app.runtime, app.timerStore, { schedules: [everyMinute] });

    const occurrence = nextMinute(Date.now());
    await service.tick(occurrence); // poll lands exactly on the occurrence

    const executionId = `audit-schedule@${occurrence}`;
    const state = await app.runtime.loadState(executionId);
    expect(state?.status).toBe("completed");
    expect(state?.variables._input).toEqual({ label: "cron" });
    expect(app.auditFn).toHaveBeenCalledTimes(1);
  });

  it("never double-starts an occurrence: repeated polls are idempotent", async () => {
    const app = boot();
    const service = new TimerService(app.runtime, app.timerStore, { schedules: [everyMinute] });

    const occurrence = nextMinute(Date.now());
    await service.tick(occurrence);
    await service.tick(occurrence + 5_000);
    await service.tick(occurrence + 10_000);

    expect(app.auditFn).toHaveBeenCalledTimes(1);
    const events = await app.eventStore.read(`audit-schedule@${occurrence}`);
    expect(events.filter((e) => e.eventType === "EXECUTION_STARTED").length).toBe(1);
  });

  it("fires each occurrence once as time advances", async () => {
    const app = boot();
    const service = new TimerService(app.runtime, app.timerStore, { schedules: [everyMinute] });

    const first = nextMinute(Date.now());
    await service.tick(first);
    await service.tick(first + MINUTE);
    await service.tick(first + 2 * MINUTE);

    expect(app.auditFn).toHaveBeenCalledTimes(3);
    for (const occ of [first, first + MINUTE, first + 2 * MINUTE]) {
      expect((await app.runtime.loadState(`audit-schedule@${occ}`))?.status).toBe("completed");
    }
  });

  it("a node crash does not duplicate starts: a second service skips fired occurrences", async () => {
    const a = boot();
    const serviceA = new TimerService(a.runtime, a.timerStore, { schedules: [everyMinute] });
    const occurrence = nextMinute(Date.now());
    await serviceA.tick(occurrence);
    expect(a.auditFn).toHaveBeenCalledTimes(1);
    // Node A "dies"; node B (fresh runtime + service over the SAME stores)
    // computes the same deterministic occurrence id and finds it already started.
    const b = boot(a);
    const serviceB = new TimerService(b.runtime, b.timerStore, { schedules: [everyMinute] });
    await serviceB.tick(occurrence + 1_000);

    expect(b.auditFn).not.toHaveBeenCalled();
    const events = await b.eventStore.read(`audit-schedule@${occurrence}`);
    expect(events.filter((e) => e.eventType === "EXECUTION_STARTED").length).toBe(1);
  });

  it("no catch-up: occurrences before the service existed are skipped", async () => {
    const app = boot();
    const service = new TimerService(app.runtime, app.timerStore, { schedules: [everyMinute] });

    // Tick far in the future: only occurrences AFTER construction fire, and the
    // batch cap bounds the sweep — but none of the pre-construction minutes do.
    const constructionFloor = Date.now();
    const past = constructionFloor - 10 * MINUTE;
    await service.tick(constructionFloor - 1); // "now" before any new occurrence
    expect(app.auditFn).not.toHaveBeenCalled();
    expect(await app.runtime.loadState(`audit-schedule@${nextMinute(past)}`)).toBeNull();
  });

  it("fenced mode stamps schedule starts with a fencing token", async () => {
    const app = boot();
    const service = new TimerService(app.runtime, app.timerStore, {
      schedules: [everyMinute],
      fenced: true,
    });

    const occurrence = nextMinute(Date.now());
    await service.tick(occurrence);

    const events = await app.eventStore.read(`audit-schedule@${occurrence}`);
    const started = events.find((e) => e.eventType === "EXECUTION_STARTED");
    expect((started?.metadata as { fence?: number }).fence).toBe(1);
  });
});
