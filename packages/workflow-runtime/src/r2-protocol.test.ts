import { unwrapTainted } from "@loom/classify";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { LogLifecycle } from "./LogLifecycle";
import { TimerService } from "./TimerService";
import {
  Latch,
  build,
  crashHarness,
  eventsOf,
  flow,
  kinds,
  settle,
  slow,
  tick,
  until,
} from "./__tests__/r2Harness";
import { executionAccessPolicy } from "./executionAccessPolicy";
import { appendInboxMessage, createInboxSource, inboxStreamId } from "./inbox";
import { recoverAbandoned } from "./recoverAbandoned";
import { ExecutionDeniedError } from "./types";

// ADR 0110 D5 — the no-lost-wakeup protocol: every interleaving of a send with the owner's park,
// a crash at every step of the send / wake protocol, and the properties that must hold across them:
// a message is never lost and never delivered twice.

const recv = (topic: string) =>
  flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>(topic)));
const consumed = (store: EventStore, id = "e1") => eventsOf(store, id, "MESSAGE_CONSUMED");
const output = async (h: ReturnType<typeof build>, id = "e1") =>
  (await h.rt.loadState(id, h.rt.systemOptions()))?.variables._output;
const completed = (h: ReturnType<typeof build>, id = "e1") =>
  until(async () => (await h.rt.loadState(id, h.rt.systemOptions()))?.status === "completed");

const stored = (messageId: string, payload: unknown) => ({
  topic: "x",
  messageId,
  payload,
  sender: {},
});

describe("R2 D5 — closures of the lost-wakeup window", () => {
  it("a send landing between the quiescence read and the park commit: the post-park re-read self-resumes", async () => {
    const inner = new InMemoryAsyncEventStore();
    let reads = 0;
    const h = build(
      {
        // closure 1's read: the sender's append lands AFTER it, before the owner's park commits
        inbox: async (chainId, topic, after, limit) => {
          const got = await createInboxSource(inner)(chainId, topic, after, limit);
          if (++reads === 1) {
            await appendInboxMessage(inner, "e1", stored("late", "in the gap"), Date.now);
          }
          return got;
        },
      },
      { eventStore: inner }
    );
    const f = recv("x");
    h.rt.registerFlow(f.definition, f.runner);
    await h.rt.start(f, {}, { executionId: "e1" });
    await completed(h);
    expect(await output(h)).toBe("in the gap");
    expect((await consumed(inner)).length).toBe(1);
    const ks = await kinds(inner, "e1");
    expect(ks.indexOf("EXECUTION_SUSPENDED")).toBeLessThan(ks.indexOf("MESSAGE_CONSUMED"));
  });

  it("a send landing between the park commit and the second read: the second read self-resumes", async () => {
    const inner = new InMemoryAsyncEventStore();
    const view = Object.create(inner) as EventStore;
    let injected = false;
    view.append = async (e) => {
      await inner.append(e);
      if (e.eventType === "EXECUTION_SUSPENDED" && !injected) {
        injected = true; // a sender that saw "running" (no wake) and appended just after the park
        await appendInboxMessage(inner, "e1", stored("gap2", "after the park"), Date.now);
      }
    };
    const h = build({}, { eventStore: view });
    const f = recv("x");
    h.rt.registerFlow(f.definition, f.runner);
    await h.rt.start(f, {}, { executionId: "e1" });
    await completed(h);
    expect(await output(h)).toBe("after the park");
    expect((await consumed(inner)).length).toBe(1);
  });

  it("two notifiers racing one park: exactly one delivery (acquire-if-parked)", async () => {
    const h = build();
    const f = recv("x");
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    const other = h.sibling();
    other.registerFlow(f.definition, f.runner);
    // append directly: no wake of its own, so BOTH notifiers below are the only wakes
    await appendInboxMessage(h.eventStore, "e1", stored("m", "once"), Date.now);
    const [a, b] = await Promise.all([h.rt.notifyInbox("e1"), other.notifyInbox("e1")]);
    await Promise.all([a, b].filter((x) => x !== undefined).map((x) => settle(x!)));
    await completed(h);
    expect((await consumed(h.eventStore)).length).toBeGreaterThanOrEqual(1);
    // however many notifiers ran, the flow saw ONE message and the answer is recorded once
    expect(await output(h)).toBe("once");
    const answers = (await h.rt.loadState("e1"))?.variables._waitAnswers as Record<string, unknown>;
    expect(Object.keys(answers)).toEqual(["#0"]);
    expect((await eventsOf(h.eventStore, "e1", "EXECUTION_RESUMED")).length).toBe(1);
  });

  it("a contended fence leaves the park unanswered and the due-now row in place (retried with backoff)", async () => {
    const inner = new InMemoryAsyncEventStore();
    const view = Object.create(inner) as InMemoryAsyncEventStore;
    let contend = true;
    view.acquireFenceIf = async (id, expectation) => {
      if (contend) await inner.acquireFence(id); // a rival moves the token every attempt
      return inner.acquireFenceIf(id, expectation);
    };
    const h = build({}, { eventStore: view });
    const f = recv("x");
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await appendInboxMessage(inner, "e1", stored("m", "later"), Date.now);
    const before = await kinds(inner, "e1");
    const r = await h.rt.notifyInboxDetailed("e1");
    expect(r).toEqual({ contended: true });
    expect(await kinds(inner, "e1")).toEqual(before); // nothing appended
    expect((await h.timers.due(Date.now())).map((t) => [t.executionId, t.wakeAt])).toEqual([
      ["e1", 0],
    ]);
    contend = false;
    await new TimerService(h.rt, h.timers, { fenced: false }).tick(Date.now() + 10_000);
    await completed(h);
    expect(await output(h)).toBe("later");
  });
});

describe("R2 D5 — crash at every step of the send / wake protocol", () => {
  /** A booted owner on a crashing store; `reboot()` is a fresh process over the survivor. */
  async function owner(
    dropFrom: Parameters<typeof crashHarness>[0],
    f = recv("x"),
    opts: { atomicBatch?: boolean } = {}
  ) {
    const c = crashHarness(dropFrom, opts);
    c.h.rt.registerFlow(f.definition, f.runner);
    await (await c.h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    const reboot = async () => {
      const rt2 = await c.reboot();
      rt2.registerFlow(f.definition, f.runner);
      return rt2;
    };
    // `h.rt` is the owner process; `h.timers` the surviving timer rows
    return {
      inner: c.inner,
      crash: c.crash,
      h: { ...c.h, timers: c.timers },
      reboot,
      f,
      sender: c.process(),
    };
  }

  it("after MESSAGE_CONSUMED, before the resume: the surviving due-now row heals it with ONE delivery", async () => {
    const o = await owner((e) => e.eventType === "EXECUTION_RESUMED");
    await o.h.rt.send("e1", { topic: "x", payload: "survives", messageId: "m1" });
    await until(() => o.crash.crashed);
    const ks = await kinds(o.inner, "e1");
    expect(ks).toContain("MESSAGE_CONSUMED");
    expect(ks).not.toContain("EXECUTION_RESUMED"); // parked, answer journaled, wake lost
    const rt2 = await o.reboot();
    await new TimerService(rt2, o.h.timers).tick(Date.now() + 1);
    await until(async () => (await rt2.loadState("e1"))?.status === "completed");
    expect((await rt2.loadState("e1"))?.variables._output).toBe("survives");
    expect((await consumed(o.inner)).length).toBe(1); // not consumed twice
    expect((await eventsOf(o.inner, "e1", "EXECUTION_RESUMED")).length).toBe(1);
    expect(await o.h.timers.due(Date.now() + 1e9)).toEqual([]);
  });

  it("the pair is ONE atomic write: a crash before it lands leaves the park untouched, and the row redelivers", async () => {
    const o = await owner((e) => e.eventType === "EXECUTION_RESUMED", recv("x"), {
      atomicBatch: true,
    });
    await o.h.rt.send("e1", { topic: "x", payload: "atomic", messageId: "m1" });
    await until(() => o.crash.crashed);
    const ks = await kinds(o.inner, "e1");
    expect(ks).not.toContain("MESSAGE_CONSUMED"); // neither half landed
    expect(ks).not.toContain("EXECUTION_RESUMED");
    const rt2 = await o.reboot();
    await new TimerService(rt2, o.h.timers).tick(Date.now() + 1);
    await until(async () => (await rt2.loadState("e1"))?.status === "completed");
    expect((await rt2.loadState("e1"))?.variables._output).toBe("atomic");
    expect((await consumed(o.inner)).length).toBe(1);
  });

  it("after the send's append, before any wake (no row, no fast path): recoverAbandoned's pass notifies", async () => {
    const o = await owner(() => false);
    // the sender died right after its append: no row was written, nothing was notified
    await appendInboxMessage(o.inner, "e1", stored("m1", "recovered"), Date.now);
    expect((await o.h.rt.loadState("e1"))?.status).toBe("suspended");
    expect(await o.h.timers.due(Date.now() + 1e9)).toEqual([]);
    const summary = await recoverAbandoned(o.h.rt, {
      source: o.inner,
      isAbandoned: () => false,
    });
    expect(summary.inboxWoken).toBe(1);
    await until(async () => (await o.h.rt.loadState("e1"))?.status === "completed");
    expect(await output(o.h)).toBe("recovered");
    expect((await consumed(o.inner)).length).toBe(1);
  });

  it("owner dies between the inbox append and the live MESSAGE_CONSUMED: recovery re-reads, once", async () => {
    const latch = new Latch();
    const c = crashHarness((e) => e.eventType === "MESSAGE_CONSUMED", { latch });
    const f = flow("w", async (ctx) => {
      await ctx.run(slow, {});
      return unwrapTainted(await ctx.receive<string>("x"));
    });
    c.h.rt.registerFlow(f.definition, f.runner);
    await c.h.rt.start(f, {}, { executionId: "e1" });
    await tick(20);
    await c.process().send("e1", { topic: "x", payload: "again", messageId: "m1" }); // appended to the stream
    latch.release();
    await until(() => c.crash.crashed); // the owner's consumption never became durable
    expect(await kinds(c.inner, "e1")).not.toContain("MESSAGE_CONSUMED");
    const rt2 = await c.reboot();
    rt2.registerFlow(f.definition, f.runner);
    const summary = await recoverAbandoned(rt2, { source: c.inner, isAbandoned: () => true });
    expect(summary.recovered).toBe(1);
    await until(async () => (await rt2.loadState("e1"))?.status === "completed");
    expect((await rt2.loadState("e1"))?.variables._output).toBe("again");
    expect((await consumed(c.inner)).length).toBe(1);
  });

  it("a duplicate send around a crash is still consumed once", async () => {
    const o = await owner((e) => e.eventType === "EXECUTION_RESUMED");
    await o.h.rt.send("e1", { topic: "x", payload: "v", messageId: "same" });
    await until(() => o.crash.crashed);
    // the sender never saw an ack and retries after the crash
    const rt2 = await o.reboot();
    await rt2.send("e1", { topic: "x", payload: "v", messageId: "same" });
    await new TimerService(rt2, o.h.timers).tick(Date.now() + 1);
    await until(async () => (await rt2.loadState("e1"))?.status === "completed");
    expect((await rt2.loadState("e1"))?.variables._output).toBe("v");
    const answers = (await rt2.loadState("e1"))?.variables._waitAnswers as Record<string, unknown>;
    expect(Object.keys(answers)).toEqual(["#0"]);
  });
});

describe("R2 D1 — the stream is bounded and cheap", () => {
  const spy = (inner: InMemoryAsyncEventStore) => {
    const calls = { read: 0, readFrom: 0, head: 0, append: 0 };
    const view = Object.create(inner) as InMemoryAsyncEventStore;
    const reserved = (id: string) => id.startsWith("__loom_inbox__");
    view.read = async (id) => {
      if (reserved(id)) calls.read++;
      return inner.read(id);
    };
    view.readFrom = async (id, from) => {
      if (reserved(id)) calls.readFrom++;
      return inner.readFrom(id, from);
    };
    view.head = async (id) => {
      if (reserved(id)) calls.head++;
      return inner.head(id);
    };
    view.append = async (e) => {
      if (reserved(e.executionId)) calls.append++;
      return inner.append(e);
    };
    return { view, calls };
  };

  it("send cost does not grow with the stream: one head() and one append, never a log read", async () => {
    const inner = new InMemoryAsyncEventStore();
    const { view, calls } = spy(inner);
    const h = build({}, { eventStore: view });
    const f = recv("never");
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await tick(40); // the park's own post-commit re-read has finished
    const base = { ...calls };
    const perSend: number[] = [];
    for (const burst of [10, 400, 400]) {
      for (let i = 0; i < burst; i++) {
        const before = { ...calls };
        await h.rt.send("e1", { topic: "other", payload: i });
        perSend.push(
          calls.read -
            before.read +
            (calls.readFrom - before.readFrom) +
            (calls.head - before.head) * 100
        );
      }
    }
    // every send, at 10 or 810 messages in the stream: head() twice (room check + allocation), no scan
    expect(new Set(perSend)).toEqual(new Set([200]));
    expect(calls.read - base.read).toBe(0);
    expect(calls.readFrom - base.readFrom).toBe(0);
  });

  it("send to a RUNNING owner never folds its log: no snapshot load, no owner-stream read", async () => {
    const latch = new Latch();
    const inner = new InMemoryAsyncEventStore();
    const view = Object.create(inner) as InMemoryAsyncEventStore;
    let ownerReads = 0;
    view.read = async (id) => {
      if (id === "e1") ownerReads++;
      return inner.read(id);
    };
    view.readFrom = async (id, from) => {
      if (id === "e1") ownerReads++;
      return inner.readFrom(id, from);
    };
    const h = build({}, { eventStore: view, latch });
    let snapshotLoads = 0;
    const loadLatest = h.snapshotStore.loadLatest.bind(h.snapshotStore);
    h.snapshotStore.loadLatest = async (id) => {
      snapshotLoads++;
      return loadLatest(id);
    };
    const f = flow("w", async (ctx) => {
      await ctx.run(slow, {}); // the owner is mid-step: its tip is a step event, not a park
      return unwrapTainted(await ctx.receive<number>("x"));
    });
    h.rt.registerFlow(f.definition, f.runner);
    await h.rt.start(f, {}, { executionId: "e1" });
    await tick(20);
    const before = { ownerReads, snapshotLoads };
    for (let i = 0; i < 40; i++) await h.rt.send("e1", { topic: "x", payload: i });
    expect(ownerReads - before.ownerReads).toBe(0);
    expect(snapshotLoads - before.snapshotLoads).toBe(0);
    latch.release();
    await completed(h);
    expect(await output(h)).toBe(0); // FIFO: the first message
  });

  it("trim deletes the consumed prefix below the OLDEST UNCONSUMED message and never the head", async () => {
    const inner = new InMemoryAsyncEventStore();
    const h = build({}, { eventStore: inner });
    const f = flow("w", async (ctx) => {
      const got: string[] = [];
      for (let i = 0; i < 3; i++) got.push(unwrapTainted(await ctx.receive<string>("a")));
      return got;
    });
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    // a1(0) a2(1) b1(2) a3(3): topic "b" is never waited on, so b1 stays unconsumed
    for (const [topic, p] of [
      ["a", "a1"],
      ["a", "a2"],
      ["b", "b1"],
      ["a", "a3"],
    ] as const) {
      await appendInboxMessage(
        inner,
        "e1",
        { topic, messageId: p, payload: p, sender: {} },
        Date.now
      );
    }
    await h.rt.notifyInbox("e1").then((x) => x && settle(x));
    await completed(h);
    await tick(30); // the trim runs after the completion's drain
    const left = (await inner.read(inboxStreamId("e1"))).map((e) => e.sequence);
    expect(left).toContain(2); // the unconsumed b1 survives
    expect(left).toContain(3); // the head is never truncated (monotonic head + 1 allocation)
    expect(left).not.toContain(1); // the consumed prefix is gone (sequence 0 is the store's anchor)
    expect((await h.rt.loadState("e1"))?.variables._output).toEqual(["a1", "a2", "a3"]);
  });

  it("the stream is deleted with its chain when retention reclaims the head", async () => {
    const h = build();
    const f = recv("x");
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await h.rt.send("e1", { topic: "x", payload: "bye" });
    await completed(h);
    await tick(30);
    expect((await h.eventStore.read(inboxStreamId("e1"))).length).toBeGreaterThan(0);
    const life = new LogLifecycle(h.eventStore, h.snapshotStore);
    expect(await life.applyRetention("e1", { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
      "reclaimed"
    );
    expect(await h.eventStore.read(inboxStreamId("e1"))).toEqual([]);
  });

  it("a fork leaves the chain: it has its own empty inbox and never reads the owner's", async () => {
    const h = build();
    const f = recv("x");
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    const fork = await h.rt.fork("e1", (await h.rt.loadState("e1"))!.sequence);
    await h.rt.send("e1", { topic: "x", payload: "owner-only" });
    await completed(h);
    // the fork copied the park; its inbox is a different (empty) stream
    const forked = await h.rt.notifyInbox(fork.executionId);
    expect(forked).toBeUndefined();
    expect((await h.eventStore.read(inboxStreamId(fork.executionId))).length).toBe(0);
    expect(await kinds(h.eventStore, fork.executionId)).not.toContain("MESSAGE_CONSUMED");
    expect((await h.rt.loadState(fork.executionId))?.status).toBe("suspended");
  });
});

describe("R2 D1 — send is authorized against the owner of the chain's head", () => {
  const alice = { actor: "alice", tenant: "t1" };
  const mallory = { actor: "mallory", tenant: "t2" };
  async function strict() {
    const h = build({
      executionAuthorizer: executionAccessPolicy(),
      executionAuthz: { requirePrincipal: true },
    });
    const f = recv("x");
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1", principal: alice })).waitForSuspend();
    return h;
  }

  it("an unauthorized sender is refused (strict) and nothing is appended anywhere", async () => {
    const h = await strict();
    const before = await kinds(h.eventStore, "e1");
    for (const principal of [undefined, mallory]) {
      await expect(
        h.rt.send("e1", { topic: "x", payload: "inject" }, principal && { principal })
      ).rejects.toBeInstanceOf(ExecutionDeniedError);
    }
    expect(await kinds(h.eventStore, "e1")).toEqual(before); // no EXECUTION_DENIED in the owner's log
    expect(await h.eventStore.read(inboxStreamId("e1"))).toEqual([]);
    expect(await h.timers.due(Date.now() + 1e9)).toEqual([]);
  });

  it("existence is not an oracle for an anonymous sender under strict", async () => {
    const h = await strict();
    await expect(h.rt.send("ghost", { topic: "x", payload: 1 })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
  });

  it("a same-tenant sender is accepted, recorded, and the effects keep running as the OWNER", async () => {
    const h = await strict();
    await h.rt.send(
      "e1",
      { topic: "x", payload: "ok" },
      { principal: { actor: "bob", tenant: "t1" } }
    );
    await completed(h);
    const [c] = await consumed(h.eventStore);
    expect((c?.payload as { sender: unknown }).sender).toEqual({ actor: "bob", tenant: "t1" });
    expect(await output(h)).toBe("ok");
  });

  it("the kernel's own callers present the system grant", async () => {
    const h = await strict();
    await h.rt.send("e1", { topic: "x", payload: "sys" }, h.rt.systemOptions());
    await completed(h);
    expect(await output(h)).toBe("sys");
  });

  it("the authorizer is told the op: send", async () => {
    const ops: string[] = [];
    const h = build({
      executionAuthorizer: {
        authorize: (r) => {
          ops.push(r.op);
          return { allowed: true };
        },
      },
    });
    const f = recv("x");
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1", principal: alice })).waitForSuspend();
    await h.rt.send("e1", { topic: "x", payload: 1 }, { principal: alice });
    expect(ops).toContain("send");
  });
});
