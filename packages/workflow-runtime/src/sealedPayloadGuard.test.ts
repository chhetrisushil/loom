import { unwrapTainted } from "@loom/classify";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import { build, eventsOf, flow, until } from "./__tests__/r2Harness";
import {
  INBOX_WAKE_AT,
  SEALED_WALK_BUDGET,
  assertDeliverable,
  inboxStreamId,
  sealedEnvelopeIn,
} from "./inbox";
import { recoverAbandoned } from "./recoverAbandoned";
import { InboxMessageRefusedError, SealedPayloadUnreadableError } from "./types";

// ADR 0130 — the kernel refuses to deliver a sealed (encrypted) inbox payload to a flow on a node
// that cannot open it. Without the guard that node handed the flow the `{ __loomEnc }` envelope as
// the user's payload and JOURNALED it as MESSAGE_CONSUMED, so the corruption was durable.

const SECRET = "123-45-6789";
let seq = 0;
const id = (): string => `sg-${++seq}-${Math.random().toString(36).slice(2, 6)}`;

/** Two nodes over ONE set of raw stores: `sealed` opens the inbox, `plain` has no crypto at all. */
function twoNodes(sensitive: Record<string, readonly string[]>) {
  const raw = {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    timers: new InMemoryTimerStore(),
  };
  const keys = new InMemoryKeyStore();
  const sealedStore = new EncryptingEventStore(raw.eventStore, keys, {
    // what defineConfig registers with the inbox on: the consumed copy is sealed too
    sensitive: { MESSAGE_CONSUMED: ["payload"], ...sensitive },
    subjectOf: (e) => e.executionId,
  });
  const sealed = build({}, { ...raw, eventStore: sealedStore });
  const plain = build({}, { ...raw });
  return { raw, sealed, plain };
}

const receiveFlow = () =>
  flow("w", async (ctx) => {
    const y = unwrapTainted(await ctx.receive<unknown>("y"));
    return { y };
  });

describe("sealed-payload guard (ADR 0130)", () => {
  it("a node that cannot open a sealed message refuses it: log untouched, message kept, a configured node then delivers it", async () => {
    const { raw, sealed, plain } = twoNodes({ INBOX_MESSAGE: ["payload"] });
    const f = receiveFlow();
    sealed.rt.registerFlow(f.definition, f.runner);
    plain.rt.registerFlow(f.definition, f.runner);
    const e2 = id();
    await (await sealed.rt.start(f, {}, { executionId: e2 })).waitForSuspend();
    // The owner is parked on its receive. Write the sealed message straight through the sealing
    // store (no send, so no wake on the sealed node) and let ONLY the plain node look at it.
    await until(async () => (await sealed.rt.loadState(e2))?.status === "suspended");
    await sealed.rt.notifyInbox(e2); // settle the owner's own post-park read before the raw append
    const rawBefore = (await raw.eventStore.read(e2)).length;
    await sealed.eventStore.append({
      executionId: inboxStreamId(e2),
      workflowId: "__loom_inbox__",
      sequence: 0,
      eventType: "INBOX_MESSAGE",
      timestamp: Date.now(),
      payload: {
        topic: "y",
        messageId: "m2",
        payload: { ssn: SECRET },
        sender: {},
      },
    } as never);
    const inboxRaw = await raw.eventStore.read(inboxStreamId(e2));
    expect(JSON.stringify(inboxRaw)).toContain("__loomEnc");
    expect(JSON.stringify(inboxRaw)).not.toContain(SECRET);

    const err = await plain.rt.notifyInbox(e2).then(
      () => undefined,
      (x: unknown) => x
    );
    expect(err).toBeInstanceOf(SealedPayloadUnreadableError);
    const typed = err as SealedPayloadUnreadableError;
    expect([typed.executionId, typed.messageId, typed.topic]).toEqual([e2, "m2", "y"]);
    expect(typed.message).not.toContain('ciphertext":');
    expect(JSON.stringify(typed)).not.toContain("iv");
    // The log is untouched: nothing consumed, nothing resumed, the message still in the inbox.
    expect(await eventsOf(raw.eventStore, e2, "MESSAGE_CONSUMED")).toHaveLength(0);
    expect((await raw.eventStore.read(e2)).length).toBe(rawBefore);
    expect((await plain.rt.loadState(e2))?.status).toBe("suspended");
    expect(await raw.eventStore.read(inboxStreamId(e2))).toHaveLength(1);

    // A correctly configured node consumes it, intact.
    await sealed.rt.notifyInbox(e2);
    await until(async () => (await sealed.rt.loadState(e2))?.status === "completed");
    expect((await sealed.rt.loadState(e2))?.variables._output).toEqual({ y: { ssn: SECRET } });
    const consumed = await eventsOf(raw.eventStore, e2, "MESSAGE_CONSUMED");
    expect(consumed).toHaveLength(1);
    expect(JSON.stringify(consumed)).not.toContain(SECRET);
  });

  it("the LIVE path parks (does not fail) on a sealed message and reports the typed error", async () => {
    const { raw, sealed, plain } = twoNodes({ INBOX_MESSAGE: ["payload"] });
    const f = flow("w", async (ctx) => {
      await ctx.suspend({ on: "Go" });
      const y = unwrapTainted(await ctx.receive<unknown>("y"));
      return { y };
    });
    sealed.rt.registerFlow(f.definition, f.runner);
    plain.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await sealed.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await sealed.rt.send(e, { topic: "y", payload: { ssn: SECRET }, messageId: "m1" });
    // The un-configured node resumes the owner: its receive reads the sealed message.
    await plain.rt.resume(e, { eventType: "Go", payload: null });
    await until(() => plain.storageErrors.some((x) => x instanceof SealedPayloadUnreadableError));
    expect((await plain.rt.loadState(e))?.status).toBe("suspended"); // parked, not failed
    expect(await eventsOf(raw.eventStore, e, "MESSAGE_CONSUMED")).toHaveLength(0);
    expect(await eventsOf(raw.eventStore, e, "EXECUTION_FAILED")).toHaveLength(0);
    expect(await raw.eventStore.read(inboxStreamId(e))).toHaveLength(1);
    // The configured node picks it up.
    await sealed.rt.notifyInbox(e);
    await until(async () => (await sealed.rt.loadState(e))?.status === "completed");
    expect((await sealed.rt.loadState(e))?.variables._output).toEqual({ y: { ssn: SECRET } });
  });

  it("a NESTED sealed field is caught", async () => {
    const { raw, sealed, plain } = twoNodes({ INBOX_MESSAGE: ["payload.secret"] });
    const f = flow("w", async (ctx) => {
      await ctx.suspend({ on: "Go" });
      return { y: unwrapTainted(await ctx.receive<unknown>("y")) };
    });
    sealed.rt.registerFlow(f.definition, f.runner);
    plain.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await sealed.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await sealed.rt.send(e, { topic: "y", payload: { open: 1, secret: SECRET }, messageId: "m1" });
    const stored = JSON.stringify(await raw.eventStore.read(inboxStreamId(e)));
    expect(stored).toContain("__loomEnc");
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain('"open":1'); // only the nested field is sealed
    await plain.rt.resume(e, { eventType: "Go", payload: null });
    await until(() => plain.storageErrors.some((x) => x instanceof SealedPayloadUnreadableError));
    expect(await eventsOf(raw.eventStore, e, "MESSAGE_CONSUMED")).toHaveLength(0);
    await sealed.rt.notifyInbox(e);
    await until(async () => (await sealed.rt.loadState(e))?.status === "completed");
    expect((await sealed.rt.loadState(e))?.variables._output).toEqual({
      y: { open: 1, secret: SECRET },
    });
  });

  it("send refuses a forged __loomEnc (top level, nested, in an array) and keeps look-alikes", async () => {
    // No crypto on this node at all: the ingest rule does not depend on a plugin being present.
    const h = build();
    const g = flow("g", async (ctx) => {
      await ctx.suspend({ on: "Go" });
      return unwrapTainted(await ctx.receive<unknown>("y"));
    });
    h.rt.registerFlow(g.definition, g.runner);
    const e = id();
    await (await h.rt.start(g, {}, { executionId: e })).waitForSuspend();
    const env = { __loomEnc: "loom/aes-256-gcm", iv: "AA", ct: "AA", tag: "AA" };
    const viaToJson = { x: { toJSON: () => ({ __loomEnc: "loom/aes-256-gcm", iv: "AA" }) } };
    for (const forged of [env, { a: { b: [env] } }, [env], viaToJson]) {
      await expect(
        h.rt.send(e, { topic: "y", payload: forged, messageId: "f" })
      ).rejects.toBeInstanceOf(InboxMessageRefusedError);
    }
    expect(await h.eventStore.read(inboxStreamId(e))).toHaveLength(0);
    // A non-string `__loomEnc` is not an envelope (the predicate is "own key, STRING value").
    const oks = [{ x_loomEnc: 1 }, { "__loomEnc ": 1 }, "__loomEnc", { __loomEnc: 1 }];
    for (const [i, ok] of oks.entries()) {
      await h.rt.send(e, { topic: "y", payload: ok, messageId: `ok${i}` });
    }
    expect(await h.eventStore.read(inboxStreamId(e))).toHaveLength(4);
  });

  it("a deep or huge payload cannot blow the stack or hang the walk", () => {
    // 200k levels deep: iterative, bounded, fail closed.
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 200_000; i++) deep = { n: deep };
    expect(sealedEnvelopeIn(deep)).toBe("unverified");
    // Modest depth well inside the budget is walked fully, and finds a buried envelope.
    let mid: Record<string, unknown> = { __loomEnc: "x" };
    for (let i = 0; i < 20_000; i++) mid = { n: mid };
    expect(sealedEnvelopeIn(mid)).toBe("sealed");
    expect(sealedEnvelopeIn({ a: [1, "s", null, { b: 2 }] })).toBe("clean");
    // Wide: more nodes than the budget.
    const wide = Array.from({ length: SEALED_WALK_BUDGET + 10 }, () => ({}));
    expect(sealedEnvelopeIn(wide)).toBe("unverified");
    // A cycle (an in-process store may hold one) ends at the budget, never loops.
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(sealedEnvelopeIn(cyc)).toBe("unverified");
    // An unverifiable payload is not delivered either (fail closed), and says so.
    expect(() =>
      assertDeliverable("e", { inboxSeq: 1, topic: "t", messageId: "m", payload: wide, sender: {} })
    ).toThrow(SealedPayloadUnreadableError);
    // Inherited keys are not envelopes.
    expect(sealedEnvelopeIn(Object.create({ __loomEnc: "x" }))).toBe("clean");
    // Only a STRING value is an envelope.
    expect(sealedEnvelopeIn({ __loomEnc: 1 })).toBe("clean");
    expect(sealedEnvelopeIn({ __loomEnc: { a: 1 } })).toBe("clean");
    expect(sealedEnvelopeIn({ __loomEnc: "loom/aes-256-gcm" })).toBe("sealed");
  });

  it("send refuses a payload too large to check", async () => {
    const h = build({ inboxMaxPayloadBytes: 10_000_000 });
    const g = flow("g", async (ctx) => {
      await ctx.suspend({ on: "Go" });
      return unwrapTainted(await ctx.receive<unknown>("y"));
    });
    h.rt.registerFlow(g.definition, g.runner);
    const e = id();
    await (await h.rt.start(g, {}, { executionId: e })).waitForSuspend();
    const wide = Array.from({ length: SEALED_WALK_BUDGET + 10 }, () => ({}));
    await expect(
      h.rt.send(e, { topic: "y", payload: wide, messageId: "w" })
    ).rejects.toBeInstanceOf(InboxMessageRefusedError);
  });

  // A flow whose receive is answered BEFORE a later gate, so a resume of that gate REPLAYS the answer.
  const replayFlow = (swallow = false) =>
    flow("w", async (ctx) => {
      let y: unknown;
      try {
        y = unwrapTainted(await ctx.receive<unknown>("y"));
      } catch (e) {
        if (!swallow) throw e;
        y = "swallowed";
      }
      await ctx.suspend({ on: "Go" });
      return { y };
    });

  for (const swallow of [false, true]) {
    it(`REPLAY on a node that cannot open the recorded answer is refused, appends nothing, and a capable node completes it${swallow ? " (flow swallows the rejection)" : ""}`, async () => {
      const { raw, sealed } = twoNodes({ INBOX_MESSAGE: ["payload"] });
      // The plain node folds from the log: its own snapshot store (a shared one would hand it the
      // capable node's plaintext checkpoint, the residual ADR 0130 documents).
      const plain = build({}, { ...raw, snapshotStore: new InMemoryAsyncSnapshotStore() });
      const f = replayFlow(swallow);
      sealed.rt.registerFlow(f.definition, f.runner);
      plain.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await sealed.rt.start(f, {}, { executionId: e })).waitForSuspend();
      await sealed.rt.send(e, { topic: "y", payload: { ssn: SECRET }, messageId: "m1" });
      await until(async () => (await eventsOf(raw.eventStore, e, "MESSAGE_CONSUMED")).length === 1);
      await until(async () => (await sealed.rt.loadState(e))?.suspendedOn?.on === "Go");
      expect(JSON.stringify(await eventsOf(raw.eventStore, e, "MESSAGE_CONSUMED"))).toContain(
        "__loomEnc"
      );

      const handle = await plain.rt.resume(e, { eventType: "Go", payload: null });
      const refused = await handle.waitForCompletion().then(
        () => undefined,
        (x: unknown) => x
      );
      expect(refused).toBeInstanceOf(SealedPayloadUnreadableError);
      expect((refused as SealedPayloadUnreadableError).recorded).toBe(true);
      expect(JSON.stringify(refused)).not.toContain("ciphertext");
      const kinds = (await raw.eventStore.read(e)).map((x) => x.eventType);
      // Nothing from the refused attempt: no completion, no failure, no second park, no step.
      for (const k of ["EXECUTION_COMPLETED", "EXECUTION_FAILED", "STEP_COMPLETED"]) {
        expect(kinds).not.toContain(k);
      }
      expect(kinds.filter((k) => k === "EXECUTION_SUSPENDED")).toHaveLength(2); // receive park + Go park
      const sizeAfterRefusal = kinds.length;

      // A capable node re-drives the (running) execution and completes it correctly.
      const summary = await recoverAbandoned(sealed.rt, {
        source: raw.eventStore,
        isAbandoned: () => true,
      });
      expect(summary.recovered).toBeGreaterThanOrEqual(1);
      await until(async () => (await sealed.rt.loadState(e))?.status === "completed");
      expect((await sealed.rt.loadState(e))?.variables._output).toEqual({
        y: { ssn: SECRET }, // the swallow happened only on the refused attempt
      });
      expect(sizeAfterRefusal).toBeLessThan((await raw.eventStore.read(e)).length);
    });
  }

  it("an OLD log with an already-journaled plaintext answer replays unchanged (a plain node)", async () => {
    const plainA = build();
    const f = replayFlow();
    plainA.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await plainA.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await plainA.rt.send(e, { topic: "y", payload: { ssn: SECRET }, messageId: "m1" });
    await until(async () => (await plainA.rt.loadState(e))?.suspendedOn?.on === "Go");
    expect(JSON.stringify(await eventsOf(plainA.eventStore, e, "MESSAGE_CONSUMED"))).toContain(
      SECRET
    );
    // Another node, no checkpoint, replays the plaintext answer.
    const plainB = build(
      {},
      {
        eventStore: plainA.eventStore,
        timers: plainA.timers,
        snapshotStore: new InMemoryAsyncSnapshotStore(),
      }
    );
    plainB.rt.registerFlow(f.definition, f.runner);
    await (await plainB.rt.resume(e, { eventType: "Go", payload: null })).waitForCompletion();
    expect((await plainB.rt.loadState(e))?.variables._output).toEqual({ y: { ssn: SECRET } });
    expect(plainB.warnings.filter((w) => w.includes("REFUSED"))).toEqual([]);
  });

  it("a live refusal leaves a durable wake row and a capable node's TimerService delivers it", async () => {
    const { raw, sealed, plain } = twoNodes({ INBOX_MESSAGE: ["payload"] });
    const f = flow("w", async (ctx) => {
      await ctx.suspend({ on: "Go" });
      return { y: unwrapTainted(await ctx.receive<unknown>("y")) };
    });
    sealed.rt.registerFlow(f.definition, f.runner);
    plain.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await sealed.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await sealed.rt.send(e, { topic: "y", payload: { ssn: SECRET }, messageId: "m1" });
    // send's own wake on the capable node may leave/consume rows: start from a clean slate.
    await until(async () => (await sealed.rt.loadState(e))?.status === "suspended");
    await raw.timers.due(Number.MAX_SAFE_INTEGER).then(async (rows) => {
      for (const r of rows) await raw.timers.complete(r.executionId, r.wakeAt);
    });
    await plain.rt.resume(e, { eventType: "Go", payload: null });
    await until(() => plain.storageErrors.some((x) => x instanceof SealedPayloadUnreadableError));
    await until(async () =>
      (await raw.timers.due(Number.MAX_SAFE_INTEGER)).some(
        (r) => r.executionId === e && r.wakeAt === INBOX_WAKE_AT
      )
    );
    await new TimerService(sealed.rt, raw.timers).tick(Date.now() + 1);
    await until(async () => (await sealed.rt.loadState(e))?.status === "completed");
    expect((await sealed.rt.loadState(e))?.variables._output).toEqual({ y: { ssn: SECRET } });
  });

  it("an incapable node's TimerService backs off: bounded fires and error reports, row never retired", async () => {
    const { raw, sealed, plain } = twoNodes({ INBOX_MESSAGE: ["payload"] });
    const f = receiveFlow();
    sealed.rt.registerFlow(f.definition, f.runner);
    plain.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await sealed.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await sealed.rt.notifyInbox(e); // settle the owner's own post-park read before the raw append
    await sealed.eventStore.append({
      executionId: inboxStreamId(e),
      workflowId: "__loom_inbox__",
      sequence: 0,
      eventType: "INBOX_MESSAGE",
      timestamp: Date.now(),
      payload: { topic: "y", messageId: "m1", payload: { ssn: SECRET }, sender: {} },
    } as never);
    await raw.timers.schedule({ executionId: e, wakeAt: INBOX_WAKE_AT });
    let clock = 1_000_000;
    const errors: unknown[] = [];
    const svc = new TimerService(plain.rt, raw.timers, {
      now: () => clock,
      onError: (_id: string, err: unknown) => errors.push(err),
      redriveBackoff: { baseMs: 100, capMs: 10_000, random: () => 1 },
    });
    let fires = 0;
    const real = plain.rt.notifyInboxDetailed.bind(plain.rt);
    plain.rt.notifyInboxDetailed = (...a: Parameters<typeof real>) => {
      fires++;
      return real(...a);
    };
    const POLLS = 200;
    for (let i = 0; i < POLLS; i++) {
      clock += 50; // 10 s of 50 ms polls
      await svc.tick(clock);
    }
    expect(fires).toBeGreaterThan(0);
    expect(fires).toBeLessThanOrEqual(10); // unbounded would be ~POLLS
    expect(errors.length).toBeLessThanOrEqual(2);
    expect(errors.every((x) => x instanceof SealedPayloadUnreadableError)).toBe(true);
    // The row was never retired: a capable node still sees it.
    expect(
      (await raw.timers.due(Number.MAX_SAFE_INTEGER)).some((r) => r.wakeAt === INBOX_WAKE_AT)
    ).toBe(true);
  });
});
