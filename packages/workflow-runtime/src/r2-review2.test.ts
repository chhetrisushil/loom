import { unwrapTainted } from "@loom/classify";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import { Latch, build, eventsOf, flow, kinds, slow, tick, until } from "./__tests__/r2Harness";
import { appendInboxMessage, dedupeKeyOf, inboxStreamId } from "./inbox";
import { recoverAbandoned } from "./recoverAbandoned";
import { InboxClosedError, InboxFullError } from "./types";

// ADR 0110 (R2) — the second review's findings, each as a regression test.

const statusOf = async (h: ReturnType<typeof build>, id = "e1") =>
  (await h.rt.loadState(id, h.rt.systemOptions()))?.status;
const completed = (h: ReturnType<typeof build>, id = "e1") =>
  until(async () => (await statusOf(h, id)) === "completed", 8000);
const stored = (messageId: string, payload: unknown, topic = "x") => ({
  topic,
  messageId,
  payload,
  sender: {},
});

describe("P1 — a window with no answering kind is AMBIGUOUS, never 'running' (lost wakeup)", () => {
  for (const dups of [12, 50]) {
    it(`${dups} duplicate-only MESSAGE_CONSUMED above a park, then a new message: the owner wakes`, async () => {
      const h = build({});
      const f = flow("w", async (ctx) => {
        const a = unwrapTainted(await ctx.receive<string>("x"));
        const b = unwrapTainted(await ctx.receive<string>("x"));
        return [a, b];
      });
      h.rt.registerFlow(f.definition, f.runner);
      const handle = await h.rt.start(f, {}, { executionId: "e1" });
      await handle.waitForSuspend();
      await h.rt.send("e1", { topic: "x", payload: "A", messageId: "A" });
      await until(
        async () => (await eventsOf(h.eventStore, "e1", "MESSAGE_CONSUMED")).length === 1
      );
      await tick(50);
      for (let i = 0; i < dups; i++) {
        await h.rt.send("e1", { topic: "x", payload: "A", messageId: "A" });
        await until(
          async () => (await eventsOf(h.eventStore, "e1", "MESSAGE_CONSUMED")).length === i + 2
        );
      }
      // The tail is now `dups` ignorable events above the park; a stale due-now row is gone.
      await h.timers.complete("e1", 0);
      await h.rt.send("e1", { topic: "x", payload: "B", messageId: "B" });
      await completed(h);
      expect((await h.rt.loadState("e1", h.rt.systemOptions()))?.variables._output).toEqual([
        "A",
        "B",
      ]);
    });
  }
});

describe("P2-A — a delivered message is never reported as refused", () => {
  const slowOwner = () => {
    const inner = new InMemoryAsyncEventStore();
    const view = Object.create(inner) as EventStore;
    const hook: { after?: () => Promise<void> } = {};
    view.append = async (e) => {
      const r = await inner.append(e);
      if (e.executionId.startsWith("__loom_inbox__") && hook.after) await hook.after();
      return r;
    };
    return { inner, view, hook };
  };

  it("consumed, then the owner completes before the sender's re-read: a normal SendResult", async () => {
    const { view, hook } = slowOwner();
    const latch = new Latch();
    const h = build({}, { eventStore: view, latch });
    const f = flow("w", async (ctx) => {
      await ctx.run(slow, {});
      return unwrapTainted(await ctx.receive<string>("x"));
    });
    h.rt.registerFlow(f.definition, f.runner);
    await h.rt.start(f, {}, { executionId: "e1" });
    await tick(20);
    hook.after = async () => {
      latch.release();
      await until(async () => (await statusOf(h)) === "completed", 8000);
    };
    const res = await h.rt.send("e1", { topic: "x", payload: "hello" });
    expect(res.inboxSeq).toBe(0);
    expect((await h.rt.loadState("e1", h.rt.systemOptions()))?.variables._output).toBe("hello");
  });

  it("finished WITHOUT consuming it: refused with a truthful message, and the stream is gone", async () => {
    const { view, hook, inner } = slowOwner();
    const latch = new Latch();
    const h = build({}, { eventStore: view, latch });
    const f = flow("w", async (ctx) => {
      await ctx.run(slow, {});
      return "done";
    });
    h.rt.registerFlow(f.definition, f.runner);
    await h.rt.start(f, {}, { executionId: "e1" });
    await tick(20);
    hook.after = async () => {
      latch.release();
      await until(async () => (await statusOf(h)) === "completed", 8000);
    };
    const err = await h.rt.send("e1", { topic: "x", payload: "hello" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InboxClosedError);
    const msg = (err as InboxClosedError).message;
    expect((err as InboxClosedError).discarded).toBe(true);
    expect(msg).not.toMatch(/Nothing was appended/);
    expect(msg).toMatch(/appended and then discarded/);
    expect(await inner.read(inboxStreamId("e1"))).toEqual([]);
  });

  it("refused BEFORE the append (already terminal): says nothing was appended", async () => {
    const h = build({});
    const f = flow("w", async () => "done");
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForCompletion();
    const err = await h.rt.send("e1", { topic: "x", payload: 1 }).catch((e: unknown) => e);
    expect((err as InboxClosedError).discarded).toBe(false);
    expect((err as Error).message).toMatch(/Nothing was appended/);
  });
});

describe("P2-B — backlog accounting is amortized O(1); a pinned stream is bounded", () => {
  it("one cold message + hot traffic: scans stay rare, and storage is refused past inboxMaxRetained", async () => {
    const inner = new InMemoryAsyncEventStore();
    const view = Object.create(inner) as EventStore;
    let inboxReads = 0;
    view.readRange = async (id, from, to) => {
      // a COUNT scan starts at the floor (here sequence 0); the owner's own reads start past its cursor
      if (id.startsWith("__loom_inbox__") && from <= 0) inboxReads++;
      return inner.readRange!(id, from, to);
    };
    const h = build({ inboxMaxBacklog: 100 }, { eventStore: view });
    const f = flow("w", async (ctx) => {
      for (;;) unwrapTainted(await ctx.receive<number>("hot"));
    });
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await h.rt.send("e1", { topic: "cold", payload: "c", messageId: "c" });
    let refusedAt: number | undefined;
    let refusal: unknown;
    let sent = 0;
    // inboxMaxRetained defaults to 4 x 100: the pin must refuse by ~400, not grow forever
    for (let i = 0; i < 600; i++) {
      try {
        await h.rt.send("e1", { topic: "hot", payload: i, messageId: `h${i}` });
        sent++;
      } catch (e) {
        refusedAt = i;
        refusal = e;
        break;
      }
      if (i % 20 === 19) await tick(15);
    }
    expect(refusal).toBeInstanceOf(InboxFullError);
    expect((refusal as Error).message).toMatch(/pins every entry above it/);
    expect(refusedAt).toBeGreaterThan(300);
    expect(refusedAt).toBeLessThanOrEqual(405);
    expect(sent).toBe(refusedAt);
    // ~300 sends were over the cheap bound; the old code scanned on EVERY one of them. Amortized,
    // a handful of counts (plus the owner's own reads) cover the whole run.
    expect(inboxReads).toBeLessThan(60);
    // The pin is released when its message is consumed: the stream is writable again.
    await h.rt.send("e1", { topic: "cold", payload: "c2", messageId: "c2" }).catch(() => undefined);
  }, 30_000);
});

describe("P3-1 — a flag-off TimerService is not starved by inbox rows", () => {
  it("more due inbox rows than the batch limit, and a real timer still fires", async () => {
    const timers = new InMemoryTimerStore();
    const h = build({ inboxEnabled: false }, { timers });
    const f = flow("w", async (ctx) => {
      await ctx.sleepUntil(Date.now() + 5);
      return "woke";
    });
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    for (let i = 0; i < 6; i++) await timers.schedule({ executionId: `ghost${i}`, wakeAt: -1 });
    const svc = new TimerService(h.rt, timers, { batch: 3 });
    await tick(20);
    await svc.tick(Date.now() + 1000);
    await until(async () => (await statusOf(h)) === "completed", 5000);
    // the inbox rows were left for a node that can run them
    expect((await timers.due(1000)).filter((t) => t.wakeAt === -1).length).toBe(6);
  });
});

describe("P3-2 — the dedupe key is bounded and opaque", () => {
  it("a huge principal hashes to a fixed-size, deterministic, sender-distinct key", () => {
    const big = "a".repeat(20_000);
    const k1 = dedupeKeyOf({ messageId: "m", sender: { actor: big } });
    const k2 = dedupeKeyOf({ messageId: "m", sender: { actor: big } });
    const k3 = dedupeKeyOf({ messageId: "m", sender: { actor: `${big}b` } });
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(k3).not.toBe(k1);
    expect(dedupeKeyOf({ messageId: "m", sender: {} })).not.toBe(
      dedupeKeyOf({ messageId: "m2", sender: {} })
    );
  });

  it("a send under a huge principal journals a 64-character messageId", async () => {
    const h = build({});
    const f = flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>("x")));
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await h.rt.send(
      "e1",
      { topic: "x", payload: "p", messageId: "m" },
      { principal: { actor: "z".repeat(20_000) } as never }
    );
    await completed(h);
    const [mc] = await eventsOf(h.eventStore, "e1", "MESSAGE_CONSUMED");
    expect((mc?.payload as { messageId: string }).messageId).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("P3-4 — a very long run of duplicates is journaled in chunks", () => {
  for (const withReal of [true, false]) {
    for (const n of [2100, 2600]) {
      it(`n=${n}, ${withReal ? "with" : "without"} a real message`, async () => {
        const h = build();
        const g = flow("w", async (ctx) => {
          const a = unwrapTainted(await ctx.receive<string>("x"));
          const b = unwrapTainted(await ctx.receive<string>("x"));
          return [a, b];
        });
        h.rt.registerFlow(g.definition, g.runner);
        await (await h.rt.start(g, {}, { executionId: "e1" })).waitForSuspend();
        await h.rt.send("e1", { topic: "x", payload: "first", messageId: "d" });
        await until(
          async () => (await eventsOf(h.eventStore, "e1", "MESSAGE_CONSUMED")).length === 1
        );
        await tick(50);
        for (let i = 0; i < n; i++)
          await appendInboxMessage(h.eventStore, "e1", stored("d", "dup"), Date.now);
        if (withReal) await appendInboxMessage(h.eventStore, "e1", stored("r", "real"), Date.now);
        const svc = new TimerService(h.rt, h.timers);
        await h.rt.notifyInboxDetailed("e1");
        for (let i = 0; i < 3; i++) await svc.tick(Date.now() + 1);
        const state = await h.rt.loadState("e1", h.rt.systemOptions());
        const consumed = await eventsOf(h.eventStore, "e1", "MESSAGE_CONSUMED");
        expect(h.storageErrors).toEqual([]);
        // every duplicate is journaled once, in more than one atomic chunk
        expect(consumed.length).toBe(1 + n + (withReal ? 1 : 0));
        expect(state?.status).toBe(withReal ? "completed" : "suspended");
        const cursors = (state?.variables._inbox as { cursors: Record<string, number> }).cursors;
        expect(cursors.x).toBe(n + (withReal ? 1 : 0));
        if (withReal) expect(state?.variables._output).toEqual(["first", "real"]);
      }, 60_000);
    }
  }
});

describe("P3-6 — an inbox stream orphaned by a terminal owner is reclaimed", () => {
  it("a sender that appended after the owner's delete and died: the sweep deletes the stream", async () => {
    const h = build({});
    const f = flow("w", async () => "done");
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForCompletion();
    await appendInboxMessage(h.eventStore, "e1", stored("m", "orphan"), Date.now);
    expect((await h.eventStore.read(inboxStreamId("e1"))).length).toBe(1);
    const summary = await recoverAbandoned(h.rt, {
      source: h.eventStore as never,
      isAbandoned: () => true,
    });
    expect(summary.inboxReclaimed).toBe(1);
    expect(await h.eventStore.read(inboxStreamId("e1"))).toEqual([]);
  });

  it("a LIVE owner's inbox is left alone", async () => {
    const h = build({});
    const f = flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>("x")));
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await appendInboxMessage(h.eventStore, "e1", stored("m", "keep", "other"), Date.now);
    const summary = await recoverAbandoned(h.rt, {
      source: h.eventStore as never,
      isAbandoned: () => false,
    });
    expect(summary.inboxReclaimed).toBeUndefined();
    expect((await h.eventStore.read(inboxStreamId("e1"))).length).toBe(1);
  });
});

describe("P3-7 — a terminal execution RE-OPENED (resumeAs / resume) keeps receiving", () => {
  it("resumeAs onto a failed execution: sends land above the inherited cursors and are delivered", async () => {
    const h = build({});
    let fixed = false;
    const f = flow("w", async (ctx) => {
      const a = unwrapTainted(await ctx.receive<string>("x"));
      if (!fixed) throw new Error("boom");
      const b = unwrapTainted(await ctx.receive<string>("x"));
      return [a, b];
    });
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await h.rt.send("e1", { topic: "x", payload: "A", messageId: "A" });
    await until(async () => (await statusOf(h)) === "failed");
    // terminal stays terminal for SENDERS
    const closed = await h.rt.send("e1", { topic: "x", payload: "late" }).catch((e: unknown) => e);
    expect(closed).toBeInstanceOf(InboxClosedError);
    fixed = true;
    const reopened = await h.rt.resumeAs("e1", "w", { eventType: "Retry", payload: null }, {
      strategy: "operator-ack",
      system: true,
    } as never);
    await reopened.waitForSuspend();
    expect(await statusOf(h)).toBe("suspended");
    const res = await h.rt.send("e1", { topic: "x", payload: "B", messageId: "B" });
    expect(res.inboxSeq).toBeGreaterThan(0); // not restarted at 0 under the cursor
    await completed(h);
    expect((await h.rt.loadState("e1", h.rt.systemOptions()))?.variables._output).toEqual([
      "A",
      "B",
    ]);
    expect(await kinds(h.eventStore, "e1")).toContain("EXECUTION_MIGRATED");
  });
});

describe("an inbox delivery does not push an unfenced execution into fencing", () => {
  it("a plain gate resume after a notify-path delivery is not refused as a stale fence", async () => {
    const h = build({});
    const f = flow("w", async (ctx) => {
      const a = unwrapTainted(await ctx.receive<string>("x"));
      const r = await ctx.select([{ gate: "G" }]);
      return [a, r.value];
    });
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await h.rt.send("e1", { topic: "x", payload: "A", messageId: "A" });
    await until(async () => (await eventsOf(h.eventStore, "e1", "MESSAGE_CONSUMED")).length === 1);
    await until(
      async () =>
        (await kinds(h.eventStore, "e1")).at(-1) === "EXECUTION_SUSPENDED" &&
        (await kinds(h.eventStore, "e1")).length === 5
    );
    const resumed = await h.rt.resume("e1", { eventType: "G", payload: "ok" }, {
      system: true,
    } as never);
    await resumed.waitForCompletion();
    expect(await statusOf(h)).toBe("completed");
  });
});
