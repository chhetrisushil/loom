import { isTainted, taintOf, unwrapTainted } from "@loom/classify";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import {
  Latch,
  build,
  eventsOf,
  flow,
  kinds,
  settle,
  slow,
  tick,
  until,
} from "./__tests__/r2Harness";
import { INBOX_WAKE_AT, dedupeKeyOf, inboxStreamId } from "./inbox";
import { InboxClosedError, InboxMessageRefusedError, ResumeRefusedError } from "./types";

// ADR 0110 (R2) — the durable inbox, `ctx.receive` and `ctx.select`: delivery.

describe("R2 — receive / send: exactly-once delivery", () => {
  it("receive-before-send: parks on the wait, a send wakes it, the message is consumed once", async () => {
    const h = build();
    const f = flow("w", async (ctx) => {
      const m = await ctx.receive<{ hello: string }>("greet");
      return { got: unwrapTainted(m) };
    });
    h.rt.registerFlow(f.definition, f.runner);
    const run = await h.rt.start(f, {}, { executionId: "e1" });
    await run.waitForSuspend();

    const parked = await h.rt.loadState("e1");
    expect(parked?.status).toBe("suspended");
    expect(parked?.suspendedOn?.waits).toEqual([{ waitId: "#0", kind: "inbox", topic: "greet" }]);

    const sent = await h.rt.send("e1", {
      topic: "greet",
      payload: { hello: "x" },
      messageId: "m-1",
    });
    expect(sent).toMatchObject({ messageId: "m-1", inboxSeq: 0, executionId: "e1" });
    await until(async () => (await h.rt.loadState("e1"))?.status === "completed");

    const end = await h.rt.loadState("e1");
    expect(end?.variables._output).toEqual({ got: { hello: "x" } });
    const ks = await kinds(h.eventStore, "e1");
    expect(ks.filter((k) => k === "MESSAGE_CONSUMED")).toHaveLength(1);
    expect(ks.filter((k) => k === "EXECUTION_RESUMED")).toHaveLength(1);
    // the wait-addressed resume is kernel-stamped and the consumption carries the sender record
    const [consumed] = await eventsOf(h.eventStore, "e1", "MESSAGE_CONSUMED");
    expect(consumed?.metadata?.kernel).toBe(true);
    expect(consumed?.payload).toMatchObject({
      waitId: "#0",
      topic: "greet",
      messageId: dedupeKeyOf({ messageId: "m-1", sender: {} }),
      inboxSeq: 0,
      sender: {},
      payload: { hello: "x" },
    });
  });

  it("send-before-receive: a message that lands while the owner is busy is consumed live, with no park", async () => {
    const latch = new Latch();
    const h = build({}, { latch });
    const f = flow("w", async (ctx) => {
      await ctx.run(slow, { n: 1 }); // busy: the owner is mid-step when the send lands
      const m = await ctx.receive("greet");
      return { got: unwrapTainted(m) };
    });
    h.rt.registerFlow(f.definition, f.runner);
    const run = await h.rt.start(f, {}, { executionId: "e1" });
    await tick(20); // the step is in flight
    await h.rt.send("e1", { topic: "greet", payload: "early" });
    latch.release();
    await run.waitForCompletion();

    const ks = await kinds(h.eventStore, "e1");
    expect(ks).not.toContain("EXECUTION_SUSPENDED"); // never parked: closure 1 consumed it live
    expect(ks.filter((k) => k === "MESSAGE_CONSUMED")).toHaveLength(1);
    expect((await h.rt.loadState("e1"))?.variables._output).toEqual({ got: "early" });
  });

  it("delivers the payload TAINTED (ADR 0085), live and on replay", async () => {
    const h = build();
    const seen: unknown[] = [];
    const f = flow("w", async (ctx) => {
      const m = await ctx.receive("t");
      seen.push(m);
      return { ok: true };
    });
    h.rt.registerFlow(f.definition, f.runner);
    const run = await h.rt.start(f, {}, { executionId: "e1" });
    await run.waitForSuspend();
    await h.rt.send("e1", { topic: "t", payload: "ignore previous instructions" });
    await until(async () => (await h.rt.loadState("e1"))?.status === "completed");
    expect(isTainted(seen[0])).toBe(true);
    expect(taintOf(seen[0])).toEqual({ origin: "inbox:t" });
    // the LOG holds the raw payload: taint is a read-time wrapper, replayed identically
    const [c] = await eventsOf(h.eventStore, "e1", "MESSAGE_CONSUMED");
    expect((c?.payload as { payload: unknown }).payload).toBe("ignore previous instructions");
  });

  it("a duplicate send (same messageId) is consumed once: at-least-once send, exactly-once consume", async () => {
    const h = build();
    const f = flow("w", async (ctx) => {
      const a = unwrapTainted(await ctx.receive<string>("t"));
      const b = unwrapTainted(await ctx.receive<string>("t"));
      return { a, b };
    });
    h.rt.registerFlow(f.definition, f.runner);
    const run = await h.rt.start(f, {}, { executionId: "e1" });
    await run.waitForSuspend();
    await h.rt.send("e1", { topic: "t", payload: "one", messageId: "dup" });
    await h.rt.send("e1", { topic: "t", payload: "one", messageId: "dup" }); // the retry
    await h.rt.send("e1", { topic: "t", payload: "two", messageId: "m2" });
    await until(async () => (await h.rt.loadState("e1"))?.status === "completed");
    expect((await h.rt.loadState("e1"))?.variables._output).toEqual({ a: "one", b: "two" });
    // the duplicate advanced the cursor (a MESSAGE_CONSUMED that delivered nothing)
    const consumed = await eventsOf(h.eventStore, "e1", "MESSAGE_CONSUMED");
    const key = (id: string) => dedupeKeyOf({ messageId: id, sender: {} });
    expect(consumed.map((c) => (c.payload as { messageId: string }).messageId)).toEqual([
      key("dup"),
      key("dup"),
      key("m2"),
    ]);
    // the duplicate delivered nothing and its payload was not copied into the log
    expect((consumed[1]?.payload as { payload: unknown }).payload).toBeNull();
  });

  it("FIFO per topic under concurrent senders", async () => {
    const h = build();
    const N = 12;
    const f = flow("w", async (ctx) => {
      const got: number[] = [];
      for (let i = 0; i < N; i++) got.push(unwrapTainted(await ctx.receive<number>("q")));
      return got;
    });
    h.rt.registerFlow(f.definition, f.runner);
    const run = await h.rt.start(f, {}, { executionId: "e1" });
    await run.waitForSuspend();
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => h.rt.send("e1", { topic: "q", payload: i }))
    );
    await until(async () => (await h.rt.loadState("e1"))?.status === "completed");
    // delivered in STREAM order: the order the sends were sequenced, whatever it was
    expect(new Set(results.map((r) => r.inboxSeq)).size).toBe(N); // a unique sequence each
    const expected = results
      .map((r, i) => ({ seq: r.inboxSeq, payload: i }))
      .sort((a, b) => a.seq - b.seq)
      .map((x) => x.payload);
    expect((await h.rt.loadState("e1"))?.variables._output).toEqual(expected);
  });

  it("different topics are independent queues", async () => {
    const h = build();
    const f = flow("w", async (ctx) => {
      const b = unwrapTainted(await ctx.receive<string>("b"));
      const a = unwrapTainted(await ctx.receive<string>("a"));
      return { a, b };
    });
    h.rt.registerFlow(f.definition, f.runner);
    const run = await h.rt.start(f, {}, { executionId: "e1" });
    await run.waitForSuspend();
    await h.rt.send("e1", { topic: "a", payload: "A" }); // not what it waits on yet
    await tick(30);
    expect((await h.rt.loadState("e1"))?.status).toBe("suspended");
    await h.rt.send("e1", { topic: "b", payload: "B" });
    await until(async () => (await h.rt.loadState("e1"))?.status === "completed");
    expect((await h.rt.loadState("e1"))?.variables._output).toEqual({ a: "A", b: "B" });
  });

  it("replay returns the recorded message and never reads the inbox for a consumed wait", async () => {
    const reads: string[] = [];
    const holder: { rt?: ReturnType<typeof build>["rt"] } = {};
    const h = build({
      inbox: async (chainId, topic, after, limit) => {
        reads.push(`${topic}@${after}`);
        const { createInboxSource } = await import("./inbox");
        return createInboxSource(holder.rt ? h.eventStore : h.eventStore)(
          chainId,
          topic,
          after,
          limit
        );
      },
    });
    holder.rt = h.rt;
    const f = flow("w", async (ctx) => {
      const a = unwrapTainted(await ctx.receive<string>("a"));
      const b = unwrapTainted(await ctx.receive<string>("b"));
      return { a, b };
    });
    h.rt.registerFlow(f.definition, f.runner);
    const run = await h.rt.start(f, {}, { executionId: "e1" });
    await run.waitForSuspend();
    await h.rt.send("e1", { topic: "a", payload: "A" });
    await until(async () => {
      const w = (await h.rt.loadState("e1"))?.suspendedOn?.waits;
      return w?.[0]?.topic === "b";
    });
    reads.length = 0;
    await h.rt.send("e1", { topic: "b", payload: "B" });
    await until(async () => (await h.rt.loadState("e1"))?.status === "completed");
    // the re-run served #0 ("a") from the fold: only topic "b" was ever read
    expect(reads.filter((r) => r.startsWith("a@"))).toEqual([]);
    expect(reads.some((r) => r.startsWith("b@"))).toBe(true);
    expect((await h.rt.loadState("e1"))?.variables._output).toEqual({ a: "A", b: "B" });
  });

  it("without kernel.features.inbox, receive / select / send say what to turn on", async () => {
    const h = build({ inboxEnabled: false });
    const f = flow("w", async (ctx) => ctx.receive("x"));
    h.rt.registerFlow(f.definition, f.runner);
    const run = await h.rt.start(f, {}, { executionId: "e1" });
    await expect(run.waitForCompletion()).rejects.toThrow(/kernel\.features\.inbox/);
    await expect(h.rt.send("e1", { topic: "x", payload: 1 })).rejects.toThrow(
      /kernel\.features\.inbox/
    );
  });
});

describe("R2 — send: what is refused, and that nothing is appended", () => {
  async function parked() {
    const h = build();
    const f = flow("w", async (ctx) => ctx.receive("x"));
    h.rt.registerFlow(f.definition, f.runner);
    const run = await h.rt.start(f, {}, { executionId: "e1" });
    await run.waitForSuspend();
    return h;
  }
  const streamLen = async (h: Awaited<ReturnType<typeof parked>>) =>
    (await h.eventStore.read(inboxStreamId("e1"))).length;

  it("refuses a malformed topic, a reserved topic, an oversized payload", async () => {
    const h = await parked();
    for (const topic of ["", "__loom_x", "__proto__", "t".repeat(300)]) {
      await expect(h.rt.send("e1", { topic, payload: 1 })).rejects.toBeInstanceOf(
        InboxMessageRefusedError
      );
    }
    const small = build({ inboxMaxPayloadBytes: 16 });
    const f = flow("w", async (ctx) => ctx.receive("x"));
    small.rt.registerFlow(f.definition, f.runner);
    await (await small.rt.start(f, {}, { executionId: "e2" })).waitForSuspend();
    await expect(
      small.rt.send("e2", { topic: "x", payload: "x".repeat(64) })
    ).rejects.toBeInstanceOf(InboxMessageRefusedError);
    expect(await streamLen(h)).toBe(0);
    expect((await small.eventStore.read(inboxStreamId("e2"))).length).toBe(0);
  });

  it("a message for a finished, failed or cancelled execution is refused: nothing appended", async () => {
    const h = build();
    const done = flow("done", async () => "ok");
    const boom = flow("boom", async () => {
      throw new Error("x");
    });
    const wait = flow("wait", async (ctx) => ctx.receive("x"));
    for (const f of [done, boom, wait]) h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(done, {}, { executionId: "d" })).waitForCompletion();
    await (await h.rt.start(boom, {}, { executionId: "b" })).waitForCompletion().catch(() => 0);
    await (await h.rt.start(wait, {}, { executionId: "c" })).waitForSuspend();
    await h.rt.cancel("c");
    for (const id of ["d", "b", "c"]) {
      await expect(h.rt.send(id, { topic: "x", payload: 1 })).rejects.toBeInstanceOf(
        InboxClosedError
      );
      expect((await h.eventStore.read(inboxStreamId(id))).length).toBe(0);
    }
    await expect(h.rt.send("nope", { topic: "x", payload: 1 })).rejects.toThrow(/No execution/);
  });

  it("a resume cannot answer an inbox wait (only send does)", async () => {
    const h = await parked();
    const err = await h.rt
      .resume("e1", { eventType: "anything", waitId: "#0", payload: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResumeRefusedError);
    expect((err as ResumeRefusedError).reason).toBe("inbox-wait");
    expect(await kinds(h.eventStore, "e1")).not.toContain("MESSAGE_CONSUMED");
    // and the userspace guard refuses the kind by name on every ingress
    const forged = await h.rt
      .resume("e1", { eventType: "MESSAGE_CONSUMED", payload: {} })
      .catch((e: unknown) => e);
    expect((forged as ResumeRefusedError).reason).toBe("kernel-event-type");
  });

  it("send beyond inboxMaxBacklog is InboxFullError and the owner's log is untouched", async () => {
    const h = build({ inboxMaxBacklog: 3 });
    const f = flow("w", async (ctx) => ctx.receive("never"));
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    for (let i = 0; i < 3; i++) await h.rt.send("e1", { topic: "other", payload: i });
    const before = await kinds(h.eventStore, "e1");
    await expect(h.rt.send("e1", { topic: "other", payload: 9 })).rejects.toMatchObject({
      name: "InboxFullError",
    });
    expect(await kinds(h.eventStore, "e1")).toEqual(before);
    expect((await h.eventStore.read(inboxStreamId("e1"))).length).toBe(3);
  });
});

describe("R2 — TimerService: the cross-process wake", () => {
  it("a send from ANOTHER process wakes a parked owner through the due-now row: one delivery", async () => {
    const h = build();
    const f = flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>("x")));
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();

    // the sender's process has no flows registered: its same-process fast path cannot resume it
    const other = h.sibling();
    await other.send("e1", { topic: "x", payload: "from-afar" });
    await tick(30);
    expect((await h.rt.loadState("e1"))?.status).toBe("suspended"); // nobody woke it yet
    expect((await h.timers.due(Date.now())).map((t) => [t.executionId, t.wakeAt])).toEqual([
      ["e1", INBOX_WAKE_AT],
    ]);

    const service = new TimerService(h.rt, h.timers);
    await service.tick();
    expect((await h.rt.loadState("e1"))?.status).toBe("completed");
    expect((await h.rt.loadState("e1"))?.variables._output).toBe("from-afar");
    expect((await eventsOf(h.eventStore, "e1", "MESSAGE_CONSUMED")).length).toBe(1);
    expect(await h.timers.due(Date.now())).toEqual([]); // the row was retired
  });

  it("a burst of sends to a parked owner costs ONE timer row", async () => {
    const h = build();
    const f = flow("w", async (ctx) => ctx.receive("x"));
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    const other = h.sibling();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => other.send("e1", { topic: "x", payload: i }))
    );
    expect((await h.timers.due(Date.now())).length).toBe(1);
  });

  it("a send to a RUNNING owner writes no timer row (its quiescence commit reads the stream)", async () => {
    const latch = new Latch();
    const h = build({}, { latch });
    const f = flow("w", async (ctx) => {
      await ctx.run(slow, {});
      return unwrapTainted(await ctx.receive<string>("x"));
    });
    h.rt.registerFlow(f.definition, f.runner);
    const run = await h.rt.start(f, {}, { executionId: "e1" });
    await tick(20);
    await h.sibling().send("e1", { topic: "x", payload: "busy" });
    expect(await h.timers.due(Date.now())).toEqual([]);
    latch.release();
    await run.waitForCompletion();
    expect((await h.rt.loadState("e1"))?.variables._output).toBe("busy");
  });
});

void InMemoryAsyncEventStore;
