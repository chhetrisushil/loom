import {
  type EventStore,
  InMemoryAsyncEventStore,
  InMemoryTimerStore,
  quarantineStreamId,
} from "@loom/event-runtime";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import {
  OP,
  collector,
  consumedOf,
  eventsByKind,
  keyOf,
  put,
  sealingStore,
} from "./__tests__/quarantineHarness";
import { build, until } from "./__tests__/r2Harness";
import { InboxQuarantineRefusedError } from "./types";

// ADR 0130 residuals D9 / S5, fix round 2: regression tests for the review's reproduced findings.

let n = 0;
const id = () => `hd-${++n}-${Math.random().toString(36).slice(2, 6)}`;
const memRaw = () => ({
  eventStore: new InMemoryAsyncEventStore() as EventStore,
  timers: new InMemoryTimerStore(),
});
type Harness = ReturnType<typeof build>;
const parked = (h: Harness, e: string) =>
  until(
    async () => (await h.rt.loadState(e, h.rt.systemOptions() as never))?.status === "suspended",
    15_000
  );

/** A store view that, ONCE armed, lets the next append to a quarantine stream land and then PAUSES. */
function pauseAfterCopy(inner: EventStore) {
  let armed = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let signal!: () => void;
  const paused = new Promise<void>((r) => {
    signal = r;
  });
  const view = new Proxy(inner, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function") return v;
      const fn = (v as (...a: unknown[]) => unknown).bind(target);
      if (prop !== "append") return fn;
      return async (...a: unknown[]) => {
        const out = await fn(...a);
        if (
          armed &&
          String((a[0] as { executionId: string }).executionId).startsWith("__loom_quarantine__:")
        ) {
          armed = false;
          signal();
          await gate;
        }
        return out;
      };
    },
  });
  return {
    store: view as EventStore,
    arm: () => {
      armed = true;
    },
    paused,
    release,
  };
}

describe("P1-1: a copy in flight (appended, its fact not yet landed) is never trimmed by another hold", () => {
  it("B1 copies x1, B2 quarantines y1 and trims: x1 stays deliverable", async () => {
    const raw = memRaw();
    const keys = new InMemoryKeyStore();
    const sealed = sealingStore(raw.eventStore, keys);
    const a = build({}, { ...raw, eventStore: sealed });
    const b0 = build({}, { ...raw });
    const b2 = build({}, { ...raw });
    const pause = pauseAfterCopy(raw.eventStore);
    const b1 = build({}, { ...raw, eventStore: pause.store });
    const f = collector(3, ["w", "x", "y"]);
    for (const h of [a, b0, b1, b2]) h.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await parked(a, e);
    // warm-up: a hold that is discarded leaves copy seq 0 behind (so a later trim has something to cut)
    await put(sealed, e, { topic: "w", messageId: "w1", payload: { v: "W" } });
    await b0.rt.quarantineInbox(e, { topic: "w" }, { principal: OP });
    await b0.rt.releaseInbox(
      e,
      { topic: "w", messageId: "w1", disposition: "discard" },
      { principal: OP }
    );
    await put(sealed, e, { topic: "x", messageId: "x1", payload: { v: "X" } });
    await put(sealed, e, { topic: "y", messageId: "y1", payload: { v: "Y" } });
    pause.arm();
    const slow = b1.rt.quarantineInbox(e, { topic: "x" }, { principal: OP }).catch((x) => x);
    await pause.paused; // B1's copy of x1 is in the stream; its INBOX_QUARANTINED has not landed
    await b2.rt.quarantineInbox(e, { topic: "y" }, { principal: OP });
    pause.release();
    const r = await slow;
    expect(r).not.toBeInstanceOf(Error);
    const q = (await a.rt.loadState(e))?.variables._quarantined as Record<
      string,
      Array<{ heldAt: number; key: string }>
    >;
    const stream = await raw.eventStore.read(quarantineStreamId(e));
    for (const t of ["x", "y"]) {
      const entry = q[t]?.[0];
      expect(entry, `topic ${t} held`).toBeDefined();
      expect(
        stream.find((s) => s.sequence === entry?.heldAt),
        `topic ${t}: the copy at heldAt ${entry?.heldAt} still exists`
      ).toBeDefined();
    }
    // and the capable node delivers both, the message is not stranded
    await a.rt.notifyInbox(e);
    await until(async () => consumedOf(await raw.eventStore.read(e)).length >= 2);
    const keysDelivered = consumedOf(await raw.eventStore.read(e)).map((c) => c.messageId);
    expect(keysDelivered).toContain(keyOf("x1"));
    expect(keysDelivered).toContain(keyOf("y1"));
  });
});

describe("P1-2: a delivered key is never delivered again by a release", () => {
  it("a retry of a held id: the second hold is a duplicate, not a second copy of the first", async () => {
    const raw = memRaw();
    const keys = new InMemoryKeyStore();
    const sealed = sealingStore(raw.eventStore, keys);
    const a = build({}, { ...raw, eventStore: sealed });
    const b = build({}, { ...raw });
    const f = collector(2, ["a"]);
    for (const h of [a, b]) h.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await parked(a, e);
    await put(sealed, e, { topic: "a", messageId: "m1", payload: { v: "first" } });
    await put(sealed, e, { topic: "a", messageId: "m1", payload: { v: "retry" } });
    await put(raw.eventStore, e, { topic: "a", messageId: "m2", payload: "plain" });
    await b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP });
    await b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP }).catch(() => undefined);
    await a.rt.notifyInbox(e);
    await until(async () => (await a.rt.loadState(e))?.status === "completed", 15_000);
    expect((await a.rt.loadState(e))?.variables._output).toEqual([
      ["a", { v: "first" }],
      ["a", "plain"],
    ]);
  });

  it("a same-key message delivered normally on another topic while K is held: the release is a duplicate", async () => {
    const raw = memRaw();
    const keys = new InMemoryKeyStore();
    const sealed = sealingStore(raw.eventStore, keys);
    const a = build({}, { ...raw, eventStore: sealed });
    const b = build({}, { ...raw });
    const f = collector(3, ["b", "a"]);
    for (const h of [a, b]) h.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await parked(a, e);
    await put(sealed, e, { topic: "a", messageId: "m1", payload: { v: "held" } });
    await b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP });
    await put(raw.eventStore, e, { topic: "b", messageId: "m1", payload: "pb1" });
    await put(raw.eventStore, e, { topic: "b", messageId: "m2", payload: "pb2" });
    await a.rt.notifyInbox(e);
    await until(async () => consumedOf(await raw.eventStore.read(e)).length >= 3);
    await a.rt.notifyInbox(e);
    const consumed = consumedOf(await a.eventStore.read(e));
    const delivered = consumed.filter((c) => c.payload !== null).map((c) => c.payload);
    expect(delivered).toEqual(["pb1", "pb2"]);
    expect((await eventsByKind(raw.eventStore, e, "INBOX_RELEASED")).length).toBeLessThanOrEqual(1);
    expect((await a.rt.loadState(e))?.status).toBe("suspended");
    expect((await a.rt.loadState(e))?.variables._quarantined).toBeUndefined();
  });
});

// ── P3-1: a copy is matched by its original position as well as its key ──────────────────────────
describe("P3-1: a stale copy of the same key is never reused or delivered", () => {
  const env = (seq: number, payload: unknown) =>
    ({
      id: `inbox-${seq}`,
      executionId: "__loom_inbox__:c",
      workflowId: "__loom_inbox__",
      sequence: seq,
      eventType: "INBOX_MESSAGE",
      timestamp: 1,
      payload: { topic: "t", messageId: "m", payload, sender: {} },
    }) as never;
  it("two messages with one key get two copies; a read at the wrong position is a mismatch", async () => {
    const { appendQuarantineCopy, readQuarantineCopy } = await import("./quarantine");
    const { dedupeKeyOf } = await import("./inbox");
    const store = new InMemoryAsyncEventStore() as EventStore;
    const key = dedupeKeyOf({ messageId: "m", sender: {} });
    const first = await appendQuarantineCopy(store, "c", env(0, "old"), key, "t", 0);
    const second = await appendQuarantineCopy(store, "c", env(7, "new"), key, "t", 7);
    expect(second).not.toBe(first);
    expect(await appendQuarantineCopy(store, "c", env(7, "new"), key, "t", 7)).toBe(second); // still idempotent
    const entry = (heldAt: number, inboxSeq: number) => ({
      key,
      inboxSeq,
      heldAt,
      state: "held" as const,
    });
    const ok = await readQuarantineCopy(store, "c", entry(second, 7));
    expect(ok.ok).toBe(true);
    const stale = await readQuarantineCopy(store, "c", entry(first, 7));
    expect(stale).toMatchObject({ ok: false, why: "mismatch" });
  });
});

// ── P2-1: fork ─────────────────────────────────────────────────────────────────────────────────────
describe("P2-1: fork verifies every held copy before writing, and leaves no orphan on failure", () => {
  async function scene() {
    const raw = memRaw();
    const keys = new InMemoryKeyStore();
    const shared = () => "shared";
    const a = build({}, { ...raw, eventStore: sealingStore(raw.eventStore, keys, shared) });
    const b = build({}, { ...raw });
    const f = collector(1, ["a"]);
    for (const h of [a, b]) h.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await parked(a, e);
    await put(a.eventStore, e, { topic: "a", messageId: "a1", payload: { v: "S1" } });
    await b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP });
    const at = (await a.rt.loadState(e))?.sequence as number;
    return { raw, keys, a, b, e, f, at, shared };
  }
  const children = async (raw: ReturnType<typeof memRaw>, before: string[]) =>
    ((await raw.eventStore.listExecutions?.()) ?? []).filter((x) => !before.includes(x));

  it("a hold whose copy is gone from the parent's stream refuses the fork typed, writing nothing", async () => {
    const s = await scene();
    await s.raw.eventStore.deleteExecution?.(quarantineStreamId(s.e)); // the copy a hold names vanished
    const before = (await s.raw.eventStore.listExecutions?.()) ?? [];
    const err = await s.a.rt.fork(s.e, s.at).catch((x) => x);
    expect(err).toBeInstanceOf(InboxQuarantineRefusedError);
    expect(err.verb).toBe("fork");
    expect(await children(s.raw, before)).toEqual([]);
  });

  it("a hold whose copy is a DIFFERENT message (same heldAt) refuses the fork too", async () => {
    const s = await scene();
    // replace the copy with another message's envelope at the same sequence
    const stream = quarantineStreamId(s.e);
    const copies = await s.raw.eventStore.read(stream);
    const held = copies[copies.length - 1];
    await s.raw.eventStore.deleteExecution?.(stream);
    for (const c of copies) {
      await s.raw.eventStore.append(
        c === held
          ? ({ ...c, payload: { ...(c.payload as object), messageId: "other" } } as never)
          : c
      );
    }
    const before = (await s.raw.eventStore.listExecutions?.()) ?? [];
    const err = await s.a.rt.fork(s.e, s.at).catch((x) => x);
    expect(err).toBeInstanceOf(InboxQuarantineRefusedError);
    expect(await children(s.raw, before)).toEqual([]);
  });

  it("a failed main prefix copy does not orphan the child's quarantine stream", async () => {
    const s = await scene();
    const failing = new Proxy(s.raw.eventStore, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target) as unknown;
        if (typeof v !== "function") return v;
        if (prop === "copyPrefix") {
          return async (from: string, ...rest: unknown[]) => {
            if (!from.startsWith("__loom_quarantine__:")) throw new Error("main copy failed");
            return (v as (...a: unknown[]) => unknown).call(target, from, ...rest);
          };
        }
        return (v as (...a: unknown[]) => unknown).bind(target);
      },
    }) as EventStore;
    const flaky = build({}, { ...s.raw, eventStore: sealingStore(failing, s.keys, s.shared) });
    flaky.rt.registerFlow(s.f.definition, s.f.runner);
    const before = (await s.raw.eventStore.listExecutions?.()) ?? [];
    const err = await flaky.rt.fork(s.e, s.at).catch((x) => x);
    expect((err as Error).message).toContain("main copy failed");
    // (the fork's seeded inbox floors are a separate, older concern; this pins the quarantine stream)
    expect(
      (await children(s.raw, before)).filter((x) => x.startsWith("__loom_quarantine__:"))
    ).toEqual([]);
  });
});

// ── P3-2: the fold's cap ───────────────────────────────────────────────────────────────────────────
describe("P3-2: concurrent quarantiners at the fold's cap", () => {
  it("the loser gets a typed refusal; a hold the fold would drop is never reported as done", async () => {
    const { QUARANTINE_FOLD_CAP } = await import("@loom/replay-vm");
    const raw = memRaw();
    const keys = new InMemoryKeyStore();
    const sealed = sealingStore(raw.eventStore, keys);
    const a = build({}, { ...raw, eventStore: sealed });
    const mk = () => build({ inboxQuarantineMax: QUARANTINE_FOLD_CAP }, { ...raw });
    const [b1, b2] = [mk(), mk()];
    const f = collector(3, ["a", "b", "c"]);
    for (const h of [a, b1, b2]) h.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await parked(a, e);
    // fill the fold to one slot below its cap with kernel-stamped holds on topic "a"
    const st = (await a.rt.loadState(e)) as { sequence: number; workflowId: string };
    const facts = Array.from({ length: QUARANTINE_FOLD_CAP - 1 }, (_, i) => ({
      id: `${e}-seed-${i}`,
      executionId: e,
      workflowId: st.workflowId,
      sequence: st.sequence + 1 + i,
      eventType: "INBOX_QUARANTINED",
      timestamp: Date.now(),
      metadata: { kernel: true },
      payload: {
        topic: "a",
        inboxSeq: i,
        key: `k${i}`,
        messageId: `m${i}`,
        heldAt: i + 1,
        operator: {},
      },
    }));
    await raw.eventStore.appendBatch?.(facts as never);
    await put(sealed, e, { topic: "b", messageId: "b1", payload: { v: "B" } });
    await put(sealed, e, { topic: "c", messageId: "c1", payload: { v: "C" } });
    const results = await Promise.allSettled([
      b1.rt.quarantineInbox(e, { topic: "b" }, { principal: OP }),
      b2.rt.quarantineInbox(e, { topic: "c" }, { principal: OP }),
    ]);
    const held = Object.values(
      ((await a.rt.loadState(e))?.variables._quarantined ?? {}) as Record<string, unknown[]>
    ).reduce((n, q) => n + q.length, 0);
    expect(held).toBeLessThanOrEqual(QUARANTINE_FOLD_CAP);
    // every verb that reported success is really in the fold, and the other one was refused typed
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(held).toBe(QUARANTINE_FOLD_CAP - 1 + ok);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(InboxQuarantineRefusedError);
        expect(r.reason.reason).toBe("invalid");
      }
    }
    expect(ok).toBe(1);
  }, 30_000);
});

// ── P3-3: retention ────────────────────────────────────────────────────────────────────────────────
describe("P3-3: a disposed message's ciphertext is gone at rest", () => {
  async function held() {
    const raw = memRaw();
    const keys = new InMemoryKeyStore();
    const sealed = sealingStore(raw.eventStore, keys);
    const a = build({}, { ...raw, eventStore: sealed });
    const b = build({}, { ...raw });
    const f = collector(3, ["a"]);
    for (const h of [a, b]) h.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await parked(a, e);
    await put(sealed, e, { topic: "a", messageId: "a1", payload: { v: "SECRET-1" } });
    await b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP });
    return { raw, a, b, e, sealed };
  }
  const atRest = async (raw: ReturnType<typeof memRaw>, e: string) =>
    JSON.stringify(await raw.eventStore.read(quarantineStreamId(e)));

  it("a discarded message leaves only the payload-free anchor behind", async () => {
    const s = await held();
    expect(await atRest(s.raw, s.e)).toContain("__loomEnc");
    await s.b.rt.releaseInbox(
      s.e,
      { topic: "a", messageId: "a1", disposition: "discard" },
      { principal: OP }
    );
    const left = await s.raw.eventStore.read(quarantineStreamId(s.e));
    expect(left.map((x) => x.sequence)).toEqual([0]);
    expect(await atRest(s.raw, s.e)).not.toContain("__loomEnc");
  });

  it("a message delivered by an auto-release is gone once the owner parks again", async () => {
    const s = await held();
    await s.a.rt.notifyInbox(s.e);
    await until(async () => consumedOf(await s.raw.eventStore.read(s.e)).length === 1);
    await until(async () => !(await atRest(s.raw, s.e)).includes("__loomEnc"));
    expect((await s.raw.eventStore.read(quarantineStreamId(s.e))).map((x) => x.sequence)).toEqual([
      0,
    ]);
  });
});

// ── P3-4: releaseInbox idempotence ─────────────────────────────────────────────────────────────────
describe("P3-4: the idempotent repeat of a release", () => {
  it("a release journaled before a continue-as-new is still a no-op afterwards", async () => {
    const raw = memRaw();
    const keys = new InMemoryKeyStore();
    const on = { continueAsNewEnabled: true, inboxAutoRelease: false } as const;
    const a = build(on, { ...raw, eventStore: sealingStore(raw.eventStore, keys) });
    const b = build({ continueAsNewEnabled: true }, { ...raw });
    const f = (await import("./__tests__/r2Harness")).flow<{ gen?: number }, unknown>(
      "rot",
      async (ctx, input) => {
        if (input?.gen === undefined) {
          await ctx.receive("a");
          await ctx.receive("go");
          return ctx.continueAsNew({ gen: 1 });
        }
        return ctx.receive("never");
      }
    );
    for (const h of [a, b]) h.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await parked(a, e);
    await put(a.eventStore, e, { topic: "a", messageId: "a1", payload: { v: "S1" } });
    await b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP });
    const first = await a.rt.releaseInbox(e, { topic: "a", messageId: "a1" }, { principal: OP });
    expect(first.changed).toBe(true);
    await until(async () => consumedOf(await raw.eventStore.read(e)).length === 1);
    await a.rt.send(e, { topic: "go", payload: 1 });
    await until(async () => (await a.rt.loadState(`${e}~1`))?.status === "suspended");
    const again = await a.rt.releaseInbox(e, { topic: "a", messageId: "a1" }, { principal: OP });
    expect(again.changed).toBe(false);
  });

  it("matches the SENDER with the id: another sender's release is not this message's", async () => {
    const raw = memRaw();
    const keys = new InMemoryKeyStore();
    const sealed = sealingStore(raw.eventStore, keys);
    const a = build({ inboxAutoRelease: false }, { ...raw, eventStore: sealed });
    const b = build({}, { ...raw });
    const f = collector(5, ["a"]);
    for (const h of [a, b]) h.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await parked(a, e);
    const s1 = { actor: "alice" };
    const s2 = { actor: "bob" };
    await put(sealed, e, { topic: "a", messageId: "m", payload: { v: "alice" }, sender: s1 });
    await put(sealed, e, { topic: "a", messageId: "m", payload: { v: "bob" }, sender: s2 });
    await b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP }); // alice's m
    await parked(a, e);
    await b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP }).catch(() => undefined); // bob's m
    await parked(a, e);
    // alice's m is released (and delivered); a repeat naming BOB's m must not read as "already released"
    await a.rt.releaseInbox(e, { topic: "a", messageId: "m", sender: s1 }, { principal: OP });
    await until(async () => consumedOf(await raw.eventStore.read(e)).length >= 1);
    await parked(a, e);
    const repeatAlice = await a.rt.releaseInbox(
      e,
      { topic: "a", messageId: "m", sender: s1 },
      { principal: OP }
    );
    expect(repeatAlice.changed).toBe(false);
    // bob's m is a DIFFERENT held message (another dedupe key): its release is a real release, not
    // alice's repeat
    const bob = await a.rt.releaseInbox(
      e,
      { topic: "a", messageId: "m", sender: s2 },
      { principal: OP }
    );
    expect(bob.changed).toBe(true);
    await until(async () => consumedOf(await raw.eventStore.read(e)).length >= 2);
    // with both released, the id alone no longer says which sender's message is meant
    await parked(a, e);
    const vague = await a.rt
      .releaseInbox(e, { topic: "a", messageId: "m" }, { principal: OP })
      .catch((x) => x);
    expect(vague).toBeInstanceOf(InboxQuarantineRefusedError);
    expect(vague.reason).toBe("invalid");
    const exact = await a.rt.releaseInbox(
      e,
      { topic: "a", messageId: "m", sender: s2 },
      { principal: OP }
    );
    expect(exact.changed).toBe(false);
  });

  it("does not read the owner's log from sequence 0 on a repeat", async () => {
    const raw = memRaw();
    const keys = new InMemoryKeyStore();
    const sealed = sealingStore(raw.eventStore, keys);
    let rangeRead = 0; // envelopes returned by bounded range reads of the owner's log
    let rangeCalls = 0;
    let maxSpan = 0;
    const counting = new Proxy(raw.eventStore, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target) as unknown;
        if (typeof v !== "function") return v;
        const fn = (v as (...x: unknown[]) => Promise<unknown>).bind(target);
        if (prop !== "readFrom" && prop !== "readRange" && prop !== "read") return fn;
        return async (...x: unknown[]) => {
          const out = (await fn(...x)) as unknown[];
          if (prop === "readRange" && String(x[0]) === counting.owner && out.length > 1) {
            rangeRead += out.length;
            rangeCalls++;
            maxSpan = Math.max(maxSpan, out.length);
          }
          return out;
        };
      },
    }) as EventStore & { owner?: string };
    const a = build(
      { inboxAutoRelease: false },
      { ...raw, eventStore: sealingStore(counting, keys) }
    );
    const b = build({}, { ...raw });
    const f = collector(400, ["a", "pad"]);
    for (const h of [a, b]) h.rt.registerFlow(f.definition, f.runner);
    const e = id();
    counting.owner = e;
    await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await parked(a, e);
    for (let i = 0; i < 150; i++) {
      await put(raw.eventStore, e, { topic: "pad", messageId: `p${i}`, payload: i });
      await b.rt.notifyInbox(e); // the incapable node delivers the plain padding (a capable one would seal the log)
    }
    await until(async () => consumedOf(await raw.eventStore.read(e)).length >= 150, 30_000);
    await parked(a, e);
    await put(sealed, e, { topic: "a", messageId: "a1", payload: { v: "S1" } });
    await b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP });
    await a.rt.releaseInbox(e, { topic: "a", messageId: "a1" }, { principal: OP });
    const total = (await raw.eventStore.read(e)).length;
    expect(total).toBeGreaterThan(150);
    // the repeat finds the release near the tail without a read of the whole (long) log
    rangeRead = 0;
    rangeCalls = 0;
    maxSpan = 0;
    const again = await a.rt.releaseInbox(e, { topic: "a", messageId: "a1" }, { principal: OP });
    expect(again.changed).toBe(false);
    // found by a BOUNDED backward search (one chunk reaches the release), not a read of the whole log
    expect(maxSpan).toBe(64); // one backward chunk
    expect(rangeRead).toBeLessThan(100); // not the 150+ events of the log
  }, 60_000);
});
