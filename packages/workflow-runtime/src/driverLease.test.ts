import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import {
  InMemoryAsyncEventStore,
  InMemoryLeaseStore,
  InMemoryTimerStore,
} from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TimerService } from "./TimerService";
import { WorkflowRuntime, type WorkflowRuntimeDeps } from "./WorkflowRuntime";
import { Latch, until as untilAsync } from "./__tests__/r2Harness";
import { LeaseHeldError, LeaseLostError } from "./leaseKeeper";
import { recoverAbandoned } from "./recoverAbandoned";
import type { FlowRunner, RegisteredFlow } from "./types";
import { ExecutionAlreadyExistsError } from "./types";

// ADR 0130 D11 (S7c): every driver holds a heartbeat lease through ONE per-runtime LeaseKeeper.
// Deterministic: fake clocks, hand-driven timers, a call log shared by the lease store and the event
// store so ORDER is asserted directly (lease THEN fence THEN append).

const io = { inputSchema: z.any(), outputSchema: z.any() };
const echo = step$({ id: "echo", name: "Echo", toolId: "echo", ...io });
const slow = step$({ id: "slow", name: "Slow", toolId: "slow", ...io });

function flow<I = unknown, O = unknown>(
  id: string,
  runner: FlowRunner<I, O>
): RegisteredFlow<I, O> {
  const definition = {
    _tag: "FlowDefinition",
    id,
    name: id,
    version: "1.0.0",
    ...io,
    steps: [echo, slow],
  } as unknown as FlowDefinition<I, O>;
  return { definition, runner };
}

let seq = 0;
const newId = (): string => `dl-${++seq}-${Math.random().toString(36).slice(2, 6)}`;

class SpyLeases extends InMemoryLeaseStore {
  releaseGate: Promise<void> | undefined;
  constructor(
    private readonly calls: string[],
    now: () => number
  ) {
    super({ now });
  }
  override async acquire(...a: Parameters<InMemoryLeaseStore["acquire"]>) {
    this.calls.push(`lease.acquire:${a[0]}`);
    return super.acquire(...a);
  }
  override async acquireMany(...a: Parameters<NonNullable<InMemoryLeaseStore["acquireMany"]>>) {
    this.calls.push(`lease.acquire:${[...a[0]].join(",")}`);
    return super.acquireMany(...a);
  }
  override async release(...a: Parameters<InMemoryLeaseStore["release"]>) {
    this.calls.push(`lease.release:${a[0]}`);
    return super.release(...a);
  }
  override async releaseMany(...a: Parameters<NonNullable<InMemoryLeaseStore["releaseMany"]>>) {
    this.calls.push(`lease.release:${[...a[0]].join(",")}`);
    if (this.releaseGate) await this.releaseGate;
    return super.releaseMany(...a);
  }
}

class SpyEvents extends InMemoryAsyncEventStore {
  constructor(private readonly calls: string[]) {
    super();
  }
  override async append(e: EventEnvelope) {
    this.calls.push(`append:${e.executionId}:${e.eventType}`);
    return super.append(e);
  }
  override async appendBatch(es: EventEnvelope[]) {
    for (const e of es) this.calls.push(`append:${e.executionId}:${e.eventType}`);
    return super.appendBatch(es);
  }
  override async acquireFence(id: string) {
    this.calls.push(`fence:${id}`);
    return super.acquireFence(id);
  }
  override async acquireFenceIf(id: string, x: { fence: number; parkSeq: number }) {
    this.calls.push(`fence:${id}`);
    return super.acquireFenceIf(id, x);
  }
}

function rig(
  opts: {
    heartbeat?: boolean | "disabled";
    latch?: Latch;
    deps?: Partial<WorkflowRuntimeDeps>;
    leases?: SpyLeases;
    events?: SpyEvents;
    nodeId?: string;
  } = {}
) {
  const calls: string[] = [];
  const clock = { mono: 1_000, wall: 1_700_000_000_000 };
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const leases = opts.leases ?? new SpyLeases(calls, () => clock.wall);
  const events = opts.events ?? new SpyEvents(calls);
  const effects = new EffectRuntime();
  const seen = { sawAbort: undefined as unknown, slowCalls: 0, echoCalls: 0 };
  effects.register(
    "echo",
    new ToolEffect(async (i: unknown) => {
      seen.echoCalls++;
      return i;
    })
  );
  effects.register(
    "slow",
    new ToolEffect(async (i: unknown, ctx) => {
      seen.slowCalls++;
      opts.latch?.enter();
      ctx.signal?.addEventListener("abort", () => {
        seen.sawAbort = ctx.signal?.reason;
      });
      await opts.latch?.promise;
      return i;
    })
  );
  const hb =
    opts.heartbeat === false || opts.heartbeat === "disabled"
      ? undefined
      : {
          leaseStore: leases,
          nodeId: opts.nodeId ?? "n1",
          incarnation: "i1",
          ttlMs: 30_000,
          monotonicNow: () => clock.mono,
          wallNow: () => clock.wall,
          every: (fn: () => void, ms: number) => {
            timers.push({ fn, ms });
            return () => {};
          },
        };
  const rt = new WorkflowRuntime({
    eventStore: events,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    inboxEnabled: true,
    continueAsNewEnabled: true,
    now: () => clock.wall,
    ...(hb !== undefined && { heartbeat: hb }),
    ...opts.deps,
  } as WorkflowRuntimeDeps);
  return { rt, calls, clock, timers, leases, events, effects, seen };
}

const idx = (calls: string[], needle: string): number => calls.findIndex((c) => c === needle);
const firstWith = (calls: string[], prefix: string): number =>
  calls.findIndex((c) => c.startsWith(prefix));
const held = async (leases: InMemoryLeaseStore, id: string): Promise<boolean> =>
  (await leases.get?.(id)) != null;

const parks = flow("parks", async (ctx) => {
  await ctx.suspend({ on: "Go" });
  return { done: true };
});
const finishes = flow("finishes", async (ctx) => {
  await ctx.run(echo, { a: 1 });
  return { done: true };
});
const waiter = flow("waiter", async (ctx) => {
  await ctx.receive<unknown>("q");
  await ctx.suspend({ on: "Go" });
  return { ok: true };
});
const slowFlow = flow("slowFlow", async (ctx) => {
  await ctx.run(slow, {});
  await ctx.run(echo, { after: true });
  return { done: true };
});

describe("S7c - drivers hold a heartbeat lease", () => {
  it("start (minted id): leases BEFORE the first append, releases AWAITED before the suspend handle resolves", async () => {
    const r = rig();
    r.rt.registerFlow(parks.definition, parks.runner);
    let openGate!: () => void;
    const gate = {
      promise: new Promise<void>((r) => {
        openGate = r;
      }),
      resolve: () => openGate(),
    };
    r.leases.releaseGate = gate.promise;
    const h = await r.rt.start(parks, {});
    let resolved = false;
    const suspended = h.waitForSuspend().then(() => {
      resolved = true;
    });
    const id = h.executionId;
    await untilAsync(() => r.calls.some((c) => c === `lease.release:${id}`));
    // the release is on the wire (gated) and the handle must NOT have resolved
    for (let i = 0; i < 50; i++) await new Promise((x) => setImmediate(x));
    expect(resolved).toBe(false);
    gate.resolve();
    await suspended;
    expect(idx(r.calls, `lease.acquire:${id}`)).toBeGreaterThanOrEqual(0);
    expect(idx(r.calls, `lease.acquire:${id}`)).toBeLessThan(
      idx(r.calls, `append:${id}:EXECUTION_STARTED`)
    );
    expect(await held(r.leases, id)).toBe(false);
  });

  it("start (terminal): releases before the completion handle resolves", async () => {
    const r = rig();
    const h = await r.rt.start(finishes, {});
    await h.waitForCompletion();
    expect(await held(r.leases, h.executionId)).toBe(false);
    expect(firstWith(r.calls, `lease.release:${h.executionId}`)).toBeGreaterThan(
      idx(r.calls, `append:${h.executionId}:EXECUTION_COMPLETED`)
    );
  });

  it("start (caller-chosen id): leases before the durable bootstrap", async () => {
    const r = rig();
    const id = newId();
    const h = await r.rt.start(finishes, {}, { executionId: id });
    await h.waitForCompletion();
    expect(idx(r.calls, `lease.acquire:${id}`)).toBeLessThan(
      idx(r.calls, `append:${id}:EXECUTION_STARTED`)
    );
  });

  it("resume: lease THEN fence THEN append, and released at the next park", async () => {
    const r = rig();
    r.rt.registerFlow(waiter.definition, waiter.runner);
    const id = newId();
    await (await r.rt.start(waiter, {}, { executionId: id })).waitForSuspend();
    await r.rt.send(id, { topic: "q", payload: 1, messageId: "m1" });
    await untilAsync(async () => (await r.rt.loadState(id))?.suspendedOn?.on === "Go");
    r.calls.length = 0;
    const park = await r.rt.parkedAtSequence(id);
    const h = await r.rt.resume(
      id,
      { eventType: "Go", payload: null },
      { ...(park !== undefined && { fenceIfParkedAt: park }) }
    );
    await h.waitForCompletion();
    const a = idx(r.calls, `lease.acquire:${id}`);
    const f = idx(r.calls, `fence:${id}`);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(f).toBeGreaterThan(a);
    expect(idx(r.calls, `append:${id}:EXECUTION_RESUMED`)).toBeGreaterThan(f);
    expect(await held(r.leases, id)).toBe(false);
  });

  it("send/notify winner: leases before taking the fence and appending the delivery, releases after", async () => {
    const r = rig();
    r.rt.registerFlow(waiter.definition, waiter.runner);
    const id = newId();
    await (await r.rt.start(waiter, {}, { executionId: id })).waitForSuspend();
    r.calls.length = 0;
    await r.rt.send(id, { topic: "q", payload: 1, messageId: "m1" });
    await untilAsync(async () => (await r.rt.loadState(id))?.suspendedOn?.on === "Go");
    const a = idx(r.calls, `lease.acquire:${id}`);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(firstWith(r.calls, `append:${id}:MESSAGE_CONSUMED`));
    await untilAsync(async () => !(await held(r.leases, id)));
  });

  it("stands down WITHOUT taking the fence when another live owner holds the lease", async () => {
    const r = rig();
    r.rt.registerFlow(waiter.definition, waiter.runner);
    const id = newId();
    await (await r.rt.start(waiter, {}, { executionId: id })).waitForSuspend();
    await r.rt.send(id, { topic: "q", payload: 1, messageId: "m1" });
    await untilAsync(async () => (await r.rt.loadState(id))?.suspendedOn?.on === "Go");
    await r.leases.acquire(id, "other:node", 30_000, r.clock.wall);
    r.calls.length = 0;
    const before = (await r.events.read(id)).length;
    await expect(r.rt.resume(id, { eventType: "Go", payload: null })).rejects.toBeInstanceOf(
      LeaseHeldError
    );
    expect(r.calls.filter((c) => c.startsWith("fence:"))).toEqual([]);
    expect(r.calls.filter((c) => c.startsWith("append:"))).toEqual([]);
    expect((await r.events.read(id)).length).toBe(before);
  });

  it("start with a caller-chosen id held by another owner stands down as already-exists, appending nothing", async () => {
    const r = rig();
    const id = newId();
    await r.leases.acquire(id, "other:node", 30_000, r.clock.wall);
    await expect(r.rt.start(finishes, {}, { executionId: id })).rejects.toBeInstanceOf(
      ExecutionAlreadyExistsError
    );
    expect(r.calls.filter((c) => c.startsWith("append:"))).toEqual([]);
    expect(r.calls.filter((c) => c.startsWith("fence:"))).toEqual([]);
  });

  it("a lost lease mid-step aborts the in-flight effect, rejects the handle as LeaseLostError and appends NOTHING", async () => {
    const latch = new Latch();
    const r = rig({ latch });
    const h = await r.rt.start(slowFlow, {});
    const id = h.executionId;
    await latch.entered;
    await untilAsync(async () =>
      (await r.events.read(id)).some((e: EventEnvelope) => e.eventType === "STEP_STARTED")
    );
    const logged = (await r.events.read(id)).length;
    // the node stalls past the TTL: the watchdog (timers[1]) fires and the deadline has passed
    r.clock.mono += 30_000;
    r.clock.wall += 30_000;
    r.timers[1]?.fn();
    const err = await h.waitForCompletion().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(LeaseLostError);
    expect(r.seen.sawAbort).toBeInstanceOf(LeaseLostError);
    latch.release();
    for (let i = 0; i < 100; i++) await new Promise((x) => setImmediate(x));
    const after = await r.events.read(id);
    expect(after.length).toBe(logged);
    expect(after.some((e: EventEnvelope) => /FAILED|CANCELLED|COMPLETED/.test(e.eventType))).toBe(
      false
    );
  });

  it("the validity gate refuses an append after a stall even before the watchdog ran", async () => {
    const latch = new Latch();
    const r = rig({ latch });
    const h = await r.rt.start(slowFlow, {});
    const id = h.executionId;
    await latch.entered;
    await untilAsync(async () =>
      (await r.events.read(id)).some((e: EventEnvelope) => e.eventType === "STEP_STARTED")
    );
    const logged = (await r.events.read(id)).length;
    r.clock.mono += 30_000; // stalled past the deadline; NO watchdog tick
    r.clock.wall += 30_000;
    latch.release();
    const err = await h.waitForCompletion().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(LeaseLostError);
    expect((await r.events.read(id)).length).toBe(logged);
  });

  it("the dispatch gate refuses the NEXT effect once the lease is invalid", async () => {
    const latch = new Latch();
    const r = rig({ latch });
    const h = await r.rt.start(slowFlow, {});
    await latch.entered;
    r.clock.mono += 30_000;
    r.clock.wall += 30_000;
    latch.release();
    await h.waitForCompletion().catch(() => undefined);
    expect(r.seen.echoCalls).toBe(0); // the second step never dispatched
  });

  it("continue-as-new: the successor is leased BEFORE its EXECUTION_STARTED while the predecessor still holds its own", async () => {
    const r = rig();
    const rot = flow("rot", async (ctx, input) => {
      if ((input as { n?: number } | undefined)?.n === undefined)
        return ctx.continueAsNew({ n: 1 });
      return { done: true };
    });
    r.rt.registerFlow(rot.definition, rot.runner);
    const id = newId();
    const h = await r.rt.start(rot, {}, { executionId: id });
    await h.waitForCompletion().catch(() => undefined);
    const starts = r.calls
      .map((c, i) => [c, i] as const)
      .filter(([c]) => /^append:.*~?.*:EXECUTION_STARTED$/.test(c) && !c.includes(`append:${id}:`));
    expect(starts.length).toBeGreaterThan(0);
    const [startCall, startAt] = starts[0] as readonly [string, number];
    const succId = startCall.split(":")[1] as string;
    const acq = idx(r.calls, `lease.acquire:${succId}`);
    expect(acq).toBeGreaterThanOrEqual(0);
    expect(acq).toBeLessThan(startAt);
    const predRelease = firstWith(r.calls, `lease.release:${id}`);
    expect(predRelease === -1 || predRelease > startAt).toBe(true);
  });

  it("disabled heartbeat reproduces today byte-for-byte: no keeper, no lease call, identical log", async () => {
    const a = rig({ heartbeat: "disabled" });
    const b = rig({ heartbeat: false });
    expect(a.rt.leaseKeeper).toBeUndefined();
    const run = async (r: ReturnType<typeof rig>) => {
      const h = await r.rt.start(finishes, {}, { executionId: "golden-1" });
      await h.waitForCompletion();
      return (await r.events.read("golden-1")).map((e: EventEnvelope) => JSON.stringify(e));
    };
    expect(await run(a)).toEqual(await run(b));
    expect(a.calls.filter((c) => c.startsWith("lease."))).toEqual([]);
  });

  it("S6 split-brain: a live silent driver holds an unexpired lease, so another node's heuristic poll cannot double-enter", async () => {
    const latch = new Latch();
    const calls: string[] = [];
    const clock = { mono: 1_000, wall: 1_700_000_000_000 };
    const leases = new SpyLeases(calls, () => clock.wall);
    const events = new SpyEvents(calls);
    const live = rig({ latch, leases, events, nodeId: "live" });
    const other = rig({ leases, events, nodeId: "poller" });
    live.rt.registerFlow(slowFlow.definition, slowFlow.runner);
    other.rt.registerFlow(slowFlow.definition, slowFlow.runner);
    const h = await live.rt.start(slowFlow, {});
    const id = h.executionId;
    await latch.entered;
    await untilAsync(async () =>
      (await events.read(id)).some((e: EventEnvelope) => e.eventType === "STEP_STARTED")
    );
    const logged = (await events.read(id)).length;
    // the poller's re-drive path (what redriveAbandoned does): resume the running execution
    await expect(
      other.rt.resume(id, { eventType: "EXECUTION_RECOVERED", payload: {} })
    ).rejects.toBeInstanceOf(LeaseHeldError);
    expect(live.seen.slowCalls + other.seen.slowCalls).toBe(1);
    expect((await events.read(id)).length).toBe(logged);
    latch.release();
    await h.waitForCompletion();
  });
});

describe("S7c - TimerService and recoverAbandoned claim through the runtime keeper", () => {
  it("a timer wake claims via the keeper (shared owner), the run takes its own hold, and everything is released", async () => {
    const timers = new InMemoryTimerStore();
    const r = rig({ deps: { timerStore: timers } });
    const sleeper = flow("sleeper", async (ctx) => {
      await ctx.suspend({ on: "Nap", timeout: 1_000 });
      return { woke: true };
    });
    r.rt.registerFlow(sleeper.definition, sleeper.runner);
    const h = await r.rt.start(sleeper, {});
    await h.waitForSuspend().catch(() => undefined);
    r.calls.length = 0;
    const legacy = new InMemoryLeaseStore({ now: () => r.clock.wall });
    const svc = new TimerService(r.rt, timers, {
      leases: { store: legacy, owner: "legacy-owner" },
      now: () => r.clock.wall + 10_000,
    });
    await svc.tick(r.clock.wall + 10_000);
    await untilAsync(async () => (await r.rt.loadState(h.executionId))?.status === "completed");
    expect(await legacy.get(h.executionId)).toBeNull(); // the legacy owner row was never written
    expect(r.calls.some((c) => c === `lease.acquire:${h.executionId}`)).toBe(true);
    await untilAsync(async () => !(await held(r.leases, h.executionId)));
  });

  it("recoverAbandoned claims via the keeper and leaves no lease behind", async () => {
    const latch = new Latch();
    const a = rig({ latch });
    a.rt.registerFlow(slowFlow.definition, slowFlow.runner);
    const h = await a.rt.start(slowFlow, {});
    const id = h.executionId;
    await latch.entered;
    // a second node (own keeper, same stores) sweeping an expired lease: simulate expiry by clock
    a.clock.wall += 120_000;
    const b = rig({ leases: a.leases, events: a.events, nodeId: "sweeper" });
    b.rt.registerFlow(slowFlow.definition, slowFlow.runner);
    b.clock.wall = a.clock.wall;
    const summary = await recoverAbandoned(b.rt, {
      leases: { store: a.leases, owner: "unused" },
      isAbandoned: () => true,
      fenced: true,
    });
    expect(summary.failed).toBe(0);
    expect(a.calls.filter((c) => c === `lease.acquire:${id}`).length).toBeGreaterThanOrEqual(2);
    latch.release();
    await h.waitForCompletion().catch(() => undefined);
    await untilAsync(async () => !(await held(a.leases, id)));
  });
});
