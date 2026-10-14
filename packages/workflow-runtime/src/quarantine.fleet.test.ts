import { unwrapTainted } from "@loom/classify";
import {
  type EventStore,
  InMemoryAsyncEventStore,
  InMemoryTimerStore,
  quarantineStreamId,
} from "@loom/event-runtime";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import {
  type Fault,
  OP,
  SimulatedCrash,
  collector,
  consumedOf,
  eventsByKind,
  faultStore,
  hasKind,
  keyOf,
  kindsOf,
  put,
  quarantineHead,
  sealingStore,
  wrongKeyNode,
} from "./__tests__/quarantineHarness";
import { build, flow, until } from "./__tests__/r2Harness";
import { executionAccessPolicy } from "./executionAccessPolicy";
import { createInboxSource, deleteInbox, readRegisteredTopics } from "./inbox";
import { recoverAbandoned } from "./recoverAbandoned";
import {
  ExecutionDeniedError,
  InboxQuarantineRefusedError,
  QuarantineHeldError,
  SealedPayloadUnreadableError,
} from "./types";

// ADR 0130 residuals D9 / S5 - races across nodes, crash points, TTL, erasure, fork, continue-as-new,
// per-topic streams, authorization and a seeded fleet scenario. Memory stores: the harness injects faults
// and pauses at chosen reads, which no SQL backend needs to re-prove (the kernel path is the same).

let n = 0;
const id = () => `fl-${++n}-${Math.random().toString(36).slice(2, 6)}`;
const memRaw = () => ({
  eventStore: new InMemoryAsyncEventStore() as EventStore,
  snapshotStore: new InMemoryAsyncSnapshotStore(),
  timers: new InMemoryTimerStore(),
});
type Raw = ReturnType<typeof memRaw>;
const isCrash = (err: unknown): boolean =>
  err instanceof SimulatedCrash || (err as { cause?: unknown })?.cause instanceof SimulatedCrash;
const parked = (
  h: {
    rt: {
      loadState: (id: string, o?: never) => Promise<{ status: string } | null>;
      systemOptions: () => unknown;
    };
  },
  e: string
) =>
  until(
    async () => (await h.rt.loadState(e, h.rt.systemOptions() as never))?.status === "suspended",
    15_000
  );
const completed = async (
  h: {
    rt: {
      loadState: (
        id: string
      ) => Promise<{ status: string; variables: Record<string, unknown> } | null>;
    };
  },
  e: string
) => {
  await until(async () => (await h.rt.loadState(e))?.status === "completed", 15_000);
  return (await h.rt.loadState(e))?.variables._output;
};

/** A store view that PAUSES the first read of a quarantine stream until `release()` (a paused notifier). */
function pausingReads(inner: EventStore) {
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
      if (prop !== "readRange" && prop !== "read" && prop !== "readFrom") return fn;
      return async (...a: unknown[]) => {
        const out = await fn(...a);
        if (armed && String(a[0]).startsWith("__loom_quarantine__:")) {
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

/** Parked on `topics`; a1 SEALED then plain a2 (and optionally more); B has quarantined a1. */
async function heldScene(
  opts: {
    raw?: Raw;
    total?: number;
    topics?: string[];
    a?: Record<string, unknown>;
    sealedStore?: (raw: Raw) => EventStore;
    subjectOf?: (e: never) => string;
    quarantine?: boolean;
    plain?: Array<[string, string, unknown]>;
  } = {}
) {
  const raw = opts.raw ?? memRaw();
  const keys = new InMemoryKeyStore();
  const mkA = (deps: Record<string, unknown> = opts.a ?? {}, store?: EventStore) =>
    build(deps, {
      ...raw,
      eventStore: sealingStore(
        store ?? opts.sealedStore?.(raw) ?? raw.eventStore,
        keys,
        opts.subjectOf
      ),
    });
  const a = mkA();
  const b = build({}, { ...raw });
  const f = collector(opts.total ?? 2, opts.topics ?? ["a"]);
  for (const h of [a, b]) h.rt.registerFlow(f.definition, f.runner);
  const e = id();
  await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
  await parked(a, e);
  await a.rt.notifyInbox(e);
  await put(a.eventStore, e, { topic: "a", messageId: "a1", payload: { v: "S1" } });
  for (const [t, m, p] of opts.plain ?? [["a", "a2", "P2"]]) {
    await put(raw.eventStore, e, { topic: t, messageId: m, payload: p });
  }
  if (opts.quarantine !== false) {
    await b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP });
  }
  return { raw, keys, a, b, e, f, mkA };
}

describe("races across nodes (paused notifier)", () => {
  it("auto vs auto: two capable nodes build the release; one append wins; a1 is delivered ONCE", async () => {
    const raw = memRaw();
    const p1 = pausingReads(raw.eventStore);
    const s = await heldScene({ raw, total: 2 });
    const a1 = build({}, { ...raw, eventStore: sealingStore(p1.store, s.keys) });
    a1.rt.registerFlow(s.f.definition, s.f.runner);
    p1.arm();
    const slow = a1.rt.notifyInbox(s.e).catch((x) => x);
    await p1.paused; // A1 read the copy and is about to build its batch
    const a2 = s.mkA();
    a2.rt.registerFlow(s.f.definition, s.f.runner);
    await a2.rt.notifyInbox(s.e);
    expect(await completed(a2, s.e)).toEqual([
      ["a", { v: "S1" }],
      ["a", "P2"],
    ]);
    p1.release();
    await slow;
    const log = await raw.eventStore.read(s.e);
    expect(consumedOf(log).filter((c) => c.messageId === keyOf("a1"))).toHaveLength(1);
    expect(log.filter((e) => e.eventType === "INBOX_RELEASED")).toHaveLength(1);
    expect(consumedOf(log).map((c) => c.inboxSeq)).toEqual([0, 1]);
  });

  it("auto vs a concurrent MANUAL deliver: one delivery, the loser is a no-op", async () => {
    const raw = memRaw();
    const p1 = pausingReads(raw.eventStore);
    const s = await heldScene({ raw, total: 2 });
    const a1 = build({}, { ...raw, eventStore: sealingStore(p1.store, s.keys) });
    a1.rt.registerFlow(s.f.definition, s.f.runner);
    p1.arm();
    const slow = a1.rt.notifyInbox(s.e).catch((x) => x);
    await p1.paused;
    const manual = s.mkA({ inboxAutoRelease: false });
    manual.rt.registerFlow(s.f.definition, s.f.runner);
    const r = await manual.rt.releaseInbox(s.e, { topic: "a", messageId: "a1" }, { principal: OP });
    expect(r.changed).toBe(true);
    await completed(manual, s.e);
    p1.release();
    await slow;
    const log = await raw.eventStore.read(s.e);
    expect(consumedOf(log).filter((c) => c.messageId === keyOf("a1"))).toHaveLength(1);
    const released = log.filter((e) => e.eventType === "INBOX_RELEASED");
    expect(released).toHaveLength(1);
    expect((released[0]?.payload as { operator?: unknown }).operator).toEqual(OP);
  });

  it("auto vs a concurrent DISCARD: either the discard wins (topic unblocked, a1 never delivered) or the auto wins (discard `invalid`, nothing dropped)", async () => {
    // discard wins: the paused auto batch is refused as stale and the notifier delivers the NEXT message
    {
      const raw = memRaw();
      const p1 = pausingReads(raw.eventStore);
      const s = await heldScene({ raw, total: 1 });
      const a1 = build({}, { ...raw, eventStore: sealingStore(p1.store, s.keys) });
      a1.rt.registerFlow(s.f.definition, s.f.runner);
      p1.arm();
      const slow = a1.rt.notifyInbox(s.e).catch((x) => x);
      await p1.paused;
      await s.b.rt.releaseInbox(
        s.e,
        { topic: "a", messageId: "a1", disposition: "discard" },
        { principal: OP }
      );
      p1.release();
      await slow;
      expect(await completed(a1, s.e)).toEqual([["a", "P2"]]);
      const log = await raw.eventStore.read(s.e);
      expect(consumedOf(log).map((c) => c.messageId)).not.toContain(keyOf("a1"));
      expect(
        log
          .filter((e) => e.eventType === "INBOX_RELEASED")
          .map((e) => (e.payload as { disposition: string }).disposition)
      ).toEqual(["discard"]);
    }
    // auto wins: the discard is invalid and drops nothing
    {
      const s = await heldScene({ total: 3 });
      await s.a.rt.notifyInbox(s.e);
      await until(
        async () => (await eventsByKind(s.raw.eventStore, s.e, "INBOX_RELEASED")).length === 1
      );
      await parked(s.a, s.e);
      // (the owner's log now holds a sealed delivery, so only a CAPABLE node can still act on it)
      const late = s.mkA({ inboxAutoRelease: false });
      const err = await late.rt
        .releaseInbox(
          s.e,
          { topic: "a", messageId: "a1", disposition: "discard" },
          { principal: OP }
        )
        .catch((x) => x);
      expect(err).toBeInstanceOf(InboxQuarantineRefusedError);
      expect(err.reason).toBe("invalid");
      expect(consumedOf(await s.raw.eventStore.read(s.e)).map((c) => c.messageId)).toEqual([
        keyOf("a1"),
        keyOf("a2"),
      ]);
    }
  });

  for (const autoRelease of [false, true]) {
    it(`a notifier whose batch PREDATES the hold is refused and refolds (autoRelease ${autoRelease}): a1 is ${autoRelease ? "delivered once, via the release" : "not delivered from the held topic"}`, async () => {
      const raw = memRaw();
      const keys = new InMemoryKeyStore();
      const sealed = sealingStore(raw.eventStore, keys);
      const real = createInboxSource(sealed);
      let armed = false;
      let signal!: () => void;
      const paused = new Promise<void>((r) => {
        signal = r;
      });
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const notifier = build(
        {
          inboxAutoRelease: autoRelease,
          inbox: async (chain, topic, after, limit) => {
            const page = await real(chain, topic, after, limit);
            if (armed && page.length > 0) {
              armed = false;
              signal();
              await gate;
            }
            return page;
          },
        },
        { ...raw, eventStore: sealed }
      );
      const b = build({}, { ...raw });
      const f = collector(1, ["a"]);
      for (const h of [notifier, b]) h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await notifier.rt.start(f, {}, { executionId: e })).waitForSuspend();
      await parked(notifier, e);
      await notifier.rt.notifyInbox(e);
      await put(sealed, e, { topic: "a", messageId: "a1", payload: { v: "S1" } });
      armed = true;
      const attempt = notifier.rt.notifyInbox(e).catch((x) => x);
      await paused; // the notifier built a batch consuming a1 from cursor -1
      await b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP });
      release();
      const outcome = await attempt;
      if (autoRelease) {
        expect(await completed(notifier, e)).toEqual([["a", { v: "S1" }]]);
        expect(consumedOf(await raw.eventStore.read(e))).toHaveLength(1);
        expect(await eventsByKind(raw.eventStore, e, "INBOX_RELEASED")).toHaveLength(1);
      } else {
        expect(outcome).toBeInstanceOf(QuarantineHeldError);
        expect(consumedOf(await raw.eventStore.read(e))).toHaveLength(0);
        expect((await notifier.rt.loadState(e))?.status).toBe("suspended");
      }
    });
  }

  it("the inverse: when the delivery lands first the quarantine is refused and nothing is held", async () => {
    const raw = memRaw();
    const keys = new InMemoryKeyStore();
    const sealed = sealingStore(raw.eventStore, keys);
    const real = createInboxSource(raw.eventStore);
    let armed = false;
    let signal!: () => void;
    const paused = new Promise<void>((r) => {
      signal = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = build({}, { ...raw, eventStore: sealed });
    const b = build(
      {
        inbox: async (chain, topic, after, limit) => {
          const page = await real(chain, topic, after, limit);
          if (armed && page.length > 0) {
            armed = false;
            signal();
            await gate;
          }
          return page;
        },
      },
      { ...raw }
    );
    const f = collector(2, ["a"]);
    for (const h of [a, b]) h.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await parked(a, e);
    await a.rt.notifyInbox(e);
    await put(sealed, e, { topic: "a", messageId: "a1", payload: { v: "S1" } });
    armed = true;
    const q = b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP }).catch((x) => x);
    await paused; // B read the head and is about to copy and journal
    await a.rt.notifyInbox(e); // A delivers a1 first
    await until(async () => consumedOf(await raw.eventStore.read(e)).length === 1);
    release();
    const err = await q;
    // B's view of the owner is now sealed (A's delivery): the denial-shaped refusal; a plain log would
    // give the typed `not-parked`/`invalid`. Either way: refused, nothing held.
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toHaveProperty("held");
    expect(await eventsByKind(raw.eventStore, e, "INBOX_QUARANTINED")).toHaveLength(0);
    expect((await a.rt.loadState(e))?.variables._quarantined).toBeUndefined();
  });

  it("two nodes quarantining the same head concurrently: exactly one fact and one copy", async () => {
    const s = await heldScene({ total: 2, quarantine: false });
    const b2 = build({}, { ...s.raw });
    b2.rt.registerFlow(s.f.definition, s.f.runner);
    const results = await Promise.allSettled([
      s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP }),
      b2.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP }),
    ]);
    expect(await eventsByKind(s.raw.eventStore, s.e, "INBOX_QUARANTINED")).toHaveLength(1);
    expect((await s.raw.eventStore.read(quarantineStreamId(s.e))).length).toBe(2); // anchor + one copy
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("crash points (fault store)", () => {
  /** A fleet over a raw store behind a fault injector; `fs.arm` picks the next crash. */
  async function crashScene(
    faults: Fault[] = [],
    opts: { a?: Record<string, unknown>; total?: number } = {}
  ) {
    const inner = memRaw();
    const fs = faultStore(inner.eventStore, faults);
    const raw: Raw = { ...inner, eventStore: fs.store };
    const s = await heldScene({
      raw,
      quarantine: false,
      total: opts.total ?? 2,
      ...(opts.a !== undefined && { a: opts.a }),
    });
    return { ...s, fs, inner };
  }

  it("(1) crash after the copy, before INBOX_QUARANTINED: an orphan copy, a retry reuses it, the hold lands exactly once", async () => {
    const s = await crashScene([{ match: hasKind("INBOX_QUARANTINED"), when: "before" }]);
    const err = await s.b.rt
      .quarantineInbox(s.e, { topic: "a" }, { principal: OP })
      .catch((x) => x);
    expect(isCrash(err)).toBe(true);
    expect(await quarantineHead(s.inner.eventStore, s.e)).toBe(1); // the orphan (after the anchor)
    expect(await eventsByKind(s.inner.eventStore, s.e, "INBOX_QUARANTINED")).toHaveLength(0);
    const again = await s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
    expect(again.heldAt).toBe(1);
    expect((await s.inner.eventStore.read(quarantineStreamId(s.e))).length).toBe(2); // no duplicate copy
    expect(await eventsByKind(s.inner.eventStore, s.e, "INBOX_QUARANTINED")).toHaveLength(1);
  });

  it("(2) crash after INBOX_QUARANTINED: another node sees the topic held and the copy retrievable at heldAt", async () => {
    const s = await crashScene([{ match: hasKind("INBOX_QUARANTINED"), when: "after" }]);
    await s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP }).catch(() => undefined);
    const other = s.mkA({}, s.inner.eventStore);
    other.rt.registerFlow(s.f.definition, s.f.runner);
    const st = await other.rt.loadState(s.e);
    expect((st?.variables._quarantined as Record<string, unknown[]>).a).toHaveLength(1);
    await other.rt.notifyInbox(s.e); // auto-release reads the copy at heldAt
    expect(await completed(other, s.e)).toEqual([
      ["a", { v: "S1" }],
      ["a", "P2"],
    ]);
  });

  it("(3) crash after a MANUAL INBOX_RELEASED, before the delivery: ANY node's wake-row poll delivers exactly once, in original order", async () => {
    const s = await crashScene([], { a: { inboxAutoRelease: false } });
    await s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
    s.fs.arm({ match: hasKind("EXECUTION_RESUMED"), when: "before", times: 1 });
    await s.a.rt.releaseInbox(s.e, { topic: "a", messageId: "a1" }, { principal: OP }); // the release landed; the delivery crashed
    const log0 = await kindsOf(s.inner.eventStore, s.e);
    expect(log0).toContain("INBOX_RELEASED");
    expect(log0).not.toContain("MESSAGE_CONSUMED");
    const survivor = s.mkA({ inboxAutoRelease: false }, s.inner.eventStore);
    survivor.rt.registerFlow(s.f.definition, s.f.runner);
    const svc = new TimerService(survivor.rt, s.inner.timers);
    await svc.tick(Date.now());
    expect(await completed(survivor, s.e)).toEqual([
      ["a", { v: "S1" }],
      ["a", "P2"],
    ]);
    expect(
      consumedOf(await s.inner.eventStore.read(s.e)).filter((c) => c.messageId === keyOf("a1"))
    ).toHaveLength(1);
  });

  it("(3b) AUTO-release crash points: before the batch nothing changed; after it the work is done once, and the two facts are NEVER written separately", async () => {
    // before
    {
      const s = await crashScene([], { total: 2 });
      await s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
      s.fs.arm({
        match: hasKind("INBOX_RELEASED", (e) => (e.payload as { auto?: unknown }).auto === true),
        when: "before",
      });
      const err = await s.a.rt.notifyInbox(s.e).catch((x) => x);
      expect(err).toBeInstanceOf(Error);
      expect(await kindsOf(s.inner.eventStore, s.e)).not.toContain("INBOX_RELEASED");
      const retry = s.mkA({}, s.inner.eventStore);
      retry.rt.registerFlow(s.f.definition, s.f.runner);
      await retry.rt.notifyInbox(s.e);
      expect(await completed(retry, s.e)).toEqual([
        ["a", { v: "S1" }],
        ["a", "P2"],
      ]);
      expect(
        consumedOf(await s.inner.eventStore.read(s.e)).filter((c) => c.messageId === keyOf("a1"))
      ).toHaveLength(1);
      expect(s.fs.writes.filter((w) => w === "append:INBOX_RELEASED")).toEqual([]);
    }
    // after: the batch is durable; a recovering node never double-delivers
    {
      const s = await crashScene([], { total: 2 });
      await s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
      s.fs.arm({ match: hasKind("INBOX_RELEASED"), when: "after" });
      await s.a.rt.notifyInbox(s.e).catch(() => undefined);
      const log = await s.inner.eventStore.read(s.e);
      const i = log.findIndex((e) => e.eventType === "INBOX_RELEASED");
      expect(log[i + 1]?.eventType).toBe("MESSAGE_CONSUMED"); // atomic: never released-but-undelivered
      const fold = await s.mkA({}, s.inner.eventStore).rt.loadState(s.e);
      expect(fold?.variables._quarantined).toBeUndefined(); // delivered, entry gone
      const recovery = s.mkA({}, s.inner.eventStore);
      recovery.rt.registerFlow(s.f.definition, s.f.runner);
      await recoverAbandoned(recovery.rt, { source: s.inner.eventStore, isAbandoned: () => true });
      await completed(recovery, s.e).catch(() => undefined);
      expect(
        consumedOf(await s.inner.eventStore.read(s.e)).filter((c) => c.messageId === keyOf("a1"))
      ).toHaveLength(1);
      expect(s.fs.writes.filter((w) => w === "append:INBOX_RELEASED")).toEqual([]);
    }
  });

  it("(4) crash mid-release of the DISCARD disposition: nothing changed, the retry works, a repeat is idempotent", async () => {
    const s = await crashScene([], { total: 1 });
    await s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
    s.fs.arm({ match: hasKind("INBOX_RELEASED"), when: "before" });
    const err = await s.b.rt
      .releaseInbox(s.e, { topic: "a", messageId: "a1", disposition: "discard" }, { principal: OP })
      .catch((x) => x);
    expect(isCrash(err)).toBe(true);
    expect(await eventsByKind(s.inner.eventStore, s.e, "INBOX_RELEASED")).toHaveLength(0);
    const ok = await s.b.rt.releaseInbox(
      s.e,
      { topic: "a", messageId: "a1", disposition: "discard" },
      { principal: OP }
    );
    expect(ok.changed).toBe(true);
    const again = await s.b.rt.releaseInbox(
      s.e,
      { topic: "a", messageId: "a1", disposition: "discard" },
      { principal: OP }
    );
    expect(again.changed).toBe(false);
    expect(await eventsByKind(s.inner.eventStore, s.e, "INBOX_RELEASED")).toHaveLength(1);
  });
});

describe("continue-as-new, TTL, erasure, wrong key, fork, per-topic streams", () => {
  it("(5) continue-as-new while a topic is held: still held on the successor, and a release delivers there", async () => {
    const raw = memRaw();
    const keys = new InMemoryKeyStore();
    const on = { continueAsNewEnabled: true, inboxAutoRelease: false } as const;
    const a = build(on, { ...raw, eventStore: sealingStore(raw.eventStore, keys) });
    const b = build({ continueAsNewEnabled: true }, { ...raw });
    const f = flow<{ gen?: number }, unknown>("rot", async (ctx, input) => {
      if (input?.gen === undefined) {
        await ctx.receive("go");
        return ctx.continueAsNew({ gen: 1 });
      }
      return unwrapTainted(await ctx.receive<unknown>("a"));
    });
    for (const h of [a, b]) h.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await parked(a, e);
    await put(a.eventStore, e, { topic: "a", messageId: "a1", payload: { v: "S1" } });
    await b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP });
    await a.rt.send(e, { topic: "go", payload: 1 });
    await until(async () => (await a.rt.loadState(`${e}~1`))?.status === "suspended");
    const succ = await a.rt.loadState(`${e}~1`);
    const held = (succ?.variables._quarantined as Record<string, Array<{ state: string }>>).a;
    expect(held?.map((x) => x.state)).toEqual(["held"]); // carried across the rotation
    const carried = (await raw.eventStore.read(`${e}~1`))[0]?.payload as {
      continuedFrom: { carried: { quarantined: unknown } };
    };
    expect(carried.continuedFrom.carried.quarantined).toBeDefined();
    await a.rt.releaseInbox(e, { topic: "a", messageId: "a1" }, { principal: OP }); // addressed by the FIRST id
    expect(await completed(a, `${e}~1`)).toEqual({ v: "S1" });
  });

  it("TTL: messages behind a hold still expire on schedule; the held entry never does", async () => {
    const clock = { t: 5_000_000 };
    const TTL = 60_000;
    const raw = memRaw();
    const keys = new InMemoryKeyStore();
    const sealed = sealingStore(raw.eventStore, keys);
    const a = build({ now: () => clock.t, inboxMessageTtlMs: TTL }, { ...raw, eventStore: sealed });
    const b = build({ now: () => clock.t, inboxMessageTtlMs: TTL }, { ...raw });
    const f = collector(1, ["a"]);
    for (const h of [a, b]) h.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await parked(a, e);
    await a.rt.notifyInbox(e);
    await put(
      sealed,
      e,
      { topic: "a", messageId: "a1", payload: { v: "S1" } },
      { timestamp: clock.t }
    );
    await put(
      raw.eventStore,
      e,
      { topic: "a", messageId: "a2", payload: "P2" },
      { timestamp: clock.t }
    );
    await b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP });
    clock.t += 3 * TTL;
    const r = await b.rt.expireInbox(e);
    expect(r).toMatchObject({ status: "done", expired: 1 }); // a2 behind the hold expired; a1 is not a queue entry
    const st = await b.rt.loadState(e);
    expect((st?.variables._quarantined as Record<string, unknown[]>).a).toHaveLength(1);
    await a.rt.notifyInbox(e);
    expect(await completed(a, e)).toEqual([["a", { v: "S1" }]]); // the held message outlived its TTL
  });

  it("erasure: a shred destroys the original AND the copy; a release never delivers a redacted copy; the compliance deletion removes the quarantine stream", async () => {
    const s = await heldScene({ total: 2 });
    const copy = (await s.raw.eventStore.read(quarantineStreamId(s.e)))[1];
    expect(JSON.stringify(copy)).toContain("__loomEnc");
    expect(JSON.stringify(copy)).not.toContain("S1");
    await s.keys.destroy(s.e); // the owner's subject
    const opened = (await s.a.eventStore.read(quarantineStreamId(s.e)))[1];
    expect(JSON.stringify(opened?.payload)).toContain("$shredded"); // non-loud: redacted, not thrown
    const before = await kindsOf(s.raw.eventStore, s.e);
    const manual = await s.a.rt
      .releaseInbox(s.e, { topic: "a", messageId: "a1" }, { principal: OP })
      .catch((x) => x);
    expect(manual).toBeInstanceOf(SealedPayloadUnreadableError);
    const auto = await s.a.rt.notifyInbox(s.e).catch((x) => x);
    expect(auto).toBeInstanceOf(QuarantineHeldError);
    expect(await kindsOf(s.raw.eventStore, s.e)).toEqual(before);
    expect(consumedOf(await s.raw.eventStore.read(s.e))).toHaveLength(0);
    // the discard is the exit
    await s.a.rt.releaseInbox(
      s.e,
      { topic: "a", messageId: "a1", disposition: "discard" },
      { principal: OP }
    );
    // reclaim / delete-with-chain covers the quarantine stream
    await deleteInbox(s.raw.eventStore, s.e);
    expect(await quarantineHead(s.raw.eventStore, s.e)).toBeNull();
  });

  it("an orphan quarantine copy of a TERMINAL owner is reclaimed by the recovery sweep", async () => {
    const s = await heldScene({ total: 1, a: { inboxAutoRelease: true } });
    await s.a.rt.notifyInbox(s.e);
    await completed(s.a, s.e);
    // a quarantiner that lost the race with the terminal left its copy behind
    expect(await quarantineHead(s.raw.eventStore, s.e)).toBeNull(); // the terminal deleted the chain's streams
    await s.raw.eventStore.append({
      id: "orphan-1",
      executionId: quarantineStreamId(s.e),
      workflowId: "__loom_inbox__",
      eventType: "INBOX_MESSAGE",
      sequence: 0,
      timestamp: 1,
      payload: { topic: "a", messageId: "late", payload: { __loomEnc: "x" }, sender: {} },
    });
    const summary = await recoverAbandoned(s.a.rt, {
      source: s.raw.eventStore,
      isAbandoned: () => false,
    });
    expect(summary.inboxReclaimed ?? 0).toBeGreaterThanOrEqual(1);
    expect(await quarantineHead(s.raw.eventStore, s.e)).toBeNull();
  });

  it("a WRONG-KEY node (reads the inbox as REDACTED) never answers `not-sealed`, copies nothing, and never delivers a redacted copy", async () => {
    const s = await heldScene({ total: 2, quarantine: false });
    const wrong = wrongKeyNode(s.raw);
    wrong.rt.registerFlow(s.f.definition, s.f.runner);
    const before = await kindsOf(s.raw.eventStore, s.e);
    const err = await wrong.rt
      .quarantineInbox(s.e, { topic: "a" }, { principal: OP })
      .catch((x) => x);
    expect(err).toBeInstanceOf(SealedPayloadUnreadableError);
    expect(err).not.toBeInstanceOf(InboxQuarantineRefusedError);
    expect(await kindsOf(s.raw.eventStore, s.e)).toEqual(before);
    expect(await quarantineHead(s.raw.eventStore, s.e)).toBeNull(); // no (corrupt) copy
    // a good hold by B; the wrong-key node can neither release nor auto-release it
    await s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
    const mark = await kindsOf(s.raw.eventStore, s.e);
    const rel = await wrong.rt
      .releaseInbox(s.e, { topic: "a", messageId: "a1" }, { principal: OP })
      .catch((x) => x);
    expect(rel).toBeInstanceOf(SealedPayloadUnreadableError);
    const auto = await wrong.rt.notifyInbox(s.e).catch((x) => x);
    expect(auto).toBeInstanceOf(QuarantineHeldError);
    expect(await kindsOf(s.raw.eventStore, s.e)).toEqual(mark);
  });

  it("fork with holds copies the referenced quarantine prefix (same heldAt); a store without copyPrefix refuses typed", async () => {
    const raw = memRaw();
    // A shared owner subject lets the fork open the parent's ciphertext (the documented fork caveat).
    const s = await heldScene({ raw, total: 1, subjectOf: () => "shared" });
    const at = (await s.a.rt.loadState(s.e))?.sequence as number;
    const child = await s.a.rt.fork(s.e, at);
    const copied = await raw.eventStore.read(quarantineStreamId(child.executionId));
    expect(copied.map((c) => c.sequence)).toEqual([0, 1]); // the anchor and the held copy
    expect(copied[1]?.payload).toEqual(
      (await raw.eventStore.read(quarantineStreamId(s.e)))[1]?.payload
    );
    const held = (
      (await s.a.rt.loadState(child.executionId))?.variables._quarantined as Record<
        string,
        Array<{ heldAt: number }>
      >
    ).a;
    expect(held?.[0]?.heldAt).toBe(1); // the fold of the fork is valid: its heldAt resolves in ITS chain
    await s.a.rt.notifyInbox(child.executionId); // auto-release in the fork, from the fork's own copy
    expect(await completed(s.a, child.executionId)).toEqual([["a", { v: "S1" }]]);
    // the parent is untouched: still held
    expect(await eventsByKind(raw.eventStore, s.e, "INBOX_RELEASED")).toHaveLength(0);
    // no copyPrefix: refused typed, nothing written
    const noCopy = new Proxy(raw.eventStore, {
      get(target, prop) {
        if (prop === "copyPrefix") return undefined;
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as EventStore;
    const b2 = build({}, { ...raw, eventStore: noCopy });
    b2.rt.registerFlow(s.f.definition, s.f.runner);
    const listing = async () => (await raw.eventStore.listExecutions?.()) ?? [];
    const before = (await listing()).length;
    const err = await b2.rt.fork(s.e, at).catch((x) => x);
    expect(err).toBeInstanceOf(InboxQuarantineRefusedError);
    expect(err.verb).toBe("fork");
    expect((await listing()).length).toBe(before);
  });

  it("per-topic streams: the hold, the original-position release and the registry entry work in that layout too", async () => {
    const raw = memRaw();
    const keys = new InMemoryKeyStore();
    const sealed = sealingStore(raw.eventStore, keys);
    const a = build(
      { inboxTopicStreams: true, inboxAutoRelease: false },
      { ...raw, eventStore: sealed }
    );
    const b = build({ inboxTopicStreams: true }, { ...raw });
    await a.rt.enableInboxTopicStreams({ principal: OP });
    const f = collector(2, ["a"]);
    for (const h of [a, b]) h.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await parked(a, e);
    await a.rt.notifyInbox(e);
    await put(sealed, e, { topic: "a", messageId: "a1", payload: { v: "S1" } }, { perTopic: true });
    await put(
      raw.eventStore,
      e,
      { topic: "a", messageId: "a2", payload: "P2" },
      { perTopic: true }
    );
    const res = await b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP });
    expect(res.inboxSeq).toBeGreaterThanOrEqual(1_000_000_000); // the topic range
    expect(await readRegisteredTopics(raw.eventStore, e)).toContain("a"); // held: not retired as drained
    await a.rt.notifyInbox(e).catch(() => undefined);
    expect(consumedOf(await raw.eventStore.read(e))).toHaveLength(0); // held for every node
    await a.rt.releaseInbox(e, { topic: "a", messageId: "a1" }, { principal: OP });
    expect(await completed(a, e)).toEqual([
      ["a", { v: "S1" }],
      ["a", "P2"],
    ]);
    expect(consumedOf(await raw.eventStore.read(e))[0]?.inboxSeq).toBe(res.inboxSeq);
  });
});

describe("authorization", () => {
  async function strictScene(rules?: Parameters<typeof executionAccessPolicy>[0]) {
    const raw = memRaw();
    const keys = new InMemoryKeyStore();
    const owner = { actor: "alice", tenant: "t1" };
    const deps = {
      executionAuthorizer: executionAccessPolicy(rules),
      executionAuthz: { requirePrincipal: true },
    };
    const sealed = sealingStore(raw.eventStore, keys);
    const a = build({ ...deps, inboxAutoRelease: false }, { ...raw, eventStore: sealed });
    const b = build(deps, { ...raw });
    const f = collector(2, ["a"]);
    for (const h of [a, b]) h.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await a.rt.start(f, {}, { executionId: e, principal: owner })).waitForSuspend();
    await parked(a, e);
    await put(sealed, e, { topic: "a", messageId: "a1", payload: { v: "S1" } });
    await put(raw.eventStore, e, { topic: "a", messageId: "a2", payload: "P2" });
    return { raw, a, b, e, owner };
  }
  const ops = { actor: "ops", tenant: "t1" };
  const mallory = { actor: "mallory", tenant: "t2" };

  it("closed by default: nobody (not even the owner) may quarantine or release, and nothing is appended", async () => {
    const s = await strictScene();
    const before = await kindsOf(s.raw.eventStore, s.e);
    for (const principal of [undefined, s.owner, ops, mallory]) {
      const opt = principal && { principal };
      await expect(s.b.rt.quarantineInbox(s.e, { topic: "a" }, opt)).rejects.toBeInstanceOf(
        ExecutionDeniedError
      );
      await expect(
        s.a.rt.releaseInbox(s.e, { topic: "a", messageId: "a1" }, opt)
      ).rejects.toBeInstanceOf(ExecutionDeniedError);
      await expect(
        s.a.rt.releaseInbox(s.e, { topic: "a", messageId: "a1", disposition: "discard" }, opt)
      ).rejects.toBeInstanceOf(ExecutionDeniedError);
    }
    expect(await kindsOf(s.raw.eventStore, s.e)).toEqual(before); // not even an EXECUTION_DENIED
    expect(await quarantineHead(s.raw.eventStore, s.e)).toBeNull();
  });

  it("a principal is REQUIRED even when the policy is open, before anything is read (no existence oracle)", async () => {
    const s = await strictScene({ rules: { quarantine: "any", release: "any", discard: "any" } });
    const err = await s.b.rt.quarantineInbox(s.e, { topic: "a" }).catch((x) => x);
    expect(err).toBeInstanceOf(ExecutionDeniedError);
    expect(err.message).toMatch(/principal/);
    const ghost = await s.b.rt.quarantineInbox("ghost", { topic: "a" }).catch((x) => x);
    expect(ghost).toBeInstanceOf(ExecutionDeniedError);
    const ghost2 = await s.b.rt
      .releaseInbox("ghost", { topic: "a", messageId: "x" })
      .catch((x) => x);
    expect(ghost2).toBeInstanceOf(ExecutionDeniedError);
  });

  it("opened for a tenant's operators: another tenant is refused; `discard` is judged as the discard op", async () => {
    const s = await strictScene({ rules: { quarantine: "tenant", release: "tenant" } }); // discard stays closed
    await expect(
      s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: mallory })
    ).rejects.toBeInstanceOf(ExecutionDeniedError);
    const held = await s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: ops });
    expect(held.messageId).toBe("a1");
    const [fact] = await eventsByKind(s.raw.eventStore, s.e, "INBOX_QUARANTINED");
    expect((fact?.payload as { operator: unknown }).operator).toEqual(ops);
    await expect(
      s.a.rt.releaseInbox(
        s.e,
        { topic: "a", messageId: "a1", disposition: "discard" },
        { principal: ops }
      )
    ).rejects.toBeInstanceOf(ExecutionDeniedError);
    expect(await eventsByKind(s.raw.eventStore, s.e, "INBOX_RELEASED")).toHaveLength(0);
    const rel = await s.a.rt.releaseInbox(s.e, { topic: "a", messageId: "a1" }, { principal: ops });
    expect(rel.changed).toBe(true);
    const [released] = await eventsByKind(s.raw.eventStore, s.e, "INBOX_RELEASED");
    expect((released?.payload as { operator: unknown }).operator).toEqual(ops);
  });
});

// ── a seeded fleet scenario ───────────────────────────────────────────────────────────────────

/** mulberry32: a small deterministic PRNG. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("seeded fleet scenario (capable + incapable nodes, random crash points)", () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

  for (const capableUp of [true, false]) {
    it(`invariants hold across ${SEEDS.length} seeds (a capable node is ${capableUp ? "up" : "never up"})`, async () => {
      for (const seed of SEEDS) {
        const rand = rng(seed * 7919);
        const inner = memRaw();
        const fs = faultStore(inner.eventStore, []);
        const raw: Raw = { ...inner, eventStore: fs.store };
        const keys = new InMemoryKeyStore();
        const sealed = sealingStore(raw.eventStore, keys);
        const auto = rand() < 0.5;
        const a = build({ inboxAutoRelease: auto }, { ...raw, eventStore: sealed });
        const b = build({}, { ...raw });
        // A SLOW incapable node: it lingers after its copy lands and before its fact does (a quarantiner
        // contending on the park fence), the window in which another hold's trim must not free the copy.
        let lingerN = seed; // (not rand(): the delay's call order is timing-dependent)
        const lingering = new Proxy(raw.eventStore, {
          get(target, prop) {
            const v = Reflect.get(target, prop, target) as unknown;
            if (typeof v !== "function") return v;
            const fn = (v as (...x: unknown[]) => Promise<unknown>).bind(target);
            if (prop !== "append") return fn;
            return async (...x: unknown[]) => {
              const out = await fn(...x);
              if (
                String((x[0] as { executionId: string }).executionId).startsWith(
                  "__loom_quarantine__:"
                )
              ) {
                await new Promise((res) => setTimeout(res, (++lingerN * 7) % 12));
              }
              return out;
            };
          },
        }) as EventStore;
        const bSlow = build({}, { ...raw, eventStore: lingering });
        const topics = ["a", "b"];
        const sent: Record<string, string[]> = { a: [], b: [] };
        const total = 6 + Math.floor(rand() * 4);
        const f = collector(total, topics);
        for (const h of [a, b, bSlow]) h.rt.registerFlow(f.definition, f.runner);
        const e = id();
        await (await (capableUp ? a : b).rt.start(f, {}, { executionId: e })).waitForSuspend();
        await until(async () => (await b.rt.loadState(e))?.status === "suspended");
        const swallow = <T>(p: Promise<T>) => p.catch(() => undefined);
        let nextMsg = 0;
        let sendLock: Promise<unknown> = Promise.resolve(); // `put` allocates a slot: concurrent sends take turns
        const send = (): Promise<unknown> => {
          sendLock = sendLock.then(sendNow);
          return sendLock;
        };
        const sendNow = async () => {
          if (nextMsg >= total) return;
          const topic = topics[Math.floor(rand() * topics.length)] as string;
          const mid = `${topic}${++nextMsg}`;
          const sealedMsg = rand() < 0.6;
          sent[topic]?.push(mid);
          await put(sealedMsg ? sealed : raw.eventStore, e, {
            topic,
            messageId: mid,
            payload: { id: mid },
          });
        };
        const ops = 28 + Math.floor(rand() * 10);
        // One random operation. Two of them are sometimes launched TOGETHER (below), so the in-flight
        // windows of the verbs (a copy appended whose fact has not landed, a trim racing a hold, an
        // auto-release racing a manual one) are reachable, not just sequential histories.
        const step = async (i: number): Promise<void> => {
          const r = rand();
          if (r < 0.32) await send();
          else if (r < 0.64)
            await swallow(
              (rand() < 0.5 ? b : bSlow).rt.quarantineInbox(
                e,
                { topic: topics[Math.floor(rand() * 2)] as string },
                { principal: OP }
              )
            );
          else if (r < 0.7) await swallow(b.rt.notifyInbox(e));
          else if (capableUp && i < ops * 0.6)
            await swallow(b.rt.notifyInbox(e)); // the capable node is busy elsewhere early on
          else if (capableUp && r < 0.86) await swallow(a.rt.notifyInbox(e));
          else if (capableUp) {
            const t = topics[Math.floor(rand() * 2)] as string;
            const head = (await swallow(a.rt.loadState(e)))?.variables._quarantined as
              | Record<string, Array<{ key: string }>>
              | undefined;
            const first = head?.[t]?.[0];
            const mid =
              first === undefined
                ? undefined
                : [...(sent.a ?? []), ...(sent.b ?? [])].find((m) => keyOf(m) === first.key);
            if (mid !== undefined)
              await swallow(a.rt.releaseInbox(e, { topic: t, messageId: mid }, { principal: OP }));
          }
        };
        for (let i = 0; i < ops; i++) {
          if (rand() < 0.12) {
            // crash the owner's log or the quarantine copy, never a sender's inbox append
            fs.arm({
              match: (evs) =>
                evs.some(
                  (x) => x.executionId === e || x.executionId.startsWith("__loom_quarantine__:")
                ),
              when: rand() < 0.5 ? "before" : "after",
            });
          }
          if (rand() < 0.45) await Promise.all([step(i), step(i)]);
          else await step(i);
          await new Promise((res) => setTimeout(res, 0));
        }
        // quiesce: no more faults, send the rest, then let the capable node (if any) drain
        fs.disarm?.();
        while (nextMsg < total) await send();
        for (let round = 0; round < 40; round++) {
          if (capableUp) {
            await swallow(
              recoverAbandoned(a.rt, { source: inner.eventStore, isAbandoned: () => true })
            );
            await swallow(a.rt.notifyInbox(e));
            const st = await swallow(a.rt.loadState(e));
            if (st?.status === "completed") break;
            if (!auto) {
              // auto-release is off on this node: the operator lifts each hold (oldest first)
              const q = st?.variables._quarantined as
                | Record<string, Array<{ key: string; state: string }>>
                | undefined;
              for (const t of topics) {
                const first = q?.[t]?.[0];
                const mid =
                  first === undefined
                    ? undefined
                    : [...(sent.a ?? []), ...(sent.b ?? [])].find((m) => keyOf(m) === first.key);
                if (mid !== undefined)
                  await swallow(
                    a.rt.releaseInbox(e, { topic: t, messageId: mid }, { principal: OP })
                  );
              }
            }
          } else {
            await swallow(b.rt.notifyInbox(e));
          }
          await new Promise((res) => setTimeout(res, 2));
        }
        const log = await inner.eventStore.read(e);
        const view = await a.eventStore.read(e).catch(() => log); // A's opened view when readable
        const consumed = consumedOf(view).filter(
          (c) => c.payload !== null && c.waitId !== "__loom_discard__"
        );
        // (1) at most once
        const ids = consumed.map((c) => c.messageId);
        expect(new Set(ids).size, `seed ${seed}: duplicate delivery`).toBe(ids.length);
        // (2) per-topic delivered order is a PREFIX of the send order (== the send order once drained)
        for (const t of topics) {
          const got = consumed
            .filter((c) => c.topic === t)
            .map((c) => (c.payload as { id: string }).id);
          expect(got, `seed ${seed}: topic ${t} order`).toEqual(
            (sent[t] ?? []).slice(0, got.length)
          );
        }
        // (3) no ciphertext was ever handed to a flow
        const st = await (capableUp ? a : b).rt.loadState(e).catch(() => null);
        expect(JSON.stringify(st?.variables._waitAnswers ?? {}), `seed ${seed}`).not.toContain(
          "__loomEnc"
        );
        if (capableUp) {
          // (4) a held topic is released iff a capable node is up: everything drained
          expect(st?.status, `seed ${seed}: drained`).toBe("completed");
          for (const t of topics) {
            const got = consumed
              .filter((c) => c.topic === t)
              .map((c) => (c.payload as { id: string }).id);
            expect(got, `seed ${seed}: topic ${t} complete`).toEqual(sent[t]);
          }
          // an automatic release is always atomic with its delivery
          log.forEach((ev, i) => {
            if (
              ev.eventType === "INBOX_RELEASED" &&
              (ev.payload as { auto?: unknown }).auto === true
            ) {
              expect(log[i + 1]?.eventType, `seed ${seed}: auto release not atomic`).toBe(
                "MESSAGE_CONSUMED"
              );
            }
          });
          expect(fs.writes.filter((w) => w === "append:INBOX_RELEASED")).toEqual([]);
        } else {
          // no capable node: a sealed payload was never delivered to a flow, and held topics stayed held
          const delivered = JSON.stringify(consumed.map((c) => c.payload));
          expect(delivered).not.toContain("__loomEnc");
          expect(await kindsOf(inner.eventStore, e)).not.toContain("INBOX_RELEASED");
        }
      }
    }, 120_000);
  }
});
