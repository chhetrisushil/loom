import { schedule$, step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TimerService } from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { recoverAbandoned } from "./recoverAbandoned";
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

function boot(
  shared?: {
    eventStore: InMemoryAsyncEventStore;
    snapshotStore: InMemoryAsyncSnapshotStore;
    timerStore: InMemoryTimerStore;
  },
  audit: () => Promise<Out> = async () => ({ done: true })
) {
  const auditFn = vi.fn(audit);
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
/**
 * One pinned instant, half-way through a minute, for every service's construction floor
 * and every occurrence the tests compute (L25a). A service's cron cursor starts at its
 * construction time, and a tick fires EVERY occurrence in (cursor, now]. Read from the wall
 * clock, a minute boundary falling between the constructor and `nextMinute(Date.now())`
 * made that window hold two occurrences — two executions, two effects — which only a
 * slow (loaded) run is likely to hit. The service's behaviour is right; the test's
 * assumption of one occurrence per window was the race.
 */
const NOW = 28_333_334 * MINUTE + MINUTE / 2;
const clock = () => NOW;

describe("T1.2 — schedule$ firing", () => {
  it("fires a due occurrence with the deterministic scheduleId@occurrence executionId", async () => {
    const app = boot();
    const service = new TimerService(app.runtime, app.timerStore, {
      schedules: [everyMinute],
      now: clock,
    });

    const occurrence = nextMinute(NOW);
    await service.tick(occurrence); // poll lands exactly on the occurrence

    const executionId = `audit-schedule@${occurrence}`;
    const state = await app.runtime.loadState(executionId);
    expect(state?.status).toBe("completed");
    expect(state?.variables._input).toEqual({ label: "cron" });
    expect(app.auditFn).toHaveBeenCalledTimes(1);
  });

  it("never double-starts an occurrence: repeated polls are idempotent", async () => {
    const app = boot();
    const service = new TimerService(app.runtime, app.timerStore, {
      schedules: [everyMinute],
      now: clock,
    });

    const occurrence = nextMinute(NOW);
    await service.tick(occurrence);
    await service.tick(occurrence + 5_000);
    await service.tick(occurrence + 10_000);

    expect(app.auditFn).toHaveBeenCalledTimes(1);
    const events = await app.eventStore.read(`audit-schedule@${occurrence}`);
    expect(events.filter((e) => e.eventType === "EXECUTION_STARTED").length).toBe(1);
  });

  it("fires each occurrence once as time advances", async () => {
    const app = boot();
    const service = new TimerService(app.runtime, app.timerStore, {
      schedules: [everyMinute],
      now: clock,
    });

    const first = nextMinute(NOW);
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
    const serviceA = new TimerService(a.runtime, a.timerStore, {
      schedules: [everyMinute],
      now: clock,
    });
    const occurrence = nextMinute(NOW);
    await serviceA.tick(occurrence);
    expect(a.auditFn).toHaveBeenCalledTimes(1);
    // Node A "dies"; node B (fresh runtime + service over the SAME stores)
    // computes the same deterministic occurrence id and finds it already started.
    const b = boot(a);
    const serviceB = new TimerService(b.runtime, b.timerStore, {
      schedules: [everyMinute],
      now: clock,
    });
    await serviceB.tick(occurrence + 1_000);

    expect(b.auditFn).not.toHaveBeenCalled();
    const events = await b.eventStore.read(`audit-schedule@${occurrence}`);
    expect(events.filter((e) => e.eventType === "EXECUTION_STARTED").length).toBe(1);
  });

  it("ADR 0103 — two nodes firing the same occurrence at once: one execution, one effect, no onError", async () => {
    // The raced remainder the `loadState` fast path cannot see: both nodes check before
    // either has written. The durable bootstrap refuses the loser's start with
    // ExecutionAlreadyExistsError before its body runs, and the service reads that as
    // "already started" rather than an error.
    const a = boot();
    const b = boot(a);
    const onErrorA = vi.fn();
    const onErrorB = vi.fn();
    const serviceA = new TimerService(a.runtime, a.timerStore, {
      schedules: [everyMinute],
      now: clock,
      onError: onErrorA,
    });
    const serviceB = new TimerService(b.runtime, b.timerStore, {
      schedules: [everyMinute],
      now: clock,
      onError: onErrorB,
    });
    const occurrence = nextMinute(NOW);
    await Promise.all([serviceA.tick(occurrence), serviceB.tick(occurrence)]);

    expect(a.auditFn.mock.calls.length + b.auditFn.mock.calls.length).toBe(1);
    expect(onErrorA).not.toHaveBeenCalled();
    expect(onErrorB).not.toHaveBeenCalled();
    const events = await a.eventStore.read(`audit-schedule@${occurrence}`);
    expect(events.filter((e) => e.eventType === "EXECUTION_STARTED")).toHaveLength(1);
    expect(events.at(-1)?.eventType).toBe("EXECUTION_COMPLETED");
  });

  it("ADR 0103 — fenced mode, the loser's start is overtaken before its bootstrap: 'already started', no onError", async () => {
    // The ordering that used to be refused as STALE: A passes the fast path and heads into
    // start(); B then runs its whole attempt first and completes the occurrence. Before L12, A
    // held fence 1 while B's start had taken fence 2, so A's sequence 0 was refused on the
    // fence and reported to onError as a StorageWriteError. Now neither start fences: A is
    // refused at sequence 0 as a duplicate, which the service treats as "already started".
    const a = boot();
    const b = boot(a);
    const onErrorA = vi.fn();
    const onErrorB = vi.fn();
    let bSettled!: () => void;
    const bDone = new Promise<void>((r) => {
      bSettled = r;
    });
    let aReachedStart!: () => void;
    const aAtStart = new Promise<void>((r) => {
      aReachedStart = r;
    });
    const realStart = a.runtime.start.bind(a.runtime);
    vi.spyOn(a.runtime, "start").mockImplementation(async (...args) => {
      aReachedStart();
      await bDone;
      return realStart(...(args as Parameters<typeof realStart>));
    });
    const serviceA = new TimerService(a.runtime, a.timerStore, {
      schedules: [everyMinute],
      now: clock,
      fenced: true,
      onError: onErrorA,
    });
    const serviceB = new TimerService(b.runtime, b.timerStore, {
      schedules: [everyMinute],
      now: clock,
      fenced: true,
      onError: onErrorB,
    });
    const occurrence = nextMinute(NOW);
    const tickA = serviceA.tick(occurrence);
    await aAtStart;
    await serviceB.tick(occurrence).finally(() => bSettled());
    await tickA;

    expect(a.auditFn).not.toHaveBeenCalled();
    expect(b.auditFn).toHaveBeenCalledTimes(1);
    expect(onErrorA).not.toHaveBeenCalled();
    expect(onErrorB).not.toHaveBeenCalled();
    const events = await a.eventStore.read(`audit-schedule@${occurrence}`);
    expect(events.filter((e) => e.eventType === "EXECUTION_STARTED")).toHaveLength(1);
    expect(events.every((e) => e.metadata?.fence === undefined)).toBe(true);
    expect(events.at(-1)?.eventType).toBe("EXECUTION_COMPLETED");
  });

  it("ADR 0103 L12 — fenced mode, the loser arrives AFTER the winner's bootstrap: exactly one effect, even after recovery", async () => {
    // The ordering the stale-at-bootstrap test above cannot reach. B passes the `loadState`
    // fast path before A has written anything, then stalls; A bootstraps and enters its first
    // effect; only then does B carry on. Before L12, B's `acquireFence` superseded A's token
    // at this point: B was refused as a duplicate, but A's next write was refused as STALE, so
    // A's run died `running` with its effect already paid, and a recovery pass re-drove the
    // step — a second effect. The start must not touch the fence of an execution it does not
    // own.
    let releaseB!: () => void;
    const bMayProceed = new Promise<void>((r) => {
      releaseB = r;
    });
    let bSettled!: () => void;
    const bDone = new Promise<void>((r) => {
      bSettled = r;
    });
    const a = boot(undefined, async () => {
      releaseB(); // A's bootstrap is durable and its body is inside the effect
      await bDone; // hold the effect open until B has finished its whole attempt
      return { done: true };
    });
    const b = boot(a);
    const realLoadState = b.runtime.loadState.bind(b.runtime);
    vi.spyOn(b.runtime, "loadState").mockImplementation(async (id: string) => {
      const state = await realLoadState(id); // read BEFORE A writes: B sees nothing
      await bMayProceed;
      return state;
    });
    const onErrorA = vi.fn();
    const onErrorB = vi.fn();
    const serviceA = new TimerService(a.runtime, a.timerStore, {
      schedules: [everyMinute],
      now: clock,
      fenced: true,
      onError: onErrorA,
    });
    const serviceB = new TimerService(b.runtime, b.timerStore, {
      schedules: [everyMinute],
      now: clock,
      fenced: true,
      onError: onErrorB,
    });
    const occurrence = nextMinute(NOW);
    const executionId = `audit-schedule@${occurrence}`;

    const tickB = serviceB.tick(occurrence).finally(() => bSettled());
    await Promise.all([serviceA.tick(occurrence), tickB]);

    // Whatever the race left behind, a recovery pass must not pay for the step again.
    const recovery = boot(a);
    await recoverAbandoned(recovery.runtime, {
      source: recovery.eventStore,
      isAbandoned: () => true,
      fenced: true,
    });

    const effects =
      a.auditFn.mock.calls.length +
      b.auditFn.mock.calls.length +
      recovery.auditFn.mock.calls.length;
    expect(effects).toBe(1);
    expect(b.auditFn).not.toHaveBeenCalled();
    expect(onErrorA).not.toHaveBeenCalled();
    expect(onErrorB).not.toHaveBeenCalled(); // B lost as a duplicate: "already started"
    const events = await a.eventStore.read(executionId);
    expect(events.filter((e) => e.eventType === "EXECUTION_STARTED")).toHaveLength(1);
    expect(events.filter((e) => e.eventType === "EXECUTION_RECOVERED")).toHaveLength(0);
    expect(events.at(-1)?.eventType).toBe("EXECUTION_COMPLETED");
  });

  it("no catch-up: occurrences before the service existed are skipped", async () => {
    const app = boot();
    const service = new TimerService(app.runtime, app.timerStore, {
      schedules: [everyMinute],
      now: clock,
    });

    // Tick far in the future: only occurrences AFTER construction fire, and the
    // batch cap bounds the sweep — but none of the pre-construction minutes do.
    const constructionFloor = NOW;
    const past = constructionFloor - 10 * MINUTE;
    await service.tick(constructionFloor - 1); // "now" before any new occurrence
    expect(app.auditFn).not.toHaveBeenCalled();
    expect(await app.runtime.loadState(`audit-schedule@${nextMinute(past)}`)).toBeNull();
  });

  it("L12 — fenced mode does not fence a schedule START; the first later fence still fences its starter out", async () => {
    const app = boot();
    const service = new TimerService(app.runtime, app.timerStore, {
      schedules: [everyMinute],
      now: clock,
      fenced: true,
    });

    const occurrence = nextMinute(NOW);
    const executionId = `audit-schedule@${occurrence}`;
    await service.tick(occurrence);

    const events = await app.eventStore.read(executionId);
    const started = events.find((e) => e.eventType === "EXECUTION_STARTED");
    expect(started?.metadata?.fence).toBeUndefined();
    // The zombie guarantee does not need a start token: once anyone acquires a fence, the
    // unfenced starter's writes are refused (a fencing store refuses a MISSING token).
    await app.eventStore.acquireFence(executionId);
    const last = events.at(-1)!;
    await expect(
      app.eventStore.append({
        ...last,
        id: `${executionId}-${last.sequence + 1}`,
        sequence: last.sequence + 1,
      })
    ).rejects.toMatchObject({ name: "StaleFenceError" });
  });
});

describe("R19 - schedule$ timeZone", () => {
  it("rejects an unknown zone when the schedule is DEFINED", () => {
    expect(() =>
      schedule$<In>({ id: "x", cron: "0 9 * * *", flowId: FLOW, timeZone: "Nope/Zone" })
    ).toThrow(/unknown time zone/);
  });

  it("fires at the zone's wall time (injected clock), and not at the UTC time", async () => {
    const app = boot();
    const ny = schedule$<In>({
      id: "ny-nine",
      cron: "0 9 * * *",
      flowId: FLOW,
      input: { label: "ny" },
      timeZone: "America/New_York",
    });
    const start = Date.parse("2026-07-10T00:00:00Z");
    const service = new TimerService(app.runtime, app.timerStore, {
      schedules: [ny],
      now: () => start,
    });
    await service.tick(Date.parse("2026-07-10T09:00:00Z")); // 09:00 UTC is 05:00 in New York: nothing
    expect(app.auditFn).toHaveBeenCalledTimes(0);
    const occurrence = Date.parse("2026-07-10T13:00:00Z"); // 09:00 EDT
    await service.tick(occurrence);
    expect(app.auditFn).toHaveBeenCalledTimes(1);
    expect((await app.runtime.loadState(`ny-nine@${occurrence}`))?.status).toBe("completed");
  });
});
