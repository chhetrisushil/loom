import { unwrapTainted } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { build, flow, tick, until } from "./__tests__/r2Harness";
import { appendInboxMessage } from "./inbox";

// ADR 0110 (R2) — the fourth review's P3s / minors, each as a regression test.

const msg = (messageId: string, topic = "x") => ({
  topic,
  messageId,
  payload: "p",
  sender: {},
  sentAt: 0,
});

class HookedStore extends InMemoryAsyncEventStore {
  before: (batch: string) => Promise<void> = async () => {};
  override async appendBatch(envelopes: Parameters<InMemoryAsyncEventStore["appendBatch"]>[0]) {
    await this.before(JSON.stringify(envelopes));
    return super.appendBatch(envelopes);
  }
}

describe("P3-a — exactly one notify pass per execution is ever in flight", () => {
  it("callers arriving in the microtask window after a pass settles join the queued follow-up", async () => {
    const h = build();
    const f = flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>("x")));
    h.rt.registerFlow(f.definition, f.runner);
    const live = new Map<string, number>();
    let maxInFlight = 0;
    let passes = 0;
    const priv = h.rt as unknown as {
      notifyPass: (...a: unknown[]) => Promise<unknown>;
    };
    const real = priv.notifyPass.bind(h.rt);
    priv.notifyPass = async (...a: unknown[]) => {
      const id = String(a[0]);
      passes++;
      const n = (live.get(id) ?? 0) + 1;
      live.set(id, n);
      maxInFlight = Math.max(maxInFlight, n);
      try {
        await tick(5);
        return await real(...a);
      } finally {
        live.set(id, (live.get(id) ?? 1) - 1);
      }
    };
    // `notifyInboxDetailed` is an async wrapper (extra microtask hops), so hook the pass promise
    // itself: the callbacks below run in the window right after the pass settles.
    const notifying = (h.rt as unknown as { notifying: Map<string, { pass: Promise<unknown> }> })
      .notifying;
    const all: Promise<unknown>[] = [];
    for (let depth = 0; depth < 8; depth++) {
      const id = `nobody${depth}`;
      all.push(h.rt.notifyInboxDetailed(id)); // the pass in flight
      all.push(h.rt.notifyInboxDetailed(id)); // queues the follow-up
      all.push(
        (async () => {
          // arrives `depth` microtask hops after the in-flight pass settled
          await notifying.get(id)?.pass;
          for (let i = 0; i < depth; i++) await Promise.resolve();
          return h.rt.notifyInboxDetailed(id);
        })()
      );
    }
    await Promise.all(all);
    expect(maxInFlight).toBe(1);
    expect(passes).toBeGreaterThanOrEqual(2);
  });
});

describe("P3-b — onEvent sees an inbox delivery's facts only once the batch is durable", () => {
  it("a lost batch emits nothing; the winning retry emits MESSAGE_CONSUMED / EXECUTION_RESUMED once", async () => {
    const inner = new HookedStore();
    const seen: string[] = [];
    let armed = false;
    let lost = 0;
    inner.before = async (batch) => {
      if (armed && lost === 0 && batch.includes("MESSAGE_CONSUMED")) {
        lost++;
        const st = await inner.read("e1");
        const s = (st[st.length - 1]?.sequence ?? 0) + 1;
        await inner.append({
          id: `x${s}`,
          workflowId: "w",
          executionId: "e1",
          eventType: "TIMER_FIRED",
          sequence: s,
          timestamp: Date.now(),
          payload: { wakeAt: 1 },
        } as never);
      }
    };
    const h = build(
      {
        onEvent: (e: EventEnvelope) => {
          if (armed) seen.push(e.eventType);
        },
      },
      { eventStore: inner }
    );
    const f = flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>("x")));
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await appendInboxMessage(h.eventStore, "e1", msg("m"), Date.now);
    armed = true;
    const r = await h.rt.notifyInboxDetailed("e1");
    expect(lost).toBe(1);
    await r.handle?.waitForCompletion();
    expect(seen.filter((k) => k === "MESSAGE_CONSUMED")).toHaveLength(1);
    expect(seen.filter((k) => k === "EXECUTION_RESUMED")).toHaveLength(1);
    // the durable log agrees with what subscribers saw
    const log = (await inner.read("e1")).map((e) => e.eventType);
    expect(log.filter((k) => k === "MESSAGE_CONSUMED")).toHaveLength(1);
  });

  it("advanceInbox (a duplicate-only advance) emits only after its batch lands", async () => {
    const inner = new HookedStore();
    const seen: string[] = [];
    let armed = false;
    let seenAtAppend = -1;
    inner.before = async (batch) => {
      if (armed && batch.includes("MESSAGE_CONSUMED")) seenAtAppend = seen.length;
    };
    const h = build(
      { onEvent: (e: EventEnvelope) => armed && seen.push(e.eventType) },
      { eventStore: inner }
    );
    const f = flow("w", async (ctx) => {
      unwrapTainted(await ctx.receive<string>("x"));
      return unwrapTainted(await ctx.receive<string>("x"));
    });
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await h.rt.send("e1", { topic: "x", payload: "a", messageId: "m" });
    await until(async () =>
      (await inner.read("e1")).some((e) => e.eventType === "EXECUTION_SUSPENDED" && e.sequence > 3)
    );
    await tick(30);
    armed = true;
    // a duplicate of the consumed message: journaled by advanceInbox, no resume
    await appendInboxMessage(h.eventStore, "e1", msg("m"), Date.now);
    await h.rt.notifyInboxDetailed("e1");
    expect(seenAtAppend).toBe(0); // nothing was announced before the batch was written
    expect(seen).toEqual(["MESSAGE_CONSUMED"]); // and it is announced once it landed
  });
});

describe("P3-c — the pin warning re-arms when the pin clears and a new pin forms", () => {
  it("warns again for a SECOND pin after the first was consumed", async () => {
    const h = build({ inboxMaxBacklog: 40, inboxMaxRetained: 80 });
    const f = flow("w", async (ctx) => {
      for (let i = 0; i < 45; i++) unwrapTainted(await ctx.receive("hot"));
      unwrapTainted(await ctx.receive("cold")); // clears the first pin
      for (;;) unwrapTainted(await ctx.receive("hot"));
    });
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await h.rt.send("e1", { topic: "cold", payload: "c", messageId: "c" });
    for (let i = 0; i < 45; i++) {
      await h.rt.send("e1", { topic: "hot", payload: i, messageId: `h${i}` });
      if (i % 5 === 4) await tick(30);
    }
    await until(
      async () =>
        (await h.eventStore.read("e1")).filter((e) => e.eventType === "MESSAGE_CONSUMED").length >=
        46,
      4000
    );
    // second pin: a topic nothing consumes, then hot traffic
    await h.rt.send("e1", { topic: "cold2", payload: "c2", messageId: "c2" });
    for (let i = 45; i < 125; i++) {
      try {
        await h.rt.send("e1", { topic: "hot", payload: i, messageId: `h${i}` });
      } catch {
        break;
      }
      if (i % 5 === 4) await tick(30);
    }
    const pins = h.warnings.filter((w) => w.includes("inboxMaxRetained"));
    expect(pins.some((w) => w.includes('topic "cold"'))).toBe(true);
    expect(pins.some((w) => w.includes('topic "cold2"'))).toBe(true);
    expect(pins.filter((w) => w.includes('topic "cold2"'))).toHaveLength(1);
  });
});

describe("Minor-2 — inbox bounds reject nonsense", () => {
  for (const key of ["inboxMaxBacklog", "inboxMaxRetained", "inboxMaxPayloadBytes"] as const) {
    for (const bad of [Number.NaN, 1.5, -3, 0, Number.POSITIVE_INFINITY]) {
      it(`${key}=${bad} is a clear config error`, () => {
        expect(() => build({ [key]: bad })).toThrow(
          new RegExp(`${key} must be a positive integer`)
        );
      });
    }
  }
  it("valid bounds still construct", () => {
    expect(() => build({ inboxMaxBacklog: 5, inboxMaxRetained: 20 })).not.toThrow();
  });
});
