import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryLeaseStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime, type WorkflowRuntimeDeps } from "./WorkflowRuntime";
import { Latch, until } from "./__tests__/r2Harness";
import { LeaseHeldError, LeaseLostError } from "./leaseKeeper";
import type { FlowRunner, RegisteredFlow } from "./types";

// ADR 0130 D11 option 2 (S7g): the DEFAULT acquire mode is LAZY. A run takes no lease until it has
// gone `lazyGraceMs` unleased. Deterministic: the grace timer is captured through the keeper's
// injectable `after` and fired by hand; no sleeps.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const echo = step$({ id: "echo", name: "Echo", toolId: "echo", ...io });
const slow = step$({ id: "slow", name: "Slow", toolId: "slow", ...io });
const GRACE = 7777;

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

const quick = flow("quick", async (ctx) => {
  await ctx.run(echo, { a: 1 });
  return { done: true };
});
const longRun = flow("longRun", async (ctx) => {
  await ctx.run(slow, {});
  await ctx.run(echo, { after: true });
  return { done: true };
});

let seq = 0;
const newId = (): string => `lz-${++seq}-${Math.random().toString(36).slice(2, 6)}`;

class SpyLeases extends InMemoryLeaseStore {
  readonly calls: string[] = [];
  override async acquire(...a: Parameters<InMemoryLeaseStore["acquire"]>) {
    this.calls.push(`acquire:${a[0]}`);
    return super.acquire(...a);
  }
  override async acquireMany(...a: Parameters<NonNullable<InMemoryLeaseStore["acquireMany"]>>) {
    this.calls.push(`acquire:${[...a[0]].join(",")}`);
    return super.acquireMany(...a);
  }
  override async release(...a: Parameters<InMemoryLeaseStore["release"]>) {
    this.calls.push(`release:${a[0]}`);
    return super.release(...a);
  }
  override async releaseMany(...a: Parameters<NonNullable<InMemoryLeaseStore["releaseMany"]>>) {
    this.calls.push(`release:${[...a[0]].join(",")}`);
    return super.releaseMany(...a);
  }
}

function rig(opts: { latch?: Latch; hb?: Record<string, unknown> } = {}) {
  const clock = { mono: 1_000, wall: 1_700_000_000_000 };
  const graceTimers: Array<{ fn: () => void; cancelled: boolean; fired: boolean }> = [];
  const leases = new SpyLeases({ now: () => clock.wall });
  const events = new InMemoryAsyncEventStore();
  const effects = new EffectRuntime();
  const seen = { sawAbort: undefined as unknown };
  effects.register("echo", new ToolEffect(async (i: unknown) => i));
  effects.register(
    "slow",
    new ToolEffect(async (i: unknown, ctx) => {
      opts.latch?.enter();
      ctx.signal?.addEventListener("abort", () => {
        seen.sawAbort = ctx.signal?.reason;
      });
      await opts.latch?.promise;
      return i;
    })
  );
  const rt = new WorkflowRuntime({
    eventStore: events,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    inboxEnabled: true,
    now: () => clock.wall,
    heartbeat: {
      leaseStore: leases,
      nodeId: "n1",
      incarnation: "i1",
      ttlMs: 30_000,
      lazyGraceMs: GRACE,
      monotonicNow: () => clock.mono,
      wallNow: () => clock.wall,
      every: () => () => {},
      after: (fn: () => void, ms: number) => {
        if (ms !== GRACE) return () => {}; // the keeper's own store-timeout timers: inert
        const t = { fn, cancelled: false, fired: false };
        graceTimers.push(t);
        return () => {
          t.cancelled = true;
        };
      },
      ...opts.hb,
    },
  } as WorkflowRuntimeDeps);
  const fireGrace = (): void => {
    for (const t of graceTimers)
      if (!t.cancelled && !t.fired) {
        t.fired = true;
        t.fn();
      }
  };
  return { rt, leases, events, clock, graceTimers, fireGrace, seen };
}

describe("S7g - lazy heartbeat leases (the default)", () => {
  it("a run that finishes inside its grace window never touches the lease store", async () => {
    const r = rig();
    const h = await r.rt.start(quick, {});
    await h.waitForCompletion();
    r.fireGrace(); // the (cancelled) timer firing late is a no-op
    expect(r.leases.calls).toEqual([]);
    expect(r.graceTimers.length).toBe(1);
    expect(r.graceTimers.every((t) => t.cancelled)).toBe(true);
    expect(await r.leases.get(h.executionId)).toBeNull();
  });

  it("a run still going after the grace acquires; the lease is released before the handle resolves", async () => {
    const latch = new Latch();
    const r = rig({ latch });
    const h = await r.rt.start(longRun, {});
    const id = h.executionId;
    await latch.entered;
    // inside the grace window: no lease row (an absent lease is NO evidence)
    expect(await r.leases.get(id)).toBeNull();
    expect(r.leases.calls).toEqual([]);
    r.fireGrace();
    await until(async () => (await r.leases.get(id)) !== null);
    expect(r.rt.leaseKeeper?.validNow(id)).toBe(true);
    latch.release();
    await h.waitForCompletion();
    expect(await r.leases.get(id)).toBeNull();
    expect(r.rt.leaseKeeper?.size).toBe(0);
  });

  it("the delayed acquire finds another live owner: the run is told the lease is lost (taken-over) and appends nothing more", async () => {
    const latch = new Latch();
    const r = rig({ latch });
    const id = newId();
    // a live driver elsewhere holds the unexpired lease (eager would have stood the start down)
    await r.leases.acquire(id, "other:node", 30_000, r.clock.wall);
    const h = await r.rt.start(longRun, {}, { executionId: id });
    await latch.entered;
    await until(async () =>
      (await r.events.read(id)).some((e: EventEnvelope) => e.eventType === "STEP_STARTED")
    );
    const logged = (await r.events.read(id)).length;
    r.fireGrace();
    const err = await h.waitForCompletion().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(LeaseLostError);
    expect((err as LeaseLostError).reason).toBe("taken-over");
    expect(r.seen.sawAbort).toBeInstanceOf(LeaseLostError);
    latch.release();
    // The handle already rejected with the loss: the run has unwound, so the log cannot grow.
    expect((await r.events.read(id)).length).toBe(logged);
    // the other owner's lease is untouched
    expect((await r.leases.get(id))?.owner).toBe("other:node");
  });

  it("a lease lost AFTER the lazy acquire still aborts the run (self-fencing applies from the acquire on)", async () => {
    const latch = new Latch();
    const r = rig({ latch });
    const h = await r.rt.start(longRun, {});
    const id = h.executionId;
    await latch.entered;
    await until(async () =>
      (await r.events.read(id)).some((e: EventEnvelope) => e.eventType === "STEP_STARTED")
    );
    r.fireGrace();
    await until(async () => (await r.leases.get(id)) !== null);
    const logged = (await r.events.read(id)).length;
    r.clock.mono += 30_000; // stalled past the deadline
    r.clock.wall += 30_000;
    latch.release();
    const err = await h.waitForCompletion().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(LeaseLostError);
    expect((await r.events.read(id)).length).toBe(logged);
  });

  it("the delayed acquire's outcome is UNKNOWN (store error): the confirming retry bypasses the quiet period and leases the run before its deadline", async () => {
    const latch = new Latch();
    const r = rig({ latch });
    let down = true;
    const orig = r.leases.acquireMany.bind(r.leases);
    r.leases.acquireMany = async (...a: Parameters<typeof orig>) => {
      if (down) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      return orig(...a);
    };
    const h = await r.rt.start(longRun, {});
    const id = h.executionId;
    await latch.entered;
    r.fireGrace(); // the first attempt fails: the row MAY exist
    await until(() => r.graceTimers.filter((t) => !t.cancelled && !t.fired).length === 1);
    expect(await r.leases.get(id)).toBeNull(); // (not applied here)
    down = false;
    r.fireGrace(); // the retry: inside the keeper's quiet period, but a confirming re-acquire bypasses it
    await until(async () => (await r.leases.get(id)) !== null);
    // confirmed: the self-fence is gone, the run is an ordinary leased run past the old deadline
    r.clock.mono += 24_000;
    r.clock.wall += 24_000;
    expect(r.rt.leaseKeeper?.validNow(id)).toBe(true);
    latch.release();
    await h.waitForCompletion();
    expect(await r.leases.get(id)).toBeNull();
  });

  it("an unknown acquire outcome that no retry confirms self-fences the run at send time + ttl - margin (never drives past a row's possible expiry)", async () => {
    const latch = new Latch();
    const r = rig({ latch });
    const orig = r.leases.acquireMany.bind(r.leases);
    // The row is APPLIED, then the reply is lost: exactly the "self-made row" hazard.
    r.leases.acquireMany = async (...a: Parameters<typeof orig>) => {
      await orig(...a);
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    };
    const h = await r.rt.start(longRun, {});
    const id = h.executionId;
    await latch.entered;
    await until(async () =>
      (await r.events.read(id)).some((e: EventEnvelope) => e.eventType === "STEP_STARTED")
    );
    r.fireGrace();
    await until(async () => (await r.leases.get(id)) !== null); // the row exists though nobody knows
    const logged = (await r.events.read(id)).length;
    r.clock.mono += 24_999; // still inside send + ttl - margin (25 000)
    r.clock.wall += 24_999;
    r.fireGrace(); // the retry also fails unknown: it must NOT extend the deadline
    await until(() => r.graceTimers.filter((t) => !t.cancelled && !t.fired).length === 1);
    r.clock.mono += 2;
    r.clock.wall += 2;
    latch.release();
    const err = await h.waitForCompletion().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(LeaseLostError);
    expect((err as LeaseLostError).reason).toBe("deadline");
    expect((await r.events.read(id)).length).toBe(logged);
  });

  it("an acquire that provably sent nothing (the keeper's quiet period) leaves the run UNLEASED, not fenced: no evidence, never false evidence", async () => {
    const latch = new Latch();
    const r = rig({ latch });
    const down = (): never => {
      throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    };
    const orig = r.leases.acquireMany.bind(r.leases);
    let failing = true;
    r.leases.acquireMany = async (...a: Parameters<typeof orig>) => {
      if (failing) down();
      return orig(...a);
    };
    // two failures in one flush arm the quiet period for a TTL
    const keeper = r.rt.leaseKeeper;
    await Promise.allSettled([keeper?.acquire("q1"), keeper?.acquire("q2")]);
    failing = false;
    const h = await r.rt.start(longRun, {});
    const id = h.executionId;
    await latch.entered;
    r.fireGrace(); // LeaseStoreQuietError: nothing sent
    await until(() => r.graceTimers.filter((t) => !t.cancelled && !t.fired).length === 1);
    r.clock.mono += 28_000; // past send + ttl - margin, still inside the quiet period
    r.clock.wall += 28_000;
    expect(r.rt.leaseKeeper?.validNow(id)).toBe(false); // unleased
    latch.release();
    await h.waitForCompletion(); // completes: nothing fenced it
    expect(await r.leases.get(id)).toBeNull();
  });

  it("a LATE answer (after the grant's own deadline) is its own reason, `deadline`, never `taken-over`: the run self-fences instead of being left unleased", async () => {
    const latch = new Latch();
    const r = rig({ latch });
    let answer!: () => void;
    const slowReply = new Promise<void>((res) => {
      answer = res;
    });
    const orig = r.leases.acquireMany.bind(r.leases);
    r.leases.acquireMany = async (...a: Parameters<typeof orig>) => {
      const got = await orig(...a);
      await slowReply; // applied, but the reply is stalled past the deadline
      return got;
    };
    const h = await r.rt.start(longRun, {});
    const id = h.executionId;
    await latch.entered;
    r.fireGrace();
    await until(async () => (await r.leases.get(id)) !== null); // the row is written, the reply pending
    r.clock.mono += 26_000;
    r.clock.wall += 26_000;
    answer();
    latch.release();
    const err = await h.waitForCompletion().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(LeaseLostError);
    expect((err as LeaseLostError).reason).toBe("deadline");
  });

  it("closing the runtime tells a run still in its grace window `closed`, and an acquire resolved false by the close is not reported taken-over", async () => {
    const latch = new Latch();
    const r = rig({ latch });
    const h = await r.rt.start(longRun, {});
    await latch.entered;
    await r.rt.closeHeartbeat();
    latch.release();
    const err = await h.waitForCompletion().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(LeaseLostError);
    expect((err as LeaseLostError).reason).toBe("closed");
  });

  it("resume is EAGER (a predecessor's row may exist); only a fresh start is lazy; a recovery drive of a RUNNING one stands down", async () => {
    const r = rig();
    const waits = flow("waits", async (ctx) => {
      await ctx.suspend({ on: "Go" });
      return { done: true };
    });
    r.rt.registerFlow(waits.definition, waits.runner);
    const id = newId();
    await (await r.rt.start(waits, {}, { executionId: id })).waitForSuspend();
    expect(r.leases.calls).toEqual([]); // parked inside the grace window: the store never heard of it
    const h = await r.rt.resume(id, { eventType: "Go", payload: null });
    await h.waitForCompletion();
    expect(r.leases.calls.some((c) => c.startsWith("acquire:"))).toBe(true); // the resume leased eagerly
    expect(r.leases.calls.some((c) => c.startsWith("release:"))).toBe(true);
    // a RUNNING execution under a live foreign lease: a recovery resume stands down (no fence, no append)
    const live = newId();
    const latch = new Latch();
    const r2 = rig({ latch });
    r2.rt.registerFlow(longRun.definition, longRun.runner);
    const hl = await r2.rt.start(longRun, {}, { executionId: live });
    await latch.entered;
    await until(async () =>
      (await r2.events.read(live)).some((e: EventEnvelope) => e.eventType === "STEP_STARTED")
    );
    await r2.leases.acquire(live, "other:node", 30_000, r2.clock.wall);
    const logged = (await r2.events.read(live)).length;
    await expect(
      r2.rt.resume(live, { eventType: "EXECUTION_RECOVERED", payload: {} })
    ).rejects.toBeInstanceOf(LeaseHeldError);
    expect((await r2.events.read(live)).length).toBe(logged);
    expect((await r2.leases.get(live))?.owner).toBe("other:node");
    latch.release();
    void hl;
  });

  it("a start on a caller-chosen id whose stream already exists is EAGER (classified from the log): a live foreign row stands it down", async () => {
    const r = rig();
    const id = newId();
    const h = await r.rt.start(quick, {}, { executionId: id });
    await h.waitForCompletion(); // the stream now exists
    await r.leases.acquire(id, "other:node", 30_000, r.clock.wall);
    const before = r.leases.calls.length;
    await expect(r.rt.start(quick, {}, { executionId: id })).rejects.toThrow();
    // eager: the stand-down came from an acquire call on the wire, not a delayed one
    expect(r.leases.calls.slice(before).some((c) => c.startsWith("acquire:"))).toBe(true);
    expect(r.graceTimers.filter((t) => !t.cancelled).length).toBe(0);
  });

  it("a run hooks onto a claimant's lease immediately (no second acquire, no grace)", async () => {
    const r = rig();
    const id = newId();
    const claim = await r.rt.acquireDriverLease(id); // the poll / sweep claim: always eager
    expect(claim).not.toBeNull();
    const before = r.leases.calls.length;
    const h = await r.rt.start(quick, {}, { executionId: id });
    await h.waitForCompletion();
    expect(r.graceTimers.length).toBe(0); // no lazy hold was created
    expect(r.leases.calls.slice(before).filter((c) => c.startsWith("acquire"))).toEqual([]);
    expect(await r.leases.get(id)).not.toBeNull(); // the claimant's hold still owns the row
    await claim?.release();
    expect(await r.leases.get(id)).toBeNull();
  });

  it('acquire: "eager" restores the S7c protocol (lease before the first append, no grace timer)', async () => {
    const r = rig({ hb: { acquire: "eager" } });
    const h = await r.rt.start(quick, {});
    await h.waitForCompletion();
    expect(r.graceTimers.length).toBe(0);
    expect(r.leases.calls.some((c) => c.startsWith("acquire:"))).toBe(true);
  });

  it("an invalid acquire mode or grace throws at construction", () => {
    const mk = (hb: Record<string, unknown>) =>
      new WorkflowRuntime({
        eventStore: new InMemoryAsyncEventStore(),
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        heartbeat: { leaseStore: new InMemoryLeaseStore(), ...hb },
      } as never);
    expect(() => mk({ acquire: "sometimes" })).toThrow(/eager.*lazy/);
    expect(() => mk({ lazyGraceMs: -1 })).toThrow(/lazyGraceMs/);
    expect(() => mk({ lazyGraceMs: Number.NaN })).toThrow(/lazyGraceMs/);
  });
});
