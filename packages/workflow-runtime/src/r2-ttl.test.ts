import { unwrapTainted } from "@loom/classify";
import type { EventStore } from "@loom/event-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import { inboxBackends } from "./__tests__/r2Backends";
import { Latch, build, eventsOf, flow, slow, until } from "./__tests__/r2Harness";
import {
  INBOX_TTL_ACTOR,
  MIN_INBOX_TTL_MS,
  createInboxSource,
  cursorsOf,
  inboxStreamId,
} from "./inbox";
import { InboxFullError } from "./types";
import type { InboxSource } from "./types";

// ADR 0110 amendment, D10a — journaled TTL expiry. Every clock here is injected (no sleeps): the
// message's envelope timestamp and the pass's "now" are the same fake clock, so "expired" is a number.

const TTL = 60_000; // the configured floor (MIN_INBOX_TTL_MS)

/** The same store with `storeNow` answered by a hand-driven clock (what a Postgres store reports as DB time). */
function withStoreClock(store: EventStore, now: () => number): EventStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "storeNow") return async () => now();
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

for (const backend of inboxBackends("ttl")) {
  describe.skipIf(backend.skip === true)(`inbox TTL expiry on ${backend.name}`, () => {
    beforeAll(() => backend.setup());
    afterAll(() => backend.teardown());
    let seq = 0;
    const id = () => `${backend.name}-e${++seq}-${Math.random().toString(36).slice(2, 6)}`;
    /** A runtime on a hand-driven clock; `ttl` undefined leaves expiry OFF. */
    const mk = (
      clock: { t: number },
      deps: Record<string, unknown> = {},
      opts: Parameters<typeof build>[1] = {}
    ) => build({ now: () => clock.t, ...deps }, { ...clocked(clock, backend.make()), ...opts });
    /**
     * Postgres reports DATABASE time as `storeNow` (which a test cannot advance), so on it the store
     * clock is the hand-driven one: sender and judge then age on the store's clock, the path under
     * test. Memory and SQLite have no `storeNow`: the runtime clock is used (the fallback path).
     */
    const clocked = <T extends { eventStore: EventStore }>(clock: { t: number }, stores: T): T =>
      backend.name === "postgres"
        ? { ...stores, eventStore: withStoreClock(stores.eventStore, () => clock.t) }
        : stores;
    const parkedOnGate = () =>
      flow("w", async (ctx) => {
        await ctx.suspend({ on: "Go" });
        return unwrapTainted(await ctx.receive<string>("hot"));
      });
    const consumed = async (h: ReturnType<typeof build>, e: string) =>
      (await eventsOf(h.eventStore, e, "MESSAGE_CONSUMED")).map(
        (c) => c.payload as Record<string, unknown>
      );

    it("an expired message is discarded by a journaled fact, never delivered, and the fact replays", async () => {
      const clock = { t: 1_000_000 };
      const h = mk(clock, { inboxMessageTtlMs: { topics: { cold: TTL } } });
      const f = parkedOnGate();
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      const m = await h.rt.send(e, { topic: "cold", payload: "STALE", messageId: "c1" });
      const service = new TimerService(h.rt, h.timers);
      // Not yet expired: the pass runs but discards nothing, and the row is armed for later.
      clock.t += TTL - 1_000;
      await service.tick(clock.t);
      expect(await consumed(h, e)).toEqual([]);
      clock.t += 2_000; // past envelope timestamp + TTL
      await service.tick(clock.t);
      const facts = await consumed(h, e);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        waitId: "__loom_discard__",
        topic: "cold",
        inboxSeq: m.inboxSeq,
        payload: null,
        discarded: true,
        expired: true,
        reason: "expired",
        skipped: 1,
        sender: { actor: INBOX_TTL_ACTOR },
      });
      const live = await h.rt.loadState(e);
      expect(cursorsOf(live?.variables ?? {}).cold).toBe(m.inboxSeq);
      // The owner is still parked: an expiry never resumes it.
      expect(live?.status).toBe("suspended");
      // The row was retired and nothing re-armed (nothing unexpired is left).
      expect(await h.timers.due(clock.t + 1e12)).toEqual([]);
      // Replay: a fresh runtime over the same stores folds the identical state (no clock, no stream).
      const fresh = h.sibling({ now: () => clock.t + 1e9 });
      const replayed = await fresh.loadState(e);
      expect(replayed?.variables._inbox).toEqual(live?.variables._inbox);
      expect(replayed?.variables._waitAnswers).toEqual(live?.variables._waitAnswers);
      // And the flow, resumed, receives the NEXT message, not the expired one.
      await h.rt.send(e, { topic: "hot", payload: "FRESH", messageId: "h1" });
      await h.rt.resume(e, { eventType: "Go", payload: null });
      await until(async () => (await h.rt.loadState(e))?.status === "completed", 8000);
      expect((await h.rt.loadState(e))?.variables._output).toBe("FRESH");
      expect((await consumed(h, e)).map((c) => c.payload)).not.toContain("STALE");
    });

    it("TTL off is unchanged: no row is written, nothing is discarded, the message is delivered", async () => {
      const clock = { t: 2_000_000 };
      const h = mk(clock); // no inboxMessageTtlMs
      const f = flow("w", async (ctx) => {
        await ctx.suspend({ on: "Go" });
        return unwrapTainted(await ctx.receive<string>("cold"));
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      await h.rt.send(e, { topic: "cold", payload: "OLD", messageId: "c1" });
      expect(await h.timers.due(clock.t + 1e12)).toEqual([]);
      clock.t += 100 * TTL;
      const service = new TimerService(h.rt, h.timers);
      await service.tick(clock.t);
      expect(await consumed(h, e)).toEqual([]);
      expect(await h.rt.expireInbox(e)).toEqual({ status: "off", expired: 0 });
      await h.rt.resume(e, { eventType: "Go", payload: null });
      await until(async () => (await h.rt.loadState(e))?.status === "completed", 8000);
      expect((await h.rt.loadState(e))?.variables._output).toBe("OLD");
    });

    it("a cold topic's expired message stops pinning the hot topic", async () => {
      const clock = { t: 3_000_000 };
      const h = mk(clock, {
        inboxMaxBacklog: 6,
        inboxMaxRetained: 12,
        inboxMessageTtlMs: { topics: { cold: TTL } },
      });
      const f = flow("w", async (ctx) => {
        for (let i = 0; i < 1000; i++) unwrapTainted(await ctx.receive("hot"));
        return unwrapTainted(await ctx.receive("cold"));
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await h.rt.start(f, {}, { executionId: e });
      await h.rt.send(e, { topic: "cold", payload: "pin", messageId: "cold" });
      // The owner consumes every hot message, but the unconsumed cold one at the bottom pins the stream.
      let refused: unknown;
      for (let i = 0; i < 60 && refused === undefined; i++) {
        await h.rt
          .send(e, { topic: "hot", payload: i, messageId: `h${i}` })
          .catch((err: unknown) => {
            refused = err;
          });
        await until(async () => {
          const st = await h.rt.loadState(e);
          return st?.status === "suspended";
        }, 8000);
      }
      expect(refused).toBeInstanceOf(InboxFullError);
      // Time passes; the owner is parked on a hot receive, so the expiry pass can journal.
      clock.t += 2 * TTL;
      const service = new TimerService(h.rt, h.timers);
      await until(async () => (await h.rt.loadState(e))?.status === "suspended", 8000);
      await service.tick(clock.t);
      await until(async () => (await consumed(h, e)).some((c) => c.expired === true), 8000);
      // The pin is gone: the hot topic is accepted again.
      await h.rt.send(e, { topic: "hot", payload: "after", messageId: "after" });
      expect(h.storageErrors).toEqual([]);
    });

    it("a notifier paused after its scan loses to the expiry: the expired message is never delivered", async () => {
      const clock = { t: 4_000_000 };
      const be = clocked(clock, backend.make());
      const real = createInboxSource(be.eventStore);
      let armed = false;
      let paused!: () => void;
      const pausedAt = new Promise<void>((r) => {
        paused = r;
      });
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const source: InboxSource = async (chain, topic, after, limit) => {
        const page = await real(chain, topic, after, limit);
        if (armed && page.length > 0) {
          armed = false;
          paused();
          await gate;
        }
        return page;
      };
      const h = build({ now: () => clock.t, inbox: source, inboxMessageTtlMs: TTL }, be);
      const f = flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>("t")));
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      armed = true;
      const m1 = await h.rt.send(e, { topic: "t", payload: "EXPIRED", messageId: "m1" });
      await pausedAt; // the notifier built its batch from cursor -1
      clock.t += 2 * TTL;
      const r = await h.rt.expireInbox(e);
      expect(r).toMatchObject({ status: "done", expired: 1 });
      release();
      // The notifier must refold, see the cursor, and deliver nothing.
      await h.rt.send(e, { topic: "t", payload: "FRESH", messageId: "m2" }).catch(() => undefined);
      await until(async () => (await h.rt.loadState(e))?.status === "completed", 8000);
      expect((await h.rt.loadState(e))?.variables._output).toBe("FRESH");
      const facts = await consumed(h, e);
      expect(facts.map((c) => c.payload)).not.toContain("EXPIRED");
      let cursor = -1;
      for (const c of facts) {
        const p = c as { inboxSeq: number; payload: unknown; waitId: string };
        if (p.waitId !== "__loom_discard__" && p.payload !== null) {
          expect(p.inboxSeq).toBeGreaterThan(cursor);
        }
        cursor = Math.max(cursor, p.inboxSeq);
      }
      expect(cursorsOf((await h.rt.loadState(e))?.variables ?? {}).t).toBe(m1.inboxSeq + 1);
    });

    it("a delivery that won leaves nothing to expire: delivered once, expiry is a no-op", async () => {
      const clock = { t: 5_000_000 };
      const h = mk(clock, { inboxMessageTtlMs: TTL });
      const f = flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>("t")));
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      await h.rt.send(e, { topic: "t", payload: "IN-TIME", messageId: "m1" });
      await until(async () => (await h.rt.loadState(e))?.status === "completed", 8000);
      clock.t += 10 * TTL;
      // The chain is finished (its stream is gone): the pass is a quiet "closed", nothing journaled.
      expect(await h.rt.expireInbox(e)).toMatchObject({ status: "closed", expired: 0 });
      const facts = await consumed(h, e);
      expect(facts).toHaveLength(1);
      expect(facts[0]?.payload).toBe("IN-TIME");
    });

    it("a running owner keeps the row and is retried; the discard lands once it parks", async () => {
      const clock = { t: 6_000_000 };
      const latch = new Latch();
      const h = mk(clock, { inboxMessageTtlMs: { topics: { cold: TTL } } }, { latch });
      const f = flow("w", async (ctx) => {
        await ctx.run(slow, {});
        await ctx.suspend({ on: "Go" });
        return "done";
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await h.rt.start(f, {}, { executionId: e });
      await h.rt.send(e, { topic: "cold", payload: "x", messageId: "c1" });
      clock.t += 2 * TTL;
      expect(await h.rt.expireInbox(e)).toMatchObject({ status: "not-parked", expired: 0 });
      const service = new TimerService(h.rt, h.timers);
      await service.tick(clock.t);
      expect((await h.timers.due(clock.t + 1e12)).length).toBe(1); // KEPT, not retired as obsolete
      expect(await consumed(h, e)).toEqual([]);
      latch.release();
      await until(async () => (await h.rt.loadState(e))?.status === "suspended", 8000);
      clock.t += 60_000; // past the retry backoff
      await service.tick(clock.t);
      await until(async () => (await consumed(h, e)).some((c) => c.expired === true), 8000);
      expect(await h.timers.due(clock.t + 1e12)).toEqual([]);
    });

    it("a pass is bounded: at most 1024 expire per wake, the rest are armed for the next", async () => {
      const clock = { t: 7_000_000 };
      const h = mk(clock, { inboxMessageTtlMs: TTL });
      const f = flow("w", async (ctx) => {
        await ctx.suspend({ on: "Go" });
        return "done";
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      const N = 1_100;
      for (let i = 0; i < N; i++) {
        await h.rt.send(e, { topic: "cold", payload: i, messageId: `c${i}` });
      }
      clock.t += 2 * TTL;
      const first = await h.rt.expireInbox(e);
      expect(first).toMatchObject({ status: "done", expired: 1024 });
      expect((await h.timers.due(clock.t + 5_000)).length).toBeGreaterThan(0); // the next pass is armed
      clock.t += 1_000;
      const second = await h.rt.expireInbox(e);
      expect(second).toMatchObject({ status: "done", expired: N - 1024 });
      const state = await h.rt.loadState(e);
      expect(Object.keys((state?.variables._waitAnswers as object) ?? {})).toEqual([
        "__loom_discard__",
      ]);
    }, 60_000);

    it("only a topic with a TTL expires; an unconfigured topic is untouched", async () => {
      const clock = { t: 8_000_000 };
      const h = mk(clock, { inboxMessageTtlMs: { topics: { a: TTL } } });
      const f = flow("w", async (ctx) => {
        await ctx.suspend({ on: "Go" });
        return "done";
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      await h.rt.send(e, { topic: "a", payload: 1, messageId: "a1" });
      const b = await h.rt.send(e, { topic: "b", payload: 2, messageId: "b1" });
      clock.t += 10 * TTL;
      expect(await h.rt.expireInbox(e)).toMatchObject({ status: "done", expired: 1 });
      const cursors = cursorsOf((await h.rt.loadState(e))?.variables ?? {});
      expect(cursors.a).toBeDefined();
      expect(cursors.b).toBeUndefined();
      expect(b.inboxSeq).toBeGreaterThan(cursors.a as number);
    });

    it("a bad TTL is refused at composition", () => {
      for (const bad of [
        0,
        -1,
        1.5,
        Number.NaN,
        MIN_INBOX_TTL_MS - 1,
        { default: 0 },
        { default: MIN_INBOX_TTL_MS - 1 },
        { topics: { a: -5 } },
        { topics: { a: 1_000 } },
      ]) {
        expect(() => mk({ t: 0 }, { inboxMessageTtlMs: bad })).toThrow(/messageTtlMs/);
      }
      // The floor itself is accepted.
      expect(() => mk({ t: 0 }, { inboxMessageTtlMs: MIN_INBOX_TTL_MS })).not.toThrow();
    });

    // ── review round: P1 (starvation), P2 (clock), P3-1 (shared instant) ──────────────────────────

    it("P1: expiry rows of busy owners are re-armed, not left at the head: a real timer behind them fires", async () => {
      const clock = { t: 20_000_000 };
      const latch = new Latch();
      const h = mk(clock, { inboxMessageTtlMs: { topics: { cold: TTL } } }, { latch });
      const busy = flow("busy", async (ctx) => {
        await ctx.run(slow, {});
        return "done";
      });
      const sleeper = flow("sleeper", async (ctx) => {
        await ctx.sleep(3 * TTL);
        return "woke";
      });
      h.rt.registerFlow(busy.definition, busy.runner);
      h.rt.registerFlow(sleeper.definition, sleeper.runner);
      const b1 = id();
      const b2 = id();
      const s = id();
      await h.rt.start(busy, {}, { executionId: b1 });
      await h.rt.start(busy, {}, { executionId: b2 });
      await (await h.rt.start(sleeper, {}, { executionId: s })).waitForSuspend();
      await h.rt.send(b1, { topic: "cold", payload: 1, messageId: "m" });
      await h.rt.send(b2, { topic: "cold", payload: 2, messageId: "m" });
      // batch 2: the two oldest due rows are the busy owners' expiry rows.
      const service = new TimerService(h.rt, h.timers, { batch: 2 });
      for (let i = 0; i < 20; i++) {
        clock.t += 60_000;
        await service.tick(clock.t);
      }
      await until(async () => (await h.rt.loadState(s))?.status === "completed", 8000);
      // The busy owners' rows did not pile up: one live row each.
      const rows = await h.timers.due(clock.t + 1e12);
      expect(rows.filter((r) => r.executionId === b1)).toHaveLength(1);
      expect(rows.filter((r) => r.executionId === b2)).toHaveLength(1);
      expect(rows.filter((r) => r.executionId === s)).toHaveLength(0);
      latch.release();
      await until(async () => (await h.rt.loadState(b1))?.status === "completed", 8000);
      await until(async () => (await h.rt.loadState(b2))?.status === "completed", 8000);
    }, 30_000);

    it("P1: a plain timer row of a running owner with nothing TTL'd pending is retired, not kept", async () => {
      const clock = { t: 21_000_000 };
      const latch = new Latch();
      const h = mk(clock, { inboxMessageTtlMs: TTL }, { latch });
      const busy = flow("busy2", async (ctx) => {
        await ctx.run(slow, {});
        return "done";
      });
      h.rt.registerFlow(busy.definition, busy.runner);
      const e = id();
      await h.rt.start(busy, {}, { executionId: e });
      // An obsolete wake row (the owner moved on): with TTL on it must still retire the ordinary way.
      await h.timers.schedule({ executionId: e, wakeAt: clock.t + 1 });
      clock.t += 10;
      await new TimerService(h.rt, h.timers).tick(clock.t);
      expect((await h.timers.due(clock.t + 1e12)).filter((r) => r.executionId === e)).toEqual([]);
      latch.release();
      await until(async () => (await h.rt.loadState(e))?.status === "completed", 8000);
    });

    it("P2: a sender whose clock is 10 min behind does not get a FRESH message expired (the store's clock judges)", async () => {
      const store = { t: 30_000_000 }; // the store's clock, hand-driven
      const be = backend.make();
      const stores = {
        ...be,
        eventStore: withStoreClock(be.eventStore, () => store.t),
      };
      const behind = build({ now: () => store.t - 600_000, inboxMessageTtlMs: TTL }, stores);
      const judge = behind.sibling({ now: () => store.t });
      const f = parkedOnGate();
      behind.rt.registerFlow(f.definition, f.runner);
      judge.registerFlow(f.definition, f.runner);
      const e = id();
      await (await behind.rt.start(f, {}, { executionId: e })).waitForSuspend();
      const m = await behind.rt.send(e, { topic: "cold", payload: "FRESH", messageId: "c1" });
      // Zero elapsed store time: stamped on the store's clock, so not expired.
      expect(await judge.expireInbox(e)).toMatchObject({
        status: "done",
        expired: 0,
        pending: true,
      });
      expect(await consumed(behind, e)).toEqual([]);
      // A TTL later, on the same store clock, it is.
      store.t += TTL + 1_000;
      expect(await judge.expireInbox(e)).toMatchObject({ status: "done", expired: 1 });
      expect(cursorsOf((await judge.loadState(e))?.variables ?? {}).cold).toBe(m.inboxSeq);
    });

    it("P2: a stamp AHEAD of the judge is suspect: never expired early, expired once the judge passes stamp + TTL; it holds back younger messages of its topic", async () => {
      const clock = { t: 40_000_000 };
      const ahead = mk(clock, { inboxMessageTtlMs: TTL });
      // A second node whose runtime clock is 10 min FAST shares the stores (no storeNow on memory/SQLite,
      // so the runtime clock stamps; on Postgres the hand-driven store clock does, and this is a no-op).
      const fast = ahead.sibling({ now: () => clock.t + 600_000, inboxMessageTtlMs: TTL });
      const f = parkedOnGate();
      ahead.rt.registerFlow(f.definition, f.runner);
      fast.registerFlow(f.definition, f.runner);
      const e = id();
      await (await ahead.rt.start(f, {}, { executionId: e })).waitForSuspend();
      if (backend.name !== "postgres") {
        const m1 = await fast.send(e, { topic: "cold", payload: "FUTURE", messageId: "f1" });
        const m2 = await ahead.rt.send(e, { topic: "cold", payload: "ONTIME", messageId: "o1" });
        clock.t += 2 * TTL; // m2 is long expired by its own stamp; m1 is stamped 10 min ahead
        // Never expired early (its stamp + TTL is in the judge's future) and, being the head of its
        // topic, it holds the younger message back (a prefix scan): the pin can outlive the TTL.
        expect(await ahead.rt.expireInbox(e)).toMatchObject({ status: "done", expired: 0 });
        expect(await consumed(ahead, e)).toEqual([]);
        clock.t += 600_000; // the judge's clock now passes stamp + TTL
        expect(await ahead.rt.expireInbox(e)).toMatchObject({ status: "done", expired: 2 });
        expect(cursorsOf((await ahead.rt.loadState(e))?.variables ?? {}).cold).toBe(m2.inboxSeq);
        expect(m2.inboxSeq).toBeGreaterThan(m1.inboxSeq);
      }
    });

    it("P3-1: an expiry row on the same instant as a real timer is not lost", async () => {
      const t0 = 50_000_000; // a whole second: the expiry row lands exactly on W = t0 + TTL
      const clock = { t: t0 };
      const h = mk(clock, { inboxMessageTtlMs: { topics: { cold: TTL } } });
      const W = t0 + TTL;
      const f = flow("w", async (ctx) => {
        await ctx.sleepUntil(W);
        await ctx.suspend({ on: "Go" });
        return "done";
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      await h.rt.send(e, { topic: "cold", payload: "x", messageId: "c1" });
      // One row serves both the sleep and the expiry.
      expect((await h.timers.due(W + 1e9)).filter((r) => r.executionId === e)).toHaveLength(1);
      clock.t = W;
      await new TimerService(h.rt, h.timers).tick(clock.t);
      await until(async () => (await consumed(h, e)).some((c) => c.expired === true), 8000);
      expect((await h.rt.loadState(e))?.status).toBe("suspended");
      expect(await h.timers.due(W + 1e12)).toEqual([]);
    });

    it.skipIf(backend.name !== "postgres")(
      "P2 (Postgres, REAL database time): a sender 10 min behind real time is not expired at once",
      async () => {
        const behind = build(
          { now: () => Date.now() - 600_000, inboxMessageTtlMs: TTL },
          backend.make()
        );
        const judge = behind.sibling({ now: () => Date.now() });
        const f = parkedOnGate();
        behind.rt.registerFlow(f.definition, f.runner);
        judge.registerFlow(f.definition, f.runner);
        const e = id();
        await (await behind.rt.start(f, {}, { executionId: e })).waitForSuspend();
        const before = (await behind.eventStore.storeNow?.()) ?? Number.NaN;
        await behind.rt.send(e, { topic: "cold", payload: "FRESH", messageId: "c1" });
        const after = (await behind.eventStore.storeNow?.()) ?? Number.NaN;
        // The envelope carries the DATABASE's time (between two reads of it), not the lagging sender clock.
        const stamp = (await behind.eventStore.read(inboxStreamId(e)))[0]?.timestamp ?? 0;
        expect(stamp >= before && stamp <= after).toBe(true);
        expect(await judge.expireInbox(e)).toMatchObject({ status: "done", expired: 0 });
        expect(await consumed(behind, e)).toEqual([]);
      }
    );
  });
}
