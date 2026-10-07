import { unwrapTainted } from "@loom/classify";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import { build, flow, kinds, tick, until } from "./__tests__/r2Harness";
import { INBOX_WAKE_AT, appendInboxMessage, dedupeKeyOf, inboxStreamId } from "./inbox";

// ADR 0110 (R2) — the third review's findings, each as a regression test.

const msg = (messageId: string, payload: unknown = "p", topic = "x") => ({
  topic,
  messageId,
  payload,
  sender: {},
  sentAt: 0,
});
const recv = (id = "w") =>
  flow(id, async (ctx) => unwrapTainted(await ctx.receive<string>("x")) as string);
/** An in-memory store whose atomic batch first runs `before` (a window between fold and batch). */
class HookedStore extends InMemoryAsyncEventStore {
  before: (batch: string) => Promise<void> = async () => {};
  override async appendBatch(envelopes: Parameters<InMemoryAsyncEventStore["appendBatch"]>[0]) {
    await this.before(JSON.stringify(envelopes));
    return super.appendBatch(envelopes);
  }
}
const timerFired = async (inner: HookedStore): Promise<void> => {
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
};
const statusOf = async (h: ReturnType<typeof build>, id = "e1") =>
  (await h.rt.loadState(id, h.rt.systemOptions()))?.status;
const count = (ks: string[], k: string) => ks.filter((x) => x === k).length;

describe("P2-1a — an unfenced park that is fenced LATER (acquire without append) is still answered", () => {
  it("falls back to the conditional fence: delivered, a truthful handle, no storage error", async () => {
    const h = build({});
    const f = recv();
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await h.rt.acquireFence("e1"); // the documented re-dispatch path: a fence with no append
    await appendInboxMessage(h.eventStore, "e1", msg("m"), Date.now);
    const r = await h.rt.notifyInboxDetailed("e1");
    expect(r.contended).toBe(false);
    expect(r.handle).toBeDefined();
    await r.handle?.waitForCompletion();
    const k = await kinds(h.eventStore, "e1");
    expect(count(k, "MESSAGE_CONSUMED")).toBe(1);
    expect(k).toContain("EXECUTION_COMPLETED");
    expect(h.storageErrors).toEqual([]);
  });
});

describe("P2-1b — an event landing between the notifier's fold and its batch is refolded, not stranded", () => {
  for (const fenced of [false, true]) {
    it(`TIMER_FIRED in the window, park ${fenced ? "fenced" : "unfenced"}: delivered, row kept only if contended`, async () => {
      const inner = new HookedStore();
      let armed = false;
      let fired = false;
      inner.before = async (batch) => {
        if (armed && !fired && batch.includes("MESSAGE_CONSUMED")) {
          fired = true;
          await timerFired(inner);
        }
      };
      const view = inner;
      const h = build({}, { eventStore: view });
      const f = recv();
      h.rt.registerFlow(f.definition, f.runner);
      const fence = fenced ? await h.rt.acquireFence("e1") : undefined;
      await (
        await h.rt.start(f, {}, { executionId: "e1", ...(fence !== undefined && { fence }) })
      ).waitForSuspend();
      await appendInboxMessage(h.eventStore, "e1", msg("m"), Date.now);
      armed = true;
      const r = await h.rt.notifyInboxDetailed("e1");
      expect(fired).toBe(true);
      expect(r.contended).toBe(false);
      expect(r.handle).toBeDefined();
      await r.handle?.waitForCompletion();
      expect(count(await kinds(inner, "e1"), "MESSAGE_CONSUMED")).toBe(1);
      expect(h.storageErrors).toEqual([]);
    });
  }

  it("a window that keeps changing past the attempt cap reports contended AND keeps the due row", async () => {
    const inner = new HookedStore();
    inner.before = async (batch) => {
      if (batch.includes("MESSAGE_CONSUMED")) await timerFired(inner);
    };
    const view = inner;
    const h = build({}, { eventStore: view });
    const f = recv();
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await appendInboxMessage(h.eventStore, "e1", msg("m"), Date.now);
    const r = await h.rt.notifyInboxDetailed("e1");
    expect(r.contended).toBe(true);
    expect(r.handle).toBeUndefined();
    expect((await h.timers.due(Date.now() + 1e9)).some((t) => t.wakeAt === INBOX_WAKE_AT)).toBe(
      true
    );
  });
});

describe("P2-1c — rival notifiers on an unfenced park: exactly once, quietly, honestly", () => {
  it("4 concurrent notifiers x 2 runtimes, 25 rounds", async () => {
    for (let round = 0; round < 25; round++) {
      const h = build({});
      const sib = h.sibling();
      const f = recv();
      h.rt.registerFlow(f.definition, f.runner);
      sib.registerFlow(f.definition, f.runner);
      await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
      await appendInboxMessage(h.eventStore, "e1", msg("m"), Date.now);
      const rs = await Promise.all([
        h.rt.notifyInboxDetailed("e1"),
        sib.notifyInboxDetailed("e1"),
        h.rt.notifyInboxDetailed("e1"),
        sib.notifyInboxDetailed("e1"),
      ]);
      await tick(20);
      const k = await kinds(h.eventStore, "e1");
      expect(count(k, "MESSAGE_CONSUMED")).toBe(1);
      expect(count(k, "EXECUTION_RESUMED")).toBe(1);
      expect(h.storageErrors.map((e) => (e as Error).message)).toEqual([]);
      // a handle is reported only by the notifier whose append landed (same-runtime calls share one pass)
      const distinct = new Set(rs.filter((r) => r.handle !== undefined).map((r) => r.handle));
      expect(distinct.size).toBe(1);
      expect(rs.every((r) => r.contended === false)).toBe(true);
    }
  });
});

describe("P2-1 — a handle is never reported for an append that did not land", () => {
  it("a store that rejects the batch outright: no handle, the failure is thrown", async () => {
    const inner = new HookedStore();
    let boom = false;
    inner.before = async (batch) => {
      if (boom && batch.includes("MESSAGE_CONSUMED")) throw new Error("disk gone");
    };
    const view = inner;
    const h = build({}, { eventStore: view });
    const f = recv();
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await appendInboxMessage(h.eventStore, "e1", msg("m"), Date.now);
    boom = true;
    await expect(h.rt.notifyInboxDetailed("e1")).rejects.toThrow();
    expect(count(await kinds(inner, "e1"), "MESSAGE_CONSUMED")).toBe(0);
  });
});

describe("P2-2 / decision — a pinned stream warns once, naming the pin", () => {
  it("onWarn at 50% of inboxMaxRetained names the pinning topic and sequence, once", async () => {
    const h = build({ inboxMaxBacklog: 10, inboxMaxRetained: 40 });
    const f = flow("w", async (ctx) => {
      for (;;) unwrapTainted(await ctx.receive("hot"));
    });
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await h.rt.send("e1", { topic: "cold", payload: "c", messageId: "c" });
    for (let i = 0; i < 60; i++) {
      try {
        await h.rt.send("e1", { topic: "hot", payload: i, messageId: `h${i}` });
      } catch {
        break;
      }
      if (i % 5 === 4) await tick(30);
    }
    const pins = h.warnings.filter((w) => w.includes("inboxMaxRetained"));
    expect(pins).toHaveLength(1);
    expect(pins[0]).toContain('topic "cold"');
    expect(pins[0]).toMatch(/inbox sequence 0\b/);
  });
});

describe("P3-1 — INBOX_WAKE_AT does not collide with a real timer at instant 0", () => {
  it("ctx.sleep(0) at clock 0 on a flag-OFF node completes", async () => {
    const h = build({ inboxEnabled: false, now: () => 0 });
    const f = flow("w", async (ctx) => {
      await ctx.sleep(0);
      return "done";
    });
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await new TimerService(h.rt, h.timers).tick(10);
    await until(async () => (await statusOf(h)) === "completed", 3000);
  });

  it("and on a flag-ON node, where the real row at 0 is not mistaken for the inbox row", async () => {
    const h = build({ now: () => 0 });
    const f = flow("w", async (ctx) => {
      await ctx.sleep(0);
      return "done";
    });
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await new TimerService(h.rt, h.timers).tick(10);
    await until(async () => (await statusOf(h)) === "completed", 3000);
  });

  it("the sentinel is below every instant a timed park can carry", () => {
    expect(INBOX_WAKE_AT).toBeLessThan(0);
  });
});

describe("P3-2 — a REFUSED resume of a terminal owner leaves no inbox stream behind", () => {
  it("resume of a completed execution is refused and creates nothing", async () => {
    const h = build({});
    const f = recv();
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await h.rt.send("e1", { topic: "x", payload: "p", messageId: "m" });
    await until(async () => (await statusOf(h)) === "completed", 3000);
    await until(async () => (await h.eventStore.read(inboxStreamId("e1"))).length === 0, 8000);
    expect(await h.eventStore.read(inboxStreamId("e1"))).toEqual([]);
    await expect(
      h.rt.resume("e1", { eventType: "FOO", payload: null }, h.rt.systemOptions())
    ).rejects.toThrow();
    expect(await h.eventStore.read(inboxStreamId("e1"))).toEqual([]);
  });
});

describe("dedupeKeyOf — a known SHA-256 vector (the key is a wire format: stored, compared, never recomputed from a different recipe)", () => {
  it("matches the recipe sha256(JSON([tenant, actor, onBehalfOf, messageId]))", () => {
    expect(dedupeKeyOf({ messageId: "m-1", sender: {} })).toBe(
      "871101e212592a5d24ed0f1cf5ae7ea916ec34d537f587aec9401fa68287ce4d"
    );
    expect(
      dedupeKeyOf({
        messageId: "msg",
        sender: { tenant: "t1", actor: "alice", onBehalfOf: "bob" },
      })
    ).toBe("83bc806d1d51394983fab015e27a8f62f5e78a96d3b44da4f3a3ea988d3f119e");
  });
});
