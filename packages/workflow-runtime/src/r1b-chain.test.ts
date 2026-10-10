import { unwrapTainted } from "@loom/classify";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { build, crashHarness, eventsOf, flow, kinds, settle, until } from "./__tests__/r2Harness";
import type { Harness } from "./__tests__/r2Harness";
import { ForkPastContinuationError } from "./continuation";
import { executionAccessPolicy } from "./executionAccessPolicy";
import { recoverAbandoned } from "./recoverAbandoned";

// ADR 0109 D2 (cancel window), D4 (head resolution), D7 (fork x chain), D3 (what the successor
// inherits): the chain as an addressable thing.

const on = { continueAsNewEnabled: true } as const;

/** Each message rotates: generation n receives one `go` and continues as n + 1. */
const hop = () =>
  flow<{ n?: number }, unknown>("hop", async (ctx, input) => {
    const n = input?.n ?? 0;
    await ctx.receive("go");
    return ctx.continueAsNew({ n: n + 1 });
  });

async function parked(h: Harness, id: string): Promise<void> {
  await until(async () => (await h.rt.loadState(id, h.rt.systemOptions()))?.status === "suspended");
}

/** Start `chain` and rotate it `k` times, addressing each message to the previous head. */
async function grow(h: Harness, chain: string, k: number): Promise<string> {
  const f = hop();
  h.rt.registerFlow(f.definition, f.runner);
  await settle(await h.rt.start(f, {}, { executionId: chain }));
  let head = chain;
  for (let i = 0; i < k; i++) {
    await parked(h, head);
    await h.rt.send(head, { topic: "go", payload: i, messageId: `go${i}` });
    const next = `${chain}~${i + 1}`;
    await until(async () => (await h.rt.loadState(next, h.rt.systemOptions())) !== null);
    head = next;
  }
  await parked(h, head);
  return head;
}

describe("ADR 0109 D4 — head resolution", () => {
  it("resume addressed to a continued id resolves forward to the head", async () => {
    const h = build(on);
    const f = flow<{ gen?: number }, unknown>("gate", async (ctx, input) => {
      if (input?.gen === undefined) {
        await ctx.receive("go");
        return ctx.continueAsNew({ gen: 1 });
      }
      return unwrapTainted(await ctx.suspend<string>({ on: "approval" }));
    });
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "g" }));
    await h.rt.send("g", { topic: "go", payload: 1 });
    await parked(h, "g~1");
    // the caller holds the OLD id
    const handle = await h.rt.resume("g", { eventType: "approval", payload: "yes" });
    await handle.waitForCompletion();
    expect((await h.rt.loadState("g~1"))?.status).toBe("completed");
    expect((await h.rt.loadState("g~1"))?.variables._output).toBe("yes");
    // nothing was appended to the predecessor by the resume
    expect((await kinds(h.eventStore, "g")).pop()).toBe("EXECUTION_CONTINUED");
  });

  it("a walk of more than maxChainHops generations is ROUTED to the head (the first id stays addressable)", async () => {
    const h = build({ ...on, maxChainHops: 2 });
    const head = await grow(h, "c", 4);
    expect(head).toBe("c~4");
    const sent = await h.rt.send("c", { topic: "go", payload: "x", messageId: "x1" });
    expect(sent.executionId).toBe("c~4");
    await until(async () => (await h.rt.loadState("c~5")) !== null);
    await parked(h, "c~5");
    // a resume by the first id reaches the head too
    await h.rt.send("c", { topic: "go", payload: "y", messageId: "y1" });
    await until(async () => (await h.rt.followToHead("c"))?.executionId === "c~6");
    expect(await h.rt.followToHead("c")).toMatchObject({ executionId: "c~6" });
  });

  it("followToHead names the head and counts the hops", async () => {
    const h = build(on);
    await grow(h, "c", 3);
    const head = await h.rt.followToHead("c");
    expect(head?.executionId).toBe("c~3");
    expect(head?.hops).toBe(3);
    expect(head?.state.status).toBe("suspended");
    expect((await h.rt.followToHead("c~3"))?.hops).toBe(0);
    expect(await h.rt.followToHead("nope")).toBeNull();
  });

  it("authorization is judged against the CHAIN's owner, which every generation inherits", async () => {
    const alice = { actor: "alice", tenant: "t1" };
    const mallory = { actor: "mallory", tenant: "t2" };
    const h = build({
      ...on,
      executionAuthorizer: executionAccessPolicy(),
      executionAuthz: { requirePrincipal: true },
    });
    const f = hop();
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "o", principal: alice }));
    await h.rt.send("o", { topic: "go", payload: 1 }, { principal: alice });
    await parked(h, "o~1");
    // the successor records the predecessor's principal
    const [a, b] = await Promise.all([h.eventStore.read("o"), h.eventStore.read("o~1")]);
    expect((b[0]?.payload as { principal: unknown }).principal).toEqual(
      (a[0]?.payload as { principal: unknown }).principal
    );
    const before = await kinds(h.eventStore, "o~1");
    for (const principal of [undefined, mallory]) {
      await expect(
        h.rt.send("o", { topic: "go", payload: "evil" }, principal ? { principal } : {})
      ).rejects.toThrow(/denied|principal|not allowed/i);
      await expect(
        h.rt.resume("o", { eventType: "x", payload: 1 }, principal ? { principal } : {})
      ).rejects.toThrow();
    }
    expect(await kinds(h.eventStore, "o~1")).toEqual(before);
    // the owner is not denied on the continued id
    const sent = await h.rt.send("o", { topic: "go", payload: 2 }, { principal: alice });
    expect(sent.executionId).toBe("o~1");
  });
});

describe("ADR 0109 D2 — cancel races the start-to-commit window", () => {
  const crashBeforeCommit = () =>
    crashHarness((e) => e.executionId === "p" && e.eventType === "EXECUTION_CONTINUED", {
      deps: on,
    });

  async function windowOpen() {
    const c = crashBeforeCommit();
    const f = hop();
    c.h.rt.registerFlow(f.definition, f.runner);
    await settle(await c.h.rt.start(f, {}, { executionId: "p" }));
    await c.h.rt.send("p", { topic: "go", payload: 1 });
    await until(async () => c.crash.crashed);
    // the successor is durable, the commit was lost
    expect((await c.inner.read("p~1"))[0]?.eventType).toBe("EXECUTION_STARTED");
    return { c, f };
  }

  it("(i) cancel of the predecessor probes and cancels the started successor", async () => {
    const { c, f } = await windowOpen();
    const rt2 = c.process();
    rt2.registerFlow(f.definition, f.runner);
    expect((await rt2.loadState("p"))?.status).toBe("running");
    expect(await rt2.cancel("p", "stop")).toBe(true);
    expect((await rt2.loadState("p"))?.status).toBe("cancelled");
    expect((await rt2.loadState("p~1"))?.status).toBe("cancelled");
    // recovery has nothing to revive: no live generation, no continuation committed
    await recoverAbandoned(rt2, { source: c.inner as EventStore, isAbandoned: () => true });
    expect((await rt2.loadState("p~1"))?.status).toBe("cancelled");
    expect(await kinds(c.inner, "p")).not.toContain("EXECUTION_CONTINUED");
  });

  it("(ii) a successor whose predecessor was cancelled AFTER the probe cancels itself, before any effect", async () => {
    const { c, f } = await windowOpen();
    // a cancel that landed after (i)'s probe: the predecessor's EXECUTION_CANCELLED is durable, the
    // successor is not cancelled
    const tip = (await c.inner.read("p")).length;
    await c.inner.append({
      id: `p-${tip}`,
      workflowId: "hop",
      executionId: "p",
      eventType: "EXECUTION_CANCELLED",
      sequence: tip,
      timestamp: Date.now(),
      payload: { reason: "late" },
    });
    const rt2 = await c.reboot();
    rt2.registerFlow(f.definition, f.runner);
    await until(async () => {
      await recoverAbandoned(rt2, { source: c.inner as EventStore, isAbandoned: () => true });
      return (await rt2.loadState("p~1"))?.status === "cancelled";
    });
    const events = await c.inner.read("p~1");
    const cancelled = events.find((e) => e.eventType === "EXECUTION_CANCELLED");
    expect(JSON.parse((cancelled?.payload as { reason: string }).reason)).toEqual({
      kind: "cascade",
      parent: "p",
    });
    // it never ran: the recovery marker, then the cascade cancel; no step, no park, nothing consumed
    expect(events.map((e) => e.eventType)).toEqual([
      "EXECUTION_STARTED",
      "EXECUTION_RECOVERED",
      "EXECUTION_CANCELLED",
    ]);
  });

  it("a cancel that lands while the predecessor is rotating cancels the successor it just started", async () => {
    // Deterministic: the successor start is gated; the cancel is issued while it is pending.
    const gate = (() => {
      let open!: () => void;
      const promise = new Promise<void>((r) => {
        open = r;
      });
      return { promise, open };
    })();
    const inner = new InMemoryAsyncEventStore();
    const view = Object.create(inner) as EventStore;
    view.append = async (e) => {
      if (e.executionId === "w~1" && e.sequence === 0) await gate.promise;
      return inner.append(e);
    };
    view.appendBatch = async (es) => inner.appendBatch?.(es);
    const h = build(on, { eventStore: view });
    const f = flow<{ gen?: number }, unknown>("w", async (ctx, input) => {
      if (input?.gen !== undefined) {
        await ctx.receive("never");
        return "ran";
      }
      await ctx.receive("go");
      return ctx.continueAsNew({ gen: 1 });
    });
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "w" }));
    await h.rt.send("w", { topic: "go", payload: 1 });
    await until(
      () =>
        h.rt.liveHandle("w") !== undefined && h.rt.liveHandle("w")?.getState().status === "running"
    );
    // the successor's sequence 0 is pending; cancel the (live) predecessor now
    await until(
      async () => (await inner.read("w~1")).length === 0 && h.rt.liveHandle("w") !== undefined
    );
    const cancelling = h.rt.cancel("w", "stop");
    gate.open();
    expect(await cancelling).toBe(true);
    await until(async () => (await h.rt.loadState("w~1"))?.status === "cancelled");
    expect((await h.rt.loadState("w"))?.status).toBe("cancelled");
    expect(await kinds(inner, "w")).not.toContain("EXECUTION_CONTINUED");
  });

  it("a cancel that lands after the commit is journaled but before it is durable cancels the SUCCESSOR, and never follows EXECUTION_CONTINUED in the predecessor's log", async () => {
    const gate = (() => {
      let open!: () => void;
      const promise = new Promise<void>((r) => {
        open = r;
      });
      return { promise, open };
    })();
    const inner = new InMemoryAsyncEventStore();
    const view = Object.create(inner) as EventStore;
    view.append = async (e) => {
      if (e.executionId === "z" && e.eventType === "EXECUTION_CONTINUED") await gate.promise;
      return inner.append(e);
    };
    view.appendBatch = async (es) => inner.appendBatch?.(es);
    const h = build(on, { eventStore: view });
    const f = hop();
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "z" }));
    await h.rt.send("z", { topic: "go", payload: 1 });
    // the successor is durable and the commit is journaled (folded in memory) but not yet durable
    await until(async () => (await inner.read("z~1")).length > 0);
    await until(() => h.rt.liveHandle("z")?.getState().status === "continued");
    expect(await h.rt.cancel("z", "stop")).toBe(true);
    gate.open();
    await until(async () => (await h.rt.loadState("z~1"))?.status === "cancelled");
    // the predecessor's log ends in the continuation: the cancel did not rewrite its history
    const tail = (await inner.read("z")).map((e) => e.eventType);
    expect(tail[tail.length - 1]).toBe("EXECUTION_CONTINUED");
    expect(tail).not.toContain("EXECUTION_CANCELLED");
    expect((await h.rt.loadState("z"))?.status).toBe("continued");
  });

  it("cancel of a CONTINUED member cancels the chain's live generation", async () => {
    const h = build(on);
    await grow(h, "c", 2);
    expect(await h.rt.cancel("c", "stop")).toBe(true);
    expect((await h.rt.loadState("c~2"))?.status).toBe("cancelled");
    expect((await h.rt.loadState("c"))?.status).toBe("continued"); // history is not rewritten
    expect(await h.rt.cancel("c", "again")).toBe(false); // the head is already terminal
  });

  it("cancelling a chain deeper than maxChainHops reaches the live head (routed)", async () => {
    const h = build({ ...on, maxChainHops: 1 });
    await grow(h, "c", 3);
    expect(await h.rt.cancel("c", "stop")).toBe(true);
    expect((await h.rt.loadState("c~3"))?.status).toBe("cancelled");
    expect(await h.rt.cancel("c~3", "stop")).toBe(false);
  });
});

describe("ADR 0109 D7 — a fork of a chain member leaves the chain", () => {
  it("gets a fresh chain, no continuedFrom, no carried inbox; the owner's inbox is untouched", async () => {
    const h = build(on);
    const f = flow<{ gen?: number }, unknown>("fk", async (ctx, input) => {
      if (input?.gen === undefined) {
        await ctx.receive("go");
        return ctx.continueAsNew({ gen: 1 });
      }
      const seen: unknown[] = [];
      for (;;) seen.push(unwrapTainted(await ctx.receive("q")));
    });
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "m" }));
    await h.rt.send("m", { topic: "go", payload: 1 });
    await parked(h, "m~1");
    await h.rt.send("m~1", { topic: "q", payload: "a", messageId: "a" });
    await until(async () => (await eventsOf(h.eventStore, "m~1", "MESSAGE_CONSUMED")).length === 1);
    await parked(h, "m~1");
    const tip = (await h.eventStore.read("m~1")).length - 1;

    const { executionId: fork } = await h.rt.fork("m~1", tip, { executionId: "fk1" });
    const state = await h.rt.loadState(fork);
    expect(state?.variables._chain).toEqual({ chainId: "fk1", generation: 0 }); // no continuedFrom
    const stamped = (await h.eventStore.read(fork))[0];
    expect(stamped?.metadata?.forkChain).toEqual({ chainId: "fk1", generation: 0 });
    // the cursor the owner CARRIED from its predecessor (`go`) is NOT the fork's: only what the fork's
    // own copied prefix consumed (`q`) counts
    const cursorsOf = async (id: string) =>
      ((await h.rt.loadState(id))?.variables._inbox as { cursors: Record<string, number> }).cursors;
    expect(await cursorsOf("m~1")).toEqual({ go: 0, q: 1 });
    expect(await cursorsOf(fork)).toEqual({ q: 1 });
    await parked(h, fork);

    // a message to the owner is delivered to the owner ONLY
    await h.rt.send("m~1", { topic: "q", payload: "b", messageId: "b" });
    await until(async () => (await eventsOf(h.eventStore, "m~1", "MESSAGE_CONSUMED")).length === 2);
    expect(await eventsOf(h.eventStore, fork, "MESSAGE_CONSUMED")).toHaveLength(1); // the copied prefix's
    expect(await cursorsOf(fork)).toEqual({ q: 1 }); // unchanged
    expect((await cursorsOf("m~1")).q).toBe(2);
    // ...and a message to the fork reaches the fork alone
    await h.rt.send(fork, { topic: "q", payload: "c", messageId: "c" });
    await until(async () => (await eventsOf(h.eventStore, fork, "MESSAGE_CONSUMED")).length === 2);
    expect(await eventsOf(h.eventStore, "m~1", "MESSAGE_CONSUMED")).toHaveLength(2);
  });

  it("a fork point at or after EXECUTION_CONTINUED is refused naming the successor; before it is ordinary", async () => {
    const h = build(on);
    await grow(h, "c", 1);
    const log = await h.eventStore.read("c");
    const contSeq = log.find((e) => e.eventType === "EXECUTION_CONTINUED")?.sequence as number;
    const before = (await h.eventStore.read("c")).length;
    for (const at of [contSeq, contSeq + 0]) {
      const err = await h.rt.fork("c", at, { executionId: `bad${at}` }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForkPastContinuationError);
      expect((err as ForkPastContinuationError).successorId).toBe("c~1");
      expect(await h.eventStore.read(`bad${at}`)).toEqual([]); // nothing written
    }
    expect((await h.eventStore.read("c")).length).toBe(before);

    // before it: an ordinary fork, which (when re-run to its rotation) starts <fork-id>~1
    const ok = await h.rt.fork("c", contSeq - 1, { executionId: "okfork" });
    const st = await h.rt.loadState(ok.executionId);
    expect(st?.status).not.toBe("continued");
    expect(st?.variables._continuedTo).toBeUndefined();
  });

  it("chain identity is read through the FOLD: cancelling a fork's ex-predecessor never cascades into the fork, and the fork's head probe resolves to the fork", async () => {
    const h = build(on);
    await grow(h, "c", 2); // c -> c~1 -> c~2 (parked)
    // c~1's log says `cancelled` (a cancel that landed after the probe, written by hand)
    const tip1 = (await h.eventStore.read("c~1")).length;
    await h.eventStore.append({
      id: `c~1-${tip1}`,
      workflowId: "hop",
      executionId: "c~1",
      eventType: "EXECUTION_CANCELLED",
      sequence: tip1,
      timestamp: Date.now(),
      payload: { reason: "x" },
    });
    // a fork of c~2 at its start: its COPIED sequence 0 still names `continuedFrom: c~1`
    const { executionId: fk } = await h.rt.fork("c~2", 0, { executionId: "fk" });
    const raw = (await h.eventStore.read(fk))[0];
    expect(
      (raw?.payload as { continuedFrom?: { executionId: string } }).continuedFrom?.executionId
    ).toBe("c~1");
    // re-driving it is a FIRST RUN: a raw read of sequence 0 would cascade-cancel it
    const handle = await h.rt.resume(fk, { eventType: "EXECUTION_RECOVERED", payload: {} });
    await settle(handle);
    expect((await h.rt.loadState(fk))?.status).toBe("suspended");
    expect(await kinds(h.eventStore, fk)).not.toContain("EXECUTION_CANCELLED");
    // and a message addressed to the fork stays with the fork
    const sent = await h.rt.send(fk, { topic: "go", payload: 1 });
    expect(sent.executionId).toBe(fk);
  });

  it("a fork of a fork starts its own chain, never the first fork's", async () => {
    const h = build(on);
    await grow(h, "c", 1);
    const head = "c~1";
    const tip = (await h.eventStore.read(head)).length - 1;
    await h.rt.fork(head, tip, { executionId: "f1" });
    const tip1 = (await h.eventStore.read("f1")).length - 1;
    await h.rt.fork("f1", tip1, { executionId: "f2" });
    expect((await h.rt.loadState("f2"))?.variables._chain).toEqual({
      chainId: "f2",
      generation: 0,
    });
    expect((await h.eventStore.read("f2"))[0]?.metadata?.forkChain).toEqual({
      chainId: "f2",
      generation: 0,
    });
  });

  it("a fork of an ordinary execution is byte-identical to before (no forkChain stamp)", async () => {
    const h = build(on);
    const f = flow<unknown, unknown>("plain", async (ctx) => {
      await ctx.receive("go");
      return "ok";
    });
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "plain1" }));
    const tip = (await h.eventStore.read("plain1")).length - 1;
    await h.rt.fork("plain1", tip, { executionId: "plainfork" });
    for (const e of await h.eventStore.read("plainfork")) {
      expect(e.metadata?.forkChain).toBeUndefined();
    }
    expect((await h.rt.loadState("plainfork"))?.variables._chain).toBeUndefined();
  });
});
