import { unwrapTainted } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import {
  type EventStore,
  InMemoryAsyncEventStore,
  InMemoryLeaseStore,
  InMemoryTimerStore,
} from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { RedriveExhaustedError, TimerService } from "./TimerService";
import { Latch, build, flow, slow, until } from "./__tests__/r2Harness";
import { INBOX_WAKE_AT } from "./inbox";
import { recoverAbandoned } from "./recoverAbandoned";
import { SealedPayloadUnreadableError } from "./types";

// ADR 0130 D10 (R-d): a replay refusal leaves a durable wake row; the timer poll re-drives a
// `running` execution that carries one, only if it is abandoned. The wake row is a TIMER-store row,
// never an event-log append, so "an incapable node appends nothing" holds.

const SECRET = "123-45-6789";
let seq = 0;
const id = (): string => `wr-${++seq}-${Math.random().toString(36).slice(2, 6)}`;

/** The same raw stores seen as an UNMARKED log (a writer that did not stamp `metadata.seal`). */
function legacyView(inner: EventStore): EventStore {
  const strip = (events: EventEnvelope[]): EventEnvelope[] =>
    events.map((e) => {
      if (e.metadata?.seal === undefined) return e;
      const { seal: _seal, ...rest } = e.metadata;
      return { ...e, metadata: rest };
    });
  return {
    append: (e) => inner.append(e),
    appendBatch: (es) => inner.appendBatch!(es),
    read: async (i) => strip(await inner.read(i)),
    readFrom: async (i, from) => strip(await inner.readFrom(i, from)),
    readRange: async (i, from, to) => strip(await inner.readRange!(i, from, to)),
    head: (i) => inner.head!(i),
    subscribe: (i, h) => inner.subscribe(i, h),
    acquireFence: (i) => inner.acquireFence!(i),
    acquireFenceIf: (i, x) => inner.acquireFenceIf!(i, x),
    appendIfUnchanged: (i, ev, expect) => inner.appendIfUnchanged!(i, ev, expect),
    close: () => inner.close(),
  };
}

const f = flow("w", async (ctx) => {
  const y = unwrapTainted(await ctx.receive<unknown>("y"));
  await ctx.suspend({ on: "Go" });
  return { y };
});

/** Like `f`, but after the gate it pays a (latched) effect: the probe for a double drive. */
const g = flow("g", async (ctx) => {
  const y = unwrapTainted(await ctx.receive<unknown>("y"));
  await ctx.suspend({ on: "Go" });
  await ctx.run(slow, {});
  return { y };
});

/** A refusal row carries `refused: { head }`, the log head at refusal time (D10); its `wakeAt` is an ordinary instant. */
const isRefusalRow = (r: { refused?: { head: number } }): boolean => r.refused !== undefined;

async function scenario(opts: { flow?: typeof f; latchC?: Latch; clock?: { t: number } } = {}) {
  const fl = opts.flow ?? f;
  const clk = opts.clock;
  const deps = clk === undefined ? {} : { now: () => clk.t };
  const raw = {
    eventStore: new InMemoryAsyncEventStore(),
    timers: new InMemoryTimerStore(),
  };
  const keys = new InMemoryKeyStore();
  const sealedStore = new EncryptingEventStore(raw.eventStore, keys, {
    sensitive: { MESSAGE_CONSUMED: ["payload"], INBOX_MESSAGE: ["payload"] },
    subjectOf: (e) => e.executionId,
  });
  const a = build(deps, { ...raw, eventStore: sealedStore });
  // B and C are separate nodes over the same stores (B: incapable, unmarked view; C: capable).
  const b = build(deps, {
    ...raw,
    eventStore: legacyView(raw.eventStore),
  });
  const c = build(deps, {
    ...raw,
    eventStore: sealedStore,
    ...(opts.latchC !== undefined && { latch: opts.latchC }),
  });
  const d = build(deps, {
    ...raw,
    eventStore: sealedStore,
  });
  for (const n of [a, b, c, d]) n.rt.registerFlow(fl.definition, fl.runner);
  const e = id();
  await (await a.rt.start(fl, {}, { executionId: e })).waitForSuspend();
  await a.rt.send(e, { topic: "y", payload: { ssn: SECRET }, messageId: "m1" });
  await until(async () => (await a.rt.loadState(e))?.suspendedOn?.on === "Go");
  // node A "crashes" here (we simply never use it again). Clear send's own rows.
  for (const r of await raw.timers.due(Number.MAX_SAFE_INTEGER)) {
    await raw.timers.complete(r.executionId, r.wakeAt);
  }
  const leaseStore = new InMemoryLeaseStore();
  const lease = (owner: string) => ({ store: leaseStore, owner, ttlMs: 60_000 });
  /** The rows a REPLAY REFUSAL wrote (stamped, D10). */
  const wakeRows = async () =>
    (await raw.timers.due(Number.MAX_SAFE_INTEGER)).filter(
      (r) => r.executionId === e && isRefusalRow(r)
    );
  const logLen = async () => (await raw.eventStore.read(e)).length;
  const count = async (kind: string) =>
    (await raw.eventStore.read(e)).filter((x) => x.eventType === kind).length;
  return { raw, a, b, c, d, e, leaseStore, lease, wakeRows, logLen, count };
}

/** B resumes the unrelated Go gate and refuses at replay. */
async function refuseOnB(s: Awaited<ReturnType<typeof scenario>>) {
  const h = await s.b.rt.resume(s.e, { eventType: "Go", payload: null });
  const err = await h.waitForCompletion().then(
    () => undefined,
    (x: unknown) => x
  );
  expect(err).toBeInstanceOf(SealedPayloadUnreadableError);
}

/** A refusal-shaped row at `head` (D10): an ordinary instant, stamped by `refused`. */
const refusalRow = (executionId: string, head: number, wakeAt = 1) => ({
  executionId,
  wakeAt,
  refused: { head },
});
const BACKOFF = { baseMs: 100, capMs: 10_000, random: () => 1 };

/** Count calls of `rt.resume` (the poll's own re-drive, or the sweep's). */
function countResumes(rt: { resume: (...a: never[]) => unknown }): { n: number } {
  const counter = { n: 0 };
  const real = rt.resume.bind(rt) as (...a: unknown[]) => unknown;
  rt.resume = ((...a: unknown[]) => {
    counter.n++;
    return real(...a);
  }) as never;
  return counter;
}

describe("ADR 0130 D10 - replay refusal leaves a stamped wake row; the poll re-drives on EVIDENCE", () => {
  it("R-d repro: B's refusal writes ONE row stamped at the log head (no log append); capable C's poll, with evidence, completes it", async () => {
    const s = await scenario();
    expect(await s.wakeRows()).toHaveLength(0);
    await refuseOnB(s);
    await until(async () => (await s.wakeRows()).length === 1);
    const afterRefusal = await s.logLen();
    // the row is a timer-store row stamped with the head at refusal; the log did not move for it
    const head = await s.raw.eventStore.head!(s.e);
    expect((await s.wakeRows())[0]?.refused).toEqual({ head: head as number });
    expect((await s.wakeRows())[0]?.wakeAt).toBeGreaterThanOrEqual(0); // an ordinary instant, not an encoded stamp
    await new Promise((r) => setTimeout(r, 30));
    expect(await s.logLen()).toBe(afterRefusal);
    expect((await s.b.rt.loadState(s.e))?.status).toBe("running");

    const resumes = countResumes(s.c.rt);
    await new TimerService(s.c.rt, s.raw.timers, {
      fenced: true,
      isAbandoned: () => true,
    }).tick(Date.now() + 1);
    await until(async () => (await s.c.rt.loadState(s.e))?.status === "completed");
    expect(resumes.n).toBe(1); // the poll's own re-drive, nothing else
    expect((await s.c.rt.loadState(s.e))?.variables._output).toEqual({ y: { ssn: SECRET } });
    await new TimerService(s.c.rt, s.raw.timers, { leases: s.lease("c") }).tick(Date.now() + 1);
    await until(async () => (await s.wakeRows()).length === 0);
  });

  it("(b) no evidence, no re-drive: neither a predicate nor an EXISTING lease -> the row is kept and nothing is written", async () => {
    const s = await scenario();
    await refuseOnB(s);
    await until(async () => (await s.wakeRows()).length === 1);
    const before = await s.logLen();
    const resumes = countResumes(s.c.rt);
    // leases configured but NO lease exists for the execution (an absent lease is never evidence)
    const withLeases = new TimerService(s.c.rt, s.raw.timers, {
      leases: s.lease("c"),
      fenced: true,
    });
    // nothing configured at all
    const bare = new TimerService(s.c.rt, s.raw.timers, { fenced: true });
    for (let i = 0; i < 3; i++) {
      await withLeases.tick(Date.now() + 1);
      await bare.tick(Date.now() + 1);
    }
    expect(resumes.n).toBe(0);
    expect(await s.logLen()).toBe(before);
    expect(await s.wakeRows()).toHaveLength(1);
    // a predicate that says no is no evidence either
    await new TimerService(s.c.rt, s.raw.timers, { isAbandoned: () => false }).tick(Date.now() + 1);
    expect(resumes.n).toBe(0);
  });

  it("lease evidence: a LIVE lease holder is never superseded; an EXISTING lease that has lapsed is the evidence", async () => {
    const s = await scenario();
    await refuseOnB(s);
    await until(async () => (await s.wakeRows()).length === 1);
    const before = await s.logLen();
    await s.leaseStore.acquire(s.e, "live-node", 60_000);
    const resumes = countResumes(s.c.rt);
    const svc = new TimerService(s.c.rt, s.raw.timers, { leases: s.lease("c") });
    for (let i = 0; i < 3; i++) await svc.tick(Date.now() + 1);
    expect(resumes.n).toBe(0);
    expect(await s.logLen()).toBe(before);
    expect(await s.wakeRows()).toHaveLength(1);
    // lapse: the holder stopped renewing
    await s.leaseStore.acquire(s.e, "live-node", 1, Date.now() - 10_000);
    await until(async () => {
      await svc.tick(Date.now() + 1); // the held row's back-off lapses between polls
      return (await s.c.rt.loadState(s.e))?.status === "completed";
    });
    expect(resumes.n).toBe(1);
  });

  it("P1 regression: a capable node LIVE in a step (driven by a sweep, no lease) is never re-driven by another node's poll", async () => {
    const latchC = new Latch();
    const s = await scenario({ flow: g, latchC });
    await refuseOnB(s);
    await until(async () => (await s.wakeRows()).length === 1);
    // C's sweep (isAbandoned, fenced, NO leases) re-drives and goes live in the latched step
    const sweepP = recoverAbandoned(s.c.rt, {
      source: s.raw.eventStore,
      isAbandoned: () => true,
      fenced: true,
    });
    await latchC.entered;
    await until(async () => (await s.count("STEP_STARTED")) === 1);
    const recovered = await s.count("EXECUTION_RECOVERED");
    const logLen = await s.logLen();
    // D: the reviewer's probe (leases + fenced), and a sloppy always-true predicate on top
    const resumes = countResumes(s.d.rt);
    const leaseOnly = new TimerService(s.d.rt, s.raw.timers, {
      leases: s.lease("d"),
      fenced: true,
    });
    const sloppy = new TimerService(s.d.rt, s.raw.timers, {
      fenced: true,
      isAbandoned: () => true,
    });
    for (let i = 0; i < 3; i++) {
      await leaseOnly.tick(Date.now() + 1);
      await sloppy.tick(Date.now() + 1);
    }
    expect(resumes.n).toBe(0);
    expect(await s.count("STEP_STARTED")).toBe(1); // the effect is paid ONCE
    expect(await s.count("EXECUTION_RECOVERED")).toBe(recovered);
    expect(await s.logLen()).toBe(logLen);
    latchC.release();
    await sweepP;
    await until(async () => (await s.c.rt.loadState(s.e))?.status === "completed");
    expect(await s.count("STEP_STARTED")).toBe(1);
    // the stale row (the head moved past it) is retired, not left to be re-driven
    await sloppy.tick(Date.now() + 1);
    await until(async () => (await s.wakeRows()).length === 0);
  });

  it("rows that legitimately sit on a running execution (notifyPass contended, ambiguous send) are RETIRED, not re-driven", async () => {
    const latchC = new Latch();
    const s = await scenario({ flow: g, latchC });
    // C resumes Go and is live in the latched step: `running`, driven.
    const live = await s.c.rt.resume(s.e, { eventType: "Go", payload: null });
    await latchC.entered;
    await until(async () => (await s.count("STEP_STARTED")) === 1);
    const logLen = await s.logLen();
    const resumes = countResumes(s.d.rt);
    // the two writers of a plain inbox row on a running execution: a contended notifyPass, and the
    // ambiguous-tail send. Both are `INBOX_WAKE_AT` rows, NOT refusal rows.
    await s.raw.timers.schedule({ executionId: s.e, wakeAt: INBOX_WAKE_AT });
    const svc = new TimerService(s.d.rt, s.raw.timers, {
      fenced: true,
      isAbandoned: () => true,
    });
    await svc.tick(Date.now() + 1);
    expect(resumes.n).toBe(0);
    expect(await s.count("STEP_STARTED")).toBe(1);
    expect(await s.logLen()).toBe(logLen);
    await until(
      async () =>
        (await s.raw.timers.due(Number.MAX_SAFE_INTEGER)).filter(
          (r) => r.executionId === s.e && r.wakeAt === INBOX_WAKE_AT
        ).length === 0
    );
    latchC.release();
    await live.waitForCompletion();
  });

  it("(d) never re-drives while this node drives it (live handle) or has a pending start for it", async () => {
    const latchC = new Latch();
    const s = await scenario({ flow: g, latchC });
    const live = await s.c.rt.resume(s.e, { eventType: "Go", payload: null });
    await latchC.entered;
    await until(async () => (await s.count("STEP_STARTED")) === 1);
    const head = (await s.raw.eventStore.head!(s.e)) as number;
    // a refusal-shaped row at the CURRENT head (nothing moved since) - the head check alone passes
    await s.raw.timers.schedule(refusalRow(s.e, head));
    const resumes = countResumes(s.c.rt);
    const svc = new TimerService(s.c.rt, s.raw.timers, {
      fenced: true,
      isAbandoned: () => true,
    });
    await svc.tick(Date.now() + 1);
    expect(resumes.n).toBe(0);
    expect(await s.wakeRows()).toHaveLength(1); // held, not retired
    latchC.release();
    await live.waitForCompletion();
    // a pending successor start on this node (sequence 0 durable, handle not yet registered)
    const s2 = await scenario({ flow: g, latchC: new Latch() });
    const head2 = (await s2.raw.eventStore.head!(s2.e)) as number;
    await s2.raw.timers.schedule(refusalRow(s2.e, head2));
    (
      s2.d.rt as unknown as { startingSuccessors: Map<string, Promise<undefined>> }
    ).startingSuccessors.set(s2.e, new Promise(() => {}));
    const resumes2 = countResumes(s2.d.rt);
    await new TimerService(s2.d.rt, s2.raw.timers, {
      isAbandoned: () => true,
    }).tick(Date.now() + 1);
    expect(resumes2.n).toBe(0);
    expect(await s2.wakeRows()).toHaveLength(1);
  });

  it("(e) thousands of held refusal rows never starve a real timer: it fires on the NEXT tick, with no per-tick O(held) loadState", async () => {
    const latch = new Latch();
    const timers = new InMemoryTimerStore();
    const raw = {
      eventStore: new InMemoryAsyncEventStore(),
      timers,
    };
    const timed = flow("tmd", async (ctx) => {
      await ctx.sleepUntil(Date.now() + 5);
      return "woke";
    });
    const poller = build({}, { ...raw, latch });
    poller.rt.registerFlow(timed.definition, timed.runner);
    // 2000 refusal rows, OLDER than the real timer (they sort first): the worst case for starvation.
    const N = 2000;
    for (let i = 0; i < N; i++) await timers.schedule(refusalRow(`held-${i}`, 1, 1));
    await (await poller.rt.start(timed, {}, { executionId: "real" })).waitForSuspend();
    await new Promise((r) => setTimeout(r, 10));
    const loads = { n: 0 };
    const realLoad = poller.rt.loadState.bind(poller.rt);
    poller.rt.loadState = ((...a: Parameters<typeof realLoad>) => {
      loads.n++;
      return realLoad(...a);
    }) as typeof poller.rt.loadState;
    // no evidence configured: the node asks the store for NO refusal rows at all
    const svc = new TimerService(poller.rt, timers, { redriveBackoff: BACKOFF });
    await svc.tick(Date.now() + 1000);
    expect((await poller.rt.loadState("real"))?.status).toBe("completed"); // fired on the very next tick
    expect(loads.n).toBeLessThanOrEqual(2); // the real timer's own reads, nothing per held row
    for (let i = 0; i < 5; i++) await svc.tick(Date.now() + 1000);
    expect(loads.n).toBeLessThanOrEqual(4);
    // every refusal row is still there, untouched, for a node that has evidence
    expect(
      (await timers.due(Number.MAX_SAFE_INTEGER, 100_000)).filter((r) => r.refused).length
    ).toBe(N);
  }, 60_000);

  it("(e2) held rows are RESCHEDULED in the store (one row each, later instant), not held in memory: later ticks do no work for them", async () => {
    const timers = new InMemoryTimerStore();
    const raw = {
      eventStore: new InMemoryAsyncEventStore(),
      timers,
    };
    const blocked = flow("blk", async (ctx) => {
      await ctx.run(slow, {});
      return "ok";
    });
    const latch = new Latch();
    const owner = build({}, { ...raw, latch });
    const poller = build({}, raw);
    for (const n of [owner, poller]) n.rt.registerFlow(blocked.definition, blocked.runner);
    const N = 250;
    const now = Date.now();
    const handles = [];
    for (let i = 0; i < N; i++) {
      handles.push(await owner.rt.start(blocked, {}, { executionId: `h-${i}` }));
      const head = (await raw.eventStore.head!(`h-${i}`)) as number;
      await timers.schedule(refusalRow(`h-${i}`, head, now)); // a real refusal row is stamped at ~now
    }
    const loads = { n: 0 };
    const realLoad = poller.rt.loadState.bind(poller.rt);
    poller.rt.loadState = ((...a: Parameters<typeof realLoad>) => {
      loads.n++;
      return realLoad(...a);
    }) as typeof poller.rt.loadState;
    // evidence configured but the predicate says no: every row is HELD
    const svc = new TimerService(poller.rt, timers, {
      isAbandoned: () => false,
      redriveBackoff: BACKOFF,
      now: () => now,
    });
    for (let i = 0; i < 4; i++) await svc.tick(now); // batch 100: three ticks drain 250
    const drained = loads.n;
    expect(drained).toBeGreaterThanOrEqual(N);
    const rows = (await timers.due(Number.MAX_SAFE_INTEGER, 100_000)).filter((r) => r.refused);
    expect(rows).toHaveLength(N); // one row per execution: rescheduled, never duplicated
    expect(rows.every((r) => r.wakeAt > now)).toBe(true); // a later instant: not due again yet
    for (let i = 0; i < 5; i++) await svc.tick(now); // still inside the back-off window
    expect(loads.n).toBe(drained); // nothing fetched, nothing read
    latch.release();
    await Promise.all(handles.map((h) => h.waitForCompletion()));
  }, 60_000);

  it("a genuine timer with a negative / simulated wakeAt is never treated as a refusal row", async () => {
    const neg = flow("neg", async (ctx) => {
      await ctx.sleepUntil(-100);
      return "woke";
    });
    const timers = new InMemoryTimerStore();
    const n = build(
      {},
      {
        eventStore: new InMemoryAsyncEventStore(),
        timers,
      }
    );
    n.rt.registerFlow(neg.definition, neg.runner);
    const h = await n.rt.start(neg, {}, { executionId: "neg-1" });
    await h.waitForSuspend().catch(() => undefined);
    await timers.schedule({ executionId: "neg-1", wakeAt: -100 }); // the genuine timer row
    await timers.schedule({ executionId: "neg-2", wakeAt: -7 });
    const rows = await timers.due(Number.MAX_SAFE_INTEGER);
    expect(rows.every((r) => r.refused === undefined)).toBe(true);
    const resumes = countResumes(n.rt);
    await new TimerService(n.rt, timers, { isAbandoned: () => true, fenced: false }).tick(0);
    await until(async () => (await n.rt.loadState("neg-1"))?.status === "completed");
    expect(resumes.n).toBe(1); // woken as a timer, once
    expect((await timers.due(Number.MAX_SAFE_INTEGER)).some((r) => r.executionId === "neg-1")).toBe(
      false
    );
  });

  it("a refusal stamp riding on a real timer's own row does not retire the timer", async () => {
    // (exec, wakeAt) is the row key: a refusal at the SAME instant as the park's timer upserts the
    // stamp onto the timer row. The poll must still fire the timer.
    const sl = flow("sl", async (ctx) => {
      await ctx.sleepUntil(Date.now() + 50);
      return "woke";
    });
    const timers = new InMemoryTimerStore();
    const n = build(
      {},
      {
        eventStore: new InMemoryAsyncEventStore(),
        timers,
      }
    );
    n.rt.registerFlow(sl.definition, sl.runner);
    const h = await n.rt.start(sl, {}, { executionId: "sl-1" });
    await h.waitForSuspend();
    const [row] = await timers.due(Number.MAX_SAFE_INTEGER);
    expect(row).toBeDefined();
    await timers.schedule({
      executionId: "sl-1",
      wakeAt: (row as { wakeAt: number }).wakeAt,
      refused: { head: 99 },
    });
    await new TimerService(n.rt, timers, { isAbandoned: () => true }).tick(Date.now() + 10_000);
    await until(async () => (await n.rt.loadState("sl-1"))?.status === "completed");
  });

  it("P2: a stamp merged onto a real timer's key survives every HOLD branch (drivesLocally forced): the timer still fires", async () => {
    const sl = flow("sl2", async (ctx) => {
      await ctx.sleepUntil(Date.now() + 50);
      return "woke";
    });
    const timers = new InMemoryTimerStore();
    const n = build(
      {},
      {
        eventStore: new InMemoryAsyncEventStore(),
        timers,
      }
    );
    n.rt.registerFlow(sl.definition, sl.runner);
    const h = await n.rt.start(sl, {}, { executionId: "sl-2" });
    await h.waitForSuspend();
    const [row] = await timers.due(Number.MAX_SAFE_INTEGER);
    const wakeAt = (row as { wakeAt: number }).wakeAt;
    await timers.schedule({ executionId: "sl-2", wakeAt, refused: { head: 99 } });
    n.rt.drivesLocally = () => true; // the hold branch that used to complete the key
    await new TimerService(n.rt, timers, { isAbandoned: () => true }).tick(Date.now() + 10_000);
    await until(async () => (await n.rt.loadState("sl-2"))?.status === "completed");
  });

  it("P1: N concurrent pollers holding the same refusal row converge on ONE successor row, generation after generation", async () => {
    const blocked = flow("blk-p1", async (ctx) => {
      await ctx.run(slow, {});
      return "ok";
    });
    const timers = new InMemoryTimerStore();
    const raw = {
      eventStore: new InMemoryAsyncEventStore(),
      timers,
    };
    const latch = new Latch();
    const owner = build({}, { ...raw, latch });
    owner.rt.registerFlow(blocked.definition, blocked.runner);
    const handle = await owner.rt.start(blocked, {}, { executionId: "p1" });
    const head = (await raw.eventStore.head!("p1")) as number;
    let t = 1_000_000;
    await timers.schedule({ executionId: "p1", wakeAt: t, refused: { head } });
    const services = [0, 1, 2, 3].map(() => {
      const n = build({}, raw);
      n.rt.registerFlow(blocked.definition, blocked.runner);
      n.rt.drivesLocally = () => true; // forced hold, every tick
      return new TimerService(n.rt, timers, {
        isAbandoned: () => true,
        // a real (jittered) source: node-local jitter must NOT decide the successor's key
        redriveBackoff: { baseMs: 100, capMs: 1_000 },
        now: () => t,
      });
    });
    for (let gen = 0; gen < 12; gen++) {
      const [row] = await timers.due(Number.MAX_SAFE_INTEGER);
      t = (row as { wakeAt: number }).wakeAt;
      await Promise.all(services.map((s) => s.tick(t)));
      const rows = (await timers.due(Number.MAX_SAFE_INTEGER)).filter(
        (r) => r.executionId === "p1"
      );
      expect(rows).toHaveLength(1);
    }
    latch.release();
    await handle.waitForCompletion();
  }, 30_000);

  it("(f) the poll's attempts are bounded (cap, then retire + ONE report) and its markers cannot exhaust a capable sweep's maxRecoveries", async () => {
    const clk = { t: 20_000_000 };
    const s = await scenario({ clock: clk });
    await refuseOnB(s);
    await until(async () => (await s.wakeRows()).length === 1);
    const errors: unknown[] = [];
    const svc = new TimerService(s.b.rt, s.raw.timers, {
      fenced: true,
      isAbandoned: () => true,
      now: () => clk.t,
      maxRedriveAttempts: 3,
      redriveBackoff: { baseMs: 1, capMs: 1, random: () => 0 },
      onError: (_i: string, err: unknown) => errors.push(err),
    });
    for (let i = 0; i < 60; i++) {
      clk.t += 120_000; // clear every back-off (sealed back-off caps at 60 s for the sweep)
      await svc.tick(clk.t);
    }
    const markers = await s.count("EXECUTION_RECOVERED");
    expect(markers).toBeGreaterThan(0);
    expect(markers).toBeLessThanOrEqual(3);
    expect(errors.filter((x) => x instanceof RedriveExhaustedError)).toHaveLength(1);
    expect(await s.wakeRows()).toHaveLength(0); // retired at the cap
    // a capable sweep with a bound ABOVE what the poll spent still recovers the execution
    const sweep = await recoverAbandoned(s.c.rt, {
      source: s.raw.eventStore,
      isAbandoned: () => true,
      maxRecoveries: 4,
      fenced: true,
    });
    expect(sweep.exhausted).toBe(0);
    expect(sweep.recovered).toBe(1);
    await until(async () => (await s.c.rt.loadState(s.e))?.status === "completed");
  });

  it("(f) the poll applies maxRecoveries too", async () => {
    const clk = { t: 30_000_000 };
    const s = await scenario({ clock: clk });
    await refuseOnB(s);
    await until(async () => (await s.wakeRows()).length === 1);
    const errors: unknown[] = [];
    const svc = new TimerService(s.b.rt, s.raw.timers, {
      fenced: true,
      isAbandoned: () => true,
      now: () => clk.t,
      maxRecoveries: 2,
      maxRedriveAttempts: 50,
      redriveBackoff: { baseMs: 1, capMs: 1, random: () => 0 },
      onError: (_i: string, err: unknown) => errors.push(err),
    });
    for (let i = 0; i < 60; i++) {
      clk.t += 120_000;
      await svc.tick(clk.t);
    }
    expect(await s.count("EXECUTION_RECOVERED")).toBeLessThanOrEqual(2);
    expect(errors.filter((x) => x instanceof RedriveExhaustedError)).toHaveLength(1);
  });

  it("an incapable node's polls back off (injected clock, no hot loop), stay bounded, and a capable node still completes", async () => {
    const clk = { t: 5_000_000 };
    const s = await scenario({ clock: clk });
    await refuseOnB(s);
    await until(async () => (await s.wakeRows()).length === 1);
    const kindsBefore = (await s.raw.eventStore.read(s.e)).length;
    const errors: unknown[] = [];
    const svc = new TimerService(s.b.rt, s.raw.timers, {
      fenced: true,
      isAbandoned: () => true,
      now: () => clk.t,
      onError: (_i: string, err: unknown) => errors.push(err),
      redriveBackoff: BACKOFF,
    });
    const resumes = countResumes(s.b.rt);
    for (let i = 0; i < 200; i++) {
      clk.t += 50;
      await svc.tick(clk.t);
    }
    expect(resumes.n).toBeGreaterThan(0);
    expect(resumes.n).toBeLessThanOrEqual(10);
    expect(errors.length).toBeLessThanOrEqual(3);
    // On an UNMARKED legacy stream the incapable node cannot know in advance, so each (backed-off)
    // re-drive attempt appends only the re-drive's own marker; no payload-bearing event reaches the log.
    const added = (await s.raw.eventStore.read(s.e)).slice(kindsBefore);
    expect(added.length).toBeLessThanOrEqual(resumes.n * 2);
    for (const ev of added)
      expect(["EXECUTION_RECOVERED", "EXECUTION_RESUMED"]).toContain(ev.eventType);
    // a capable node (the sweep: its own evidence) still completes it
    const capable = await recoverAbandoned(s.c.rt, {
      source: s.raw.eventStore,
      isAbandoned: () => true,
      fenced: true, // B's polls were fenced: a fencing store refuses a MISSING token
    });
    expect(capable.recovered).toBe(1);
    await until(async () => (await s.c.rt.loadState(s.e))?.status === "completed");
  });

  it("a MARKED stream is refused before any fence acquire: a raw node's polls write nothing and keep the row", async () => {
    const s = await scenario();
    await refuseOnB(s);
    await until(async () => (await s.wakeRows()).length === 1);
    const raw = build(
      {},
      {
        eventStore: s.raw.eventStore,
        timers: s.raw.timers,
      }
    );
    raw.rt.registerFlow(f.definition, f.runner);
    const before = await s.logLen();
    const fenceBefore = await s.raw.eventStore.acquireFence!(s.e);
    let clock = Date.now();
    const svc = new TimerService(raw.rt, s.raw.timers, {
      now: () => clock,
      fenced: true,
      isAbandoned: () => true,
      redriveBackoff: BACKOFF,
    });
    for (let i = 0; i < 20; i++) {
      clock += 500;
      await svc.tick(clock);
    }
    expect(await s.logLen()).toBe(before);
    expect(await s.wakeRows()).toHaveLength(1);
    // no fence was taken by the refusing node: the next acquire is exactly one past ours
    const fenceAfter = await s.raw.eventStore.acquireFence!(s.e);
    expect(Number(fenceAfter)).toBe(Number(fenceBefore) + 1);
  });

  it("(g) ONE clock: a poll refusal (TimerService on its own clock) backs the SWEEP off on the runtime's clock", async () => {
    const s = await scenario();
    await refuseOnB(s);
    await until(async () => (await s.wakeRows()).length === 1);
    const resumes = countResumes(s.b.rt);
    // the poll runs on a clock unrelated to the runtime's (epoch 0): a back-off stamped on THAT clock
    // would already have expired for the sweep, which judges on the runtime's.
    const svc = new TimerService(s.b.rt, s.raw.timers, {
      isAbandoned: () => true,
      now: () => 0,
    });
    await svc.tick(Date.now() + 1);
    await until(() => resumes.n === 1);
    const sweep = await recoverAbandoned(s.b.rt, {
      source: s.raw.eventStore,
      isAbandoned: () => true,
    });
    expect(sweep.recovered).toBe(0);
    expect(resumes.n).toBe(1); // the poll's refusal backed the sweep off
  });

  it("two pollers (incapable + capable) race the row: exactly one completion, no ciphertext delivered, fence monotonic", async () => {
    const s = await scenario();
    await refuseOnB(s);
    await until(async () => (await s.wakeRows()).length === 1);
    const at = Date.now() + 1;
    const opts = (o: string) => ({
      fenced: true,
      isAbandoned: () => true,
    });
    await Promise.all([
      new TimerService(s.b.rt, s.raw.timers, opts("b")).tick(at),
      new TimerService(s.c.rt, s.raw.timers, opts("c")).tick(at),
    ]);
    // if B won the race, its refusal wrote a fresh row; C picks it up on a later poll
    for (let i = 0; i < 3; i++) {
      await new TimerService(s.c.rt, s.raw.timers, opts("c")).tick(Date.now() + 1);
      if ((await s.c.rt.loadState(s.e))?.status === "completed") break;
    }
    await until(async () => (await s.c.rt.loadState(s.e))?.status === "completed");
    const evs = await s.raw.eventStore.read(s.e);
    expect(evs.filter((x) => x.eventType === "EXECUTION_COMPLETED")).toHaveLength(1);
    expect((await s.c.rt.loadState(s.e))?.variables._output).toEqual({ y: { ssn: SECRET } });
    const seqs = evs.map((x) => x.sequence);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("no timer store: the refusal still throws the typed error, writes no row, and recoverAbandoned still recovers", async () => {
    const raw = {
      eventStore: new InMemoryAsyncEventStore(),
    };
    const keys = new InMemoryKeyStore();
    const sealedStore = new EncryptingEventStore(raw.eventStore, keys, {
      sensitive: { MESSAGE_CONSUMED: ["payload"], INBOX_MESSAGE: ["payload"] },
      subjectOf: (e) => e.executionId,
    });
    const a = build({}, { ...raw, eventStore: sealedStore, timers: null });
    const b = build(
      {},
      {
        eventStore: legacyView(raw.eventStore),
        timers: null,
      }
    );
    for (const n of [a, b]) n.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await a.rt.send(e, { topic: "y", payload: { ssn: SECRET }, messageId: "m1" });
    await until(async () => (await a.rt.loadState(e))?.suspendedOn?.on === "Go");
    const h = await b.rt.resume(e, { eventType: "Go", payload: null });
    await expect(h.waitForCompletion()).rejects.toBeInstanceOf(SealedPayloadUnreadableError);
    expect(b.storageErrors).toHaveLength(0);
    const sweep = await recoverAbandoned(a.rt, { source: raw.eventStore, isAbandoned: () => true });
    expect(sweep.recovered).toBeGreaterThanOrEqual(1);
    await until(async () => (await a.rt.loadState(e))?.status === "completed");
  });

  it("DST: seeded interleavings of polls over a {capable, incapable} fleet (no crash is injected here) - completes iff a capable node is up; ciphertext never reaches a flow", async () => {
    for (let seed = 1; seed <= 8; seed++) {
      const s = await scenario();
      let rng = seed * 7919;
      const rand = () => {
        rng = (rng * 1103515245 + 12345) & 0x7fffffff;
        return rng / 0x7fffffff;
      };
      await refuseOnB(s);
      await until(async () => (await s.wakeRows()).length === 1);
      let clock = Date.now();
      const svcB = new TimerService(s.b.rt, s.raw.timers, {
        isAbandoned: () => true,
        now: () => clock,
      });
      const svcC = new TimerService(s.c.rt, s.raw.timers, {
        isAbandoned: () => true,
        now: () => clock,
      });
      const capableUp = seed % 4 !== 0; // every 4th seed: the capable node never comes up
      for (let i = 0; i < 12; i++) {
        clock += 5_000;
        if (rand() < 0.6) await svcB.tick(clock);
        if (capableUp && rand() < 0.5) await svcC.tick(clock);
      }
      if (capableUp) {
        await svcC.tick(clock + 100_000);
        await until(async () => (await s.c.rt.loadState(s.e))?.status === "completed");
      } else {
        expect((await s.b.rt.loadState(s.e))?.status).toBe("running");
        // a row survives, and one is stamped at the CURRENT head (stale older ones retire lazily)
        const head = (await s.raw.eventStore.head!(s.e)) as number;
        expect((await s.wakeRows()).some((r) => r.refused?.head === head)).toBe(true);
      }
      for (const ev of await s.raw.eventStore.read(s.e)) {
        if (ev.eventType === "EXECUTION_COMPLETED") {
          expect(JSON.stringify(ev.payload)).not.toContain("__loomEnc");
        }
      }
    }
  }, 60_000);
});
