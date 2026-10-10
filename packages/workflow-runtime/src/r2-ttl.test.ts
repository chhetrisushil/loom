import { unwrapTainted } from "@loom/classify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import { inboxBackends } from "./__tests__/r2Backends";
import { Latch, build, eventsOf, flow, slow, until } from "./__tests__/r2Harness";
import { INBOX_TTL_ACTOR, createInboxSource, cursorsOf } from "./inbox";
import { InboxFullError } from "./types";
import type { InboxSource } from "./types";

// ADR 0110 amendment, D10a — journaled TTL expiry. Every clock here is injected (no sleeps): the
// message's envelope timestamp and the pass's "now" are the same fake clock, so "expired" is a number.

const TTL = 5_000;

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
    ) => build({ now: () => clock.t, ...deps }, { ...backend.make(), ...opts });
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
      const be = backend.make();
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
      for (const bad of [0, -1, 1.5, Number.NaN, { default: 0 }, { topics: { a: -5 } }]) {
        expect(() => mk({ t: 0 }, { inboxMessageTtlMs: bad })).toThrow(/messageTtlMs/);
      }
    });
  });
}
