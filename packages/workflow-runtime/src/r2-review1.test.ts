import { unwrapTainted } from "@loom/classify";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { Latch, build, eventsOf, flow, kinds, slow, tick, until } from "./__tests__/r2Harness";
import { appendInboxMessage, dedupeKeyOf, inboxStreamId, scanInbox, trimInbox } from "./inbox";
import { recoverAbandoned } from "./recoverAbandoned";
import { InboxClosedError, InboxFullError, InboxMessageRefusedError } from "./types";

// ADR 0110 (R2) — the first review's findings, each as a regression test.

const completed = (h: ReturnType<typeof build>, id = "e1") =>
  until(async () => (await h.rt.loadState(id, h.rt.systemOptions()))?.status === "completed", 8000);
const outputOf = async (h: ReturnType<typeof build>, id = "e1") =>
  (await h.rt.loadState(id, h.rt.systemOptions()))?.variables._output;
const stored = (messageId: string, payload: unknown, sender = {}) => ({
  topic: "x",
  messageId,
  payload,
  sender,
});

describe("P1-1 — a send never loses its wakeup to the owner's park", () => {
  it("the sender's append lands AFTER the owner's park and re-read: the sender (reading after its append) wakes it", async () => {
    const inner = new InMemoryAsyncEventStore();
    const view = Object.create(inner) as EventStore;
    let gate: (() => void) | undefined;
    const hold = new Promise<void>((r) => {
      gate = r;
    });
    view.append = async (e) => {
      if (e.executionId.startsWith("__loom_inbox__")) await hold; // the sender stalls before its append lands
      return inner.append(e);
    };
    const latch = new Latch();
    const h = build({}, { eventStore: view, latch });
    const f = flow("w", async (ctx) => {
      await ctx.run(slow, {});
      return unwrapTainted(await ctx.receive<string>("x"));
    });
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "e1" });
    await tick(20);
    const sending = h.rt.send("e1", { topic: "x", payload: "hello" }); // reads "running" first
    await tick(20);
    latch.release();
    await handle.waitForSuspend();
    await tick(100); // the owner's post-park re-read finds nothing
    gate?.(); // NOW the append lands
    await sending;
    await completed(h);
    expect(await outputOf(h)).toBe("hello");
  });
});

describe("P1-2 — a fork inherits cursors but its inbox allocates above them", () => {
  it("parent consumes 3, fork, a send to the fork is delivered (not skipped, not trimmed)", async () => {
    const h = build();
    const f = flow("w", async (ctx) => {
      const out: string[] = [];
      for (let i = 0; i < 4; i++) out.push(unwrapTainted(await ctx.receive<string>("x")));
      return out;
    });
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    for (const p of ["a", "b", "c"]) await h.rt.send("e1", { topic: "x", payload: p });
    await until(async () => {
      const s = await h.rt.loadState("e1", h.rt.systemOptions());
      return Object.keys((s?.variables._waitAnswers as object) ?? {}).length === 3;
    });
    await tick(60);
    const tip = (await h.rt.loadState("e1", h.rt.systemOptions()))!.sequence;
    const fk = await h.rt.fork("e1", tip, { executionId: "f1" });
    const sent = await h.rt.send("f1", { topic: "x", payload: "to-fork" });
    expect(sent.inboxSeq).toBeGreaterThan(2); // above the inherited cursor
    await completed(h, fk.executionId);
    expect(await outputOf(h, "f1")).toEqual(["a", "b", "c", "to-fork"]);
  });
});

describe("P1-3 — duplicates ahead of a real message never stall delivery", () => {
  for (const n of [17, 1000]) {
    it(`${n} in-window duplicates ahead of a real message: delivered, duplicates journaled in the same batch`, async () => {
      const h = build();
      const f = flow("w", async (ctx) => {
        const a = unwrapTainted(await ctx.receive<string>("x"));
        const b = unwrapTainted(await ctx.receive<string>("x"));
        return [a, b];
      });
      h.rt.registerFlow(f.definition, f.runner);
      await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
      await h.rt.send("e1", { topic: "x", payload: "first", messageId: "d" });
      await until(async () => {
        const s = await h.rt.loadState("e1", h.rt.systemOptions());
        return Object.keys((s?.variables._waitAnswers as object) ?? {}).length === 1;
      });
      await tick(50);
      // appended straight to the stream (a sender burst), no wake: the notify path must page past them
      for (let i = 0; i < n; i++) {
        await appendInboxMessage(h.eventStore, "e1", stored("d", "dup"), Date.now);
      }
      await appendInboxMessage(h.eventStore, "e1", stored("r", "real"), Date.now);
      const svc = new TimerService(h.rt, h.timers);
      await h.rt.notifyInbox("e1");
      for (let i = 0; i < 3; i++) await svc.tick(Date.now() + 1);
      await completed(h);
      expect(await outputOf(h)).toEqual(["first", "real"]);
      const consumed = await eventsOf(h.eventStore, "e1", "MESSAGE_CONSUMED");
      expect(consumed.length).toBe(n + 2);
    }, 30_000);
  }

  it("only duplicates: their cursor advance is journaled under the fence and the park stays unanswered", async () => {
    const h = build();
    const f = flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>("x")));
    // first message consumed live by an earlier wait is not needed: seed the window via a prior run
    const g = flow("w", async (ctx) => {
      const a = unwrapTainted(await ctx.receive<string>("x"));
      const b = unwrapTainted(await ctx.receive<string>("x"));
      return [a, b];
    });
    void f;
    h.rt.registerFlow(g.definition, g.runner);
    await (await h.rt.start(g, {}, { executionId: "e1" })).waitForSuspend();
    await h.rt.send("e1", { topic: "x", payload: "one", messageId: "d" });
    await until(async () => {
      const s = await h.rt.loadState("e1", h.rt.systemOptions());
      return Object.keys((s?.variables._waitAnswers as object) ?? {}).length === 1;
    });
    await tick(50);
    for (let i = 0; i < 5; i++) {
      await appendInboxMessage(h.eventStore, "e1", stored("d", "dup"), Date.now);
    }
    expect((await h.rt.notifyInboxDetailed("e1")).handle).toBeUndefined();
    const s = await h.rt.loadState("e1", h.rt.systemOptions());
    expect(s?.status).toBe("suspended");
    const cursors = (s?.variables._inbox as { cursors: Record<string, number> }).cursors;
    expect(cursors.x).toBe(5); // 0 (first) + five duplicates at 1..5
    // a real message after them is delivered once
    await h.rt.send("e1", { topic: "x", payload: "two", messageId: "m2" });
    await completed(h);
    expect(await outputOf(h)).toEqual(["one", "two"]);
  });
});

describe("P2-1 — the runtime's duplicate test IS the fold's", () => {
  it("a (removed) small dedupe window setting cannot make the live run and a replay disagree", async () => {
    const h = build({ inboxDedupeWindow: 1 } as never);
    const f = flow("w", async (ctx) => {
      const r = [
        unwrapTainted(await ctx.receive<string>("x")),
        unwrapTainted(await ctx.receive<string>("x")),
        unwrapTainted(await ctx.receive<string>("x")),
      ];
      await ctx.suspend({ on: "Done" });
      return r;
    });
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "e1" });
    await handle.waitForSuspend();
    await h.rt.send("e1", { topic: "x", payload: "p1", messageId: "a" });
    await h.rt.send("e1", { topic: "x", payload: "p2", messageId: "b" });
    await h.rt.send("e1", { topic: "x", payload: "p3-dup-id", messageId: "a" }); // a duplicate by the fold
    await h.rt.send("e1", { topic: "x", payload: "p4", messageId: "c" });
    await until(async () => {
      const s = await h.rt.loadState("e1", h.rt.systemOptions());
      return s?.suspendedOn?.on === "Done";
    });
    // the FOLD of the log (what every replay sees) holds the same three answers the live run used
    const folded = (await h.rt.loadState("e1", h.rt.systemOptions()))?.variables
      ._waitAnswers as Record<string, { payload: string }>;
    expect(Object.values(folded).map((a) => a.payload)).toEqual(["p1", "p2", "p4"]);
    await h.rt.resume(
      "e1",
      { eventType: "Done", payload: { ok: true } },
      { fence: await (h.eventStore as InMemoryAsyncEventStore).acquireFence("e1") }
    );
    await completed(h);
    // the replay (a fresh fold of the log) and the live run delivered the same three messages
    expect(await outputOf(h)).toEqual(["p1", "p2", "p4"]);
  });
});

describe("P3-1 — a half-written resume above the park still reads as parked", () => {
  it("a TIMER_FIRED (or any ignorable) tip over a park: the send wakes the owner", async () => {
    const inner = new InMemoryAsyncEventStore();
    const h = build({}, { eventStore: inner });
    const f = flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>("x")));
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    const s = (await h.rt.loadState("e1", h.rt.systemOptions()))!;
    // a timer fire whose resume never landed (the process died between the two writes)
    await inner.append({
      id: `e1-${s.sequence + 1}`,
      workflowId: "w",
      executionId: "e1",
      eventType: "TIMER_FIRED",
      sequence: s.sequence + 1,
      timestamp: Date.now(),
      payload: { wakeAt: 1 },
    });
    await h.rt.send("e1", { topic: "x", payload: "woken" });
    await completed(h);
    expect(await outputOf(h)).toBe("woken");
  });
});

describe("P3-3 — backpressure and trim are bounded", () => {
  it("a flood of refused sends costs one backlog scan, not one per send", async () => {
    const inner = new InMemoryAsyncEventStore();
    const view = Object.create(inner) as EventStore;
    let streamReads = 0;
    const origRange = inner.readRange?.bind(inner);
    const origFrom = inner.readFrom.bind(inner);
    view.readFrom = async (id: string, from: number) => {
      if (id.startsWith("__loom_inbox__")) streamReads++;
      return origFrom(id, from);
    };
    if (origRange !== undefined) {
      view.readRange = async (id: string, lo: number, hi: number) => {
        if (id.startsWith("__loom_inbox__")) streamReads++;
        return origRange(id, lo, hi);
      };
    }
    const h = build({ inboxMaxBacklog: 5 }, { eventStore: view });
    const f = flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>("never")));
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    for (let i = 0; i < 5; i++) await h.rt.send("e1", { topic: "x", payload: i });
    await expect(h.rt.send("e1", { topic: "x", payload: "over" })).rejects.toBeInstanceOf(
      InboxFullError
    );
    const before = streamReads;
    for (let i = 0; i < 50; i++) {
      await expect(h.rt.send("e1", { topic: "x", payload: "over" })).rejects.toBeInstanceOf(
        InboxFullError
      );
    }
    expect(streamReads - before).toBeLessThan(10);
  });

  it("trim and the backlog scan start above the known floor, never at the stream's start", async () => {
    const inner = new InMemoryAsyncEventStore();
    for (let i = 0; i < 300; i++) {
      await appendInboxMessage(
        inner,
        "c",
        { topic: "x", messageId: `m${i}`, payload: i, sender: {} },
        Date.now
      );
    }
    const seen: number[] = [];
    const view = Object.create(inner) as EventStore;
    const origRange = inner.readRange?.bind(inner);
    view.readRange = async (id: string, lo: number, hi: number) => {
      seen.push(lo);
      return (origRange as NonNullable<typeof origRange>)(id, lo, hi);
    };
    const cursors = { x: 289 };
    const r = await scanInbox(view, "c", cursors, { from: 280, stopAtFirst: true });
    expect(r.oldest).toBe(290);
    expect(Math.min(...seen)).toBe(280);
    seen.length = 0;
    await trimInbox(view, "c", cursors, 280);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(281);
  });
});

describe("P3-4 — dedupe is per (sender, messageId)", () => {
  const alice = { actor: "alice", tenant: "t1" };
  const bob = { actor: "bob", tenant: "t1" };
  it("two senders using the same messageId are both delivered; one sender's retry is not", async () => {
    const h = build();
    const f = flow("w", async (ctx) => {
      const a = unwrapTainted(await ctx.receive<string>("x"));
      const b = unwrapTainted(await ctx.receive<string>("x"));
      const c = unwrapTainted(await ctx.receive<string>("x"));
      return [a, b, c];
    });
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await h.rt.send("e1", { topic: "x", payload: "alice-1", messageId: "1" }, { principal: alice });
    await h.rt.send(
      "e1",
      { topic: "x", payload: "alice-retry", messageId: "1" },
      { principal: alice }
    );
    await h.rt.send("e1", { topic: "x", payload: "bob-1", messageId: "1" }, { principal: bob });
    await h.rt.send("e1", { topic: "x", payload: "alice-2", messageId: "2" }, { principal: alice });
    await completed(h);
    expect(await outputOf(h)).toEqual(["alice-1", "bob-1", "alice-2"]);
    expect(dedupeKeyOf({ messageId: "1", sender: { actor: "alice", tenant: "t1" } })).not.toBe(
      dedupeKeyOf({ messageId: "1", sender: { actor: "bob", tenant: "t1" } })
    );
  });

  it("a messageId over 256 characters is refused, nothing appended", async () => {
    const h = build();
    const f = flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>("x")));
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await expect(
      h.rt.send("e1", { topic: "x", payload: 1, messageId: "m".repeat(257) })
    ).rejects.toBeInstanceOf(InboxMessageRefusedError);
    expect(await h.eventStore.read(inboxStreamId("e1"))).toEqual([]);
  });
});

describe("P3-6 — a flag-off node leaves the inbox's due-now rows alone", () => {
  it("TimerService on an inbox-off runtime does not retire the row; an inbox-on node still delivers", async () => {
    const h = build();
    const f = flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>("x")));
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await appendInboxMessage(h.eventStore, "e1", stored("m", "later"), Date.now);
    await h.timers.schedule({ executionId: "e1", wakeAt: -1 });
    const off = h.sibling({ inboxEnabled: false });
    off.registerFlow(f.definition, f.runner);
    await new TimerService(off, h.timers).tick(Date.now() + 1);
    expect((await h.timers.due(Date.now() + 1)).length).toBe(1); // still there
    expect((await h.rt.loadState("e1", h.rt.systemOptions()))?.status).toBe("suspended");
    await new TimerService(h.rt, h.timers).tick(Date.now() + 1);
    await completed(h);
    expect(await outputOf(h)).toBe("later");
  });
});

describe("P3-7 — concurrent waits in one scope are refused, not mis-numbered", () => {
  it("a wait registered after a real async gap while an earlier one is pending is an error", async () => {
    const h = build();
    const f = flow("w", async (ctx) => {
      const a = ctx.receive<string>("a");
      await ctx.run(slow, {});
      const b = ctx.receive<string>("b");
      return Promise.all([a, b]);
    });
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "e1" });
    await expect(handle.waitForCompletion()).rejects.toThrow(/Concurrent waits in one scope/);
  });

  it("waits registered in one synchronous turn are still fine (call order is the identity)", async () => {
    const h = build();
    const f = flow("w", async (ctx) => {
      const [a, b] = await Promise.all([ctx.receive<string>("a"), ctx.receive<string>("b")]);
      return [unwrapTainted(a), unwrapTainted(b)];
    });
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await h.rt.send("e1", { topic: "b", payload: "B" });
    await h.rt.send("e1", { topic: "a", payload: "A" });
    await completed(h);
    expect(await outputOf(h)).toEqual(["A", "B"]);
  });
});

describe("minor findings", () => {
  it("the payload limit counts UTF-8 bytes, not UTF-16 code units", async () => {
    const h = build({ inboxMaxPayloadBytes: 20 });
    const f = flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>("x")));
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    // 8 characters, 24 bytes in UTF-8 (+ quotes): over 20 bytes, under 20 code units
    await expect(
      h.rt.send("e1", { topic: "x", payload: "日本語日本語日本" })
    ).rejects.toBeInstanceOf(InboxMessageRefusedError);
  });

  it("a timer arm's _waits entry is dropped once its select was settled by another arm", async () => {
    const h = build();
    const f = flow("w", async (ctx) => {
      await ctx.select([{ inbox: "x" }, { timer: { afterMs: 3_600_000 } }]);
      await ctx.select([{ inbox: "x" }, { timer: { afterMs: 3_600_000 } }]);
      await ctx.suspend({ on: "End" });
      return 1;
    });
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await h.rt.send("e1", { topic: "x", payload: 1 });
    await until(async () => {
      const s = await h.rt.loadState("e1", h.rt.systemOptions());
      return s?.suspendedOn?.waits?.[0]?.waitId === "#2";
    });
    const s = await h.rt.loadState("e1", h.rt.systemOptions());
    expect(Object.keys((s?.variables._waits as object) ?? {})).toEqual(["#3"]);
  });
});

describe("(a) the inbox stream is deleted when the head turns terminal", () => {
  it("completion deletes the stream; a later send is refused and leaves no orphan", async () => {
    const h = build();
    const f = flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>("x")));
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await h.rt.send("e1", { topic: "x", payload: "bye" });
    await completed(h);
    await tick(30);
    expect(await h.eventStore.read(inboxStreamId("e1"))).toEqual([]);
    await expect(h.rt.send("e1", { topic: "x", payload: "late" })).rejects.toBeInstanceOf(
      InboxClosedError
    );
    expect(await h.eventStore.read(inboxStreamId("e1"))).toEqual([]);
  });

  it("a send whose append lands AFTER the terminal's delete deletes its own orphan", async () => {
    const inner = new InMemoryAsyncEventStore();
    const view = Object.create(inner) as EventStore;
    let release: (() => void) | undefined;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let armed = false;
    view.append = async (e) => {
      if (armed && e.executionId.startsWith("__loom_inbox__")) await hold;
      return inner.append(e);
    };
    const latch = new Latch();
    const h = build({}, { eventStore: view, latch });
    const f = flow("w", async (ctx) => {
      await ctx.run(slow, {});
      return "done";
    });
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "e1" });
    await tick(20);
    armed = true;
    const sending = h.rt.send("e1", { topic: "x", payload: 1 }); // read "running", stalls at its append
    const outcome = sending.then(
      () => "sent",
      (e: unknown) => e
    );
    await tick(20);
    latch.release();
    await handle.waitForCompletion();
    await tick(50); // the owner is terminal and its stream delete has run (nothing to delete yet)
    release?.(); // the append lands NOW, after the delete
    expect(await outcome).toBeInstanceOf(InboxClosedError);
    expect(await inner.read(inboxStreamId("e1"))).toEqual([]); // no orphan
  });
});

describe("(e) the inbox refuses a store without an atomic appendBatch", () => {
  it("composition throws, naming the requirement", () => {
    const inner = new InMemoryAsyncEventStore();
    const view = Object.create(inner) as EventStore;
    (view as { appendBatch?: unknown }).appendBatch = undefined;
    expect(
      () =>
        new WorkflowRuntime({
          eventStore: view,
          snapshotStore: build().snapshotStore,
          effectRuntime: build().effects,
          inboxEnabled: true,
          timerStore: new InMemoryTimerStore(),
        })
    ).toThrow(/appendBatch/);
  });

  it("with the flag off, such a store is fine", () => {
    const view = Object.create(new InMemoryAsyncEventStore()) as EventStore;
    (view as { appendBatch?: unknown }).appendBatch = undefined;
    expect(
      () =>
        new WorkflowRuntime({
          eventStore: view,
          snapshotStore: build().snapshotStore,
          effectRuntime: build().effects,
        })
    ).not.toThrow();
  });
});

describe("recoverAbandoned still heals a lost wake (sanity after the send reorder)", () => {
  it("a message appended with no wake is delivered by a recovery pass", async () => {
    const h = build();
    const f = flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>("x")));
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
    await appendInboxMessage(h.eventStore, "e1", stored("m", "healed"), Date.now);
    await recoverAbandoned(h.rt, { source: h.eventStore as never, isAbandoned: () => false });
    await completed(h);
    expect(await outputOf(h)).toBe("healed");
    expect(await kinds(h.eventStore, "e1")).toContain("MESSAGE_CONSUMED");
  });
});
