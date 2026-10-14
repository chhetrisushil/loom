import {
  runEventStoreDecoratorConformance,
  runSnapshotStoreDecoratorConformance,
} from "@loom/conformance";
import type { EventEnvelope } from "@loom/core";
import { type EventStore, InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { seededIvSource } from "@loom/plugin-crypto/testing";
import { describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import { Latch, build, crashingStore, echo, flow, until } from "./__tests__/r2Harness";
import { UNKNOWN_OWNER_REASON } from "./executionAccessPolicy";
import { INBOX_WAKE_AT } from "./inbox";
import * as operatorEntry from "./operator";
import { recoverAbandoned } from "./recoverAbandoned";
import {
  OpaqueQuarantineEventStore,
  SealGuardedEventStore,
  SealGuardedSnapshotStore,
  SealedStreamUnreadableError,
  assertStreamReadable,
  isSealedUnreadable,
  sealedDetailOf,
} from "./sealGuard";
import { ExecutionDeniedError, SealedPayloadUnreadableError } from "./types";

// ADR 0130 residuals D7 - the stream-level seal guard. A sealing store stamps `metadata.seal` on
// every envelope it sealed a field of; a node that cannot open that marker (a raw node, a crypto
// node with a narrower map) or that lacks the key (a different KeyStore) REFUSES the stream before
// anything is folded, replayed, handed to a flow, journaled or authorised against. The refusal is
// denial-shaped and appends nothing.

const SECRET = "123-45-6789";
let seq = 0;
const id = (): string => `sm-${++seq}-${Math.random().toString(36).slice(2, 6)}`;

// The guarded views are store decorators: they carry the whole optional SPI and pass the kit.
runEventStoreDecoratorConformance(
  "SealGuardedEventStore",
  (inner) => new SealGuardedEventStore(inner)
);
runEventStoreDecoratorConformance(
  "OpaqueQuarantineEventStore",
  (inner) => new OpaqueQuarantineEventStore(inner)
);
runSnapshotStoreDecoratorConformance(
  "SealGuardedSnapshotStore",
  (inner) => new SealGuardedSnapshotStore(inner, async () => {})
);

type Sensitive = Record<string, readonly string[]>;

/** One underlying log, three kinds of node over it. */
function fleet(sensitive: Sensitive) {
  const inner = new InMemoryAsyncEventStore();
  const timers = new InMemoryTimerStore();
  const keys = new InMemoryKeyStore();
  const mk = (store: EventStore) => build({}, { eventStore: store, timers });
  const capable = mk(new EncryptingEventStore(inner, keys, { sensitive }));
  const raw = mk(inner);
  const wrongKey = mk(new EncryptingEventStore(inner, new InMemoryKeyStore(), { sensitive }));
  // same key store, but a NARROWER sensitive map: the marker names a path it does not open
  const narrower = mk(new EncryptingEventStore(inner, keys, { sensitive: { UNRELATED: ["x"] } }));
  return { inner, timers, keys, capable, raw, wrongKey, narrower };
}
type Fleet = ReturnType<typeof fleet>;

/** A flow that runs one step on the secret, parks, then returns the step's result. */
function secretFlow(counter: { runs: number }) {
  return flow("secret", async (ctx) => {
    counter.runs++;
    const r = await ctx.run(echo, { ssn: SECRET });
    await ctx.suspend({ on: "Go" });
    return { r };
  });
}

const FULL: Sensitive = {
  EXECUTION_STARTED: ["input"],
  STEP_STARTED: ["input"],
  STEP_COMPLETED: ["output"],
  EXECUTION_COMPLETED: ["output"],
};

async function parked(f: Fleet) {
  const counters = {
    capable: { runs: 0 },
    raw: { runs: 0 },
    wrongKey: { runs: 0 },
    narrower: { runs: 0 },
  };
  const flows = {
    capable: secretFlow(counters.capable),
    raw: secretFlow(counters.raw),
    wrongKey: secretFlow(counters.wrongKey),
    narrower: secretFlow(counters.narrower),
  };
  for (const k of ["capable", "raw", "wrongKey", "narrower"] as const) {
    f[k].rt.registerFlow(flows[k].definition, flows[k].runner);
  }
  const e = id();
  await (
    await f.capable.rt.start(flows.capable, { ssn: SECRET }, { executionId: e })
  ).waitForSuspend();
  return { e, counters };
}

type Node = "raw" | "wrongKey" | "narrower";
const NODES: Array<[Node, "marker-unopenable" | "key-unavailable"]> = [
  ["raw", "marker-unopenable"],
  ["wrongKey", "key-unavailable"],
  ["narrower", "marker-unopenable"],
];

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e
  );

describe("the positive path: a capable node round-trips", () => {
  it("opens its own sealed stream, the flow sees plaintext, and the log holds ciphertext + a marker", async () => {
    const f = fleet(FULL);
    const { e } = await parked(f);
    const raw = await f.inner.read(e);
    const text = JSON.stringify(raw);
    expect(text).toContain("__loomEnc");
    expect(text).not.toContain(SECRET);
    const sealed = raw.filter((x) => x.metadata?.seal !== undefined).map((x) => x.eventType);
    expect(sealed).toEqual(["EXECUTION_STARTED", "STEP_STARTED", "STEP_COMPLETED"]);
    const state = await f.capable.rt.loadState(e);
    expect(state?.status).toBe("suspended");
    const h = await f.capable.rt.resume(e, { eventType: "Go", payload: null });
    await h.waitForCompletion();
    expect((await f.capable.rt.loadState(e))?.variables._output).toEqual({ r: { ssn: SECRET } });
  });
});

describe("fail closed: a stream this node cannot open is refused, nothing appended", () => {
  for (const [node, reason] of NODES) {
    describe(`on the ${node} node (${reason})`, () => {
      const setup = async () => {
        const f = fleet(FULL);
        const { e, counters } = await parked(f);
        const before = await f.inner.read(e);
        return { f, e, counters, before, n: f[node] };
      };
      const untouched = async (f: Fleet, e: string, before: EventEnvelope[]) => {
        expect(await f.inner.read(e)).toEqual(before);
        expect((await f.inner.read(e)).map((x) => x.eventType)).not.toContain("EXECUTION_FAILED");
        expect((await f.inner.read(e)).map((x) => x.eventType)).not.toContain("EXECUTION_DENIED");
      };
      const denialShaped = (err: unknown, op: string, e: string) => {
        expect(err).toBeInstanceOf(SealedStreamUnreadableError);
        expect(err).toBeInstanceOf(ExecutionDeniedError);
        expect(isSealedUnreadable(err)).toBe(true);
        const d = err as ExecutionDeniedError;
        expect(d.name).toBe("ExecutionDeniedError");
        expect(d.op).toBe(op);
        expect(d.executionId).toBe(e);
        expect(d.reason).toBe(UNKNOWN_OWNER_REASON);
        const detail = sealedDetailOf(err);
        expect(detail?.reason).toBe(reason);
        const json = JSON.stringify(err);
        expect(json).not.toContain("__loomEnc");
        expect(json).not.toContain("covers");
        expect(json).not.toContain("sequence");
        expect(json).not.toContain("key-unavailable");
        expect(json).not.toContain("marker-unopenable");
        // the same own keys as an ordinary denial of the same call: nothing extra can leak
        expect(Object.keys(err as object).sort()).toEqual(
          Object.keys(new ExecutionDeniedError("query", e, UNKNOWN_OWNER_REASON)).sort()
        );
      };

      it("resume: refused denial-shaped, the flow never runs, ciphertext never reaches it or EXECUTION_COMPLETED", async () => {
        const { f, e, counters, before, n } = await setup();
        const runsBefore = counters[node].runs;
        const err = await rejection(n.rt.resume(e, { eventType: "Go", payload: null }));
        denialShaped(err, "resume", e);
        expect(counters[node].runs).toBe(runsBefore); // the flow body never executed on this node
        await untouched(f, e, before);
        expect(JSON.stringify(await f.inner.read(e))).not.toContain("EXECUTION_COMPLETED");
        // the capable node still completes it, correctly
        const h = await f.capable.rt.resume(e, { eventType: "Go", payload: null });
        await h.waitForCompletion();
        expect((await f.capable.rt.loadState(e))?.variables._output).toEqual({
          r: { ssn: SECRET },
        });
      });

      it("loadState / send / cancel / discardInbox / notifyInbox / fork: refused, log untouched", async () => {
        const { f, e, before, n } = await setup();
        const calls: Array<[string, () => Promise<unknown>]> = [
          ["query", () => n.rt.loadState(e)],
          ["send", () => n.rt.send(e, { topic: "t", payload: "x" })],
          ["cancel", () => n.rt.cancel(e, "no")],
          [
            "discard",
            () =>
              n.rt.discardInbox(e, { topic: "t", throughSeq: 1 }, { principal: { actor: "op" } }),
          ],
          // ADR 0130 residuals D9: the quarantine verbs reach the owner's stream the same way
          [
            "quarantine",
            () => n.rt.quarantineInbox(e, { topic: "t" }, { principal: { actor: "op" } }),
          ],
          [
            "release",
            () =>
              n.rt.releaseInbox(e, { topic: "t", messageId: "m" }, { principal: { actor: "op" } }),
          ],
          [
            "discard",
            () =>
              n.rt.releaseInbox(
                e,
                { topic: "t", messageId: "m", disposition: "discard" },
                { principal: { actor: "op" } }
              ),
          ],
        ];
        for (const [op, call] of calls) {
          const r = await rejection(call());
          expect(r, op).toBeInstanceOf(SealedStreamUnreadableError);
          denialShaped(r, op, e);
        }
        const notify = await rejection(n.rt.notifyInbox(e));
        expect(isSealedUnreadable(notify), String(notify)).toBe(true);
        const fork = await rejection(n.rt.fork(e, 2));
        expect(isSealedUnreadable(fork), String(fork)).toBe(true);
        await untouched(f, e, before);
      });

      it("every read funnel of the guarded store refuses: events.read / readFrom / readRange", async () => {
        const { e, n } = await setup();
        for (const read of [
          () => n.rt.events.read(e),
          () => n.rt.events.readFrom(e, 0),
          () => n.rt.events.readRange!(e, 0, 5),
          () => n.rt.events.readRange!(e, 0, 0),
        ]) {
          expect(isSealedUnreadable(await rejection(read()))).toBe(true);
        }
      });

      it("a live subscriber is never handed an envelope this node cannot open", async () => {
        const { f, e, n } = await setup();
        const got: EventEnvelope[] = [];
        const off = await n.rt.events.subscribe(e, (ev) => got.push(ev));
        const h = await f.capable.rt.resume(e, { eventType: "Go", payload: null });
        await h.waitForCompletion();
        await new Promise((r) => setImmediate(r)); // let a wrong-key node's async key lookup settle
        off();
        expect(got.filter((x) => x.metadata?.seal !== undefined)).toEqual([]);
      });

      it("the operator is told the real cause, first then every 16th; the caller sees only a denial", async () => {
        const { e, n } = await setup();
        // 17 refusals -> reports at #1 and #16
        for (let i = 0; i < 17; i++) await rejection(n.rt.loadState(e));
        const reported = n.storageErrors.filter((x) => x instanceof SealedStreamUnreadableError);
        expect(reported).toHaveLength(2);
        expect(sealedDetailOf(reported[0])?.reason).toBe(reason);
        expect(n.warnings.some((w) => w.includes(reason))).toBe(true);
      });
    });
  }
});

describe("an unmarked stream behaves exactly as today (legacy streams must not brick)", () => {
  it("a plaintext stream with no marker is read, resumed and completed by a raw node", async () => {
    const f = fleet({});
    const { e } = await parked(f);
    expect((await f.inner.read(e)).some((x) => x.metadata?.seal !== undefined)).toBe(false);
    expect((await f.raw.rt.loadState(e))?.status).toBe("suspended");
    const h = await f.raw.rt.resume(e, { eventType: "Go", payload: null });
    await h.waitForCompletion();
    expect((await f.raw.rt.loadState(e))?.status).toBe("completed");
  });

  it("a legacy stream holding ciphertext but NO marker is not refused by the stream guard", async () => {
    const f = fleet(FULL);
    const { e } = await parked(f);
    // strip the markers: a writer that sealed without stamping (pre-1.25.0, third-party)
    const strip = (events: EventEnvelope[]): EventEnvelope[] =>
      events.map((x) => {
        if (x.metadata?.seal === undefined) return x;
        const { seal: _s, ...rest } = x.metadata;
        return { ...x, metadata: rest };
      });
    const legacy: EventStore = Object.assign(Object.create(f.inner) as EventStore, {
      read: async (i: string) => strip(await f.inner.read(i)),
      readFrom: async (i: string, from: number) => strip(await f.inner.readFrom(i, from)),
      readRange: async (i: string, a: number, b: number) =>
        strip(await f.inner.readRange!(i, a, b)),
    });
    const node = build({}, { eventStore: legacy });
    const state = await node.rt.loadState(e); // does not throw: no claim was made
    expect(state?.status).toBe("suspended");
  });

  it("assertStreamReadable ignores an unmarked envelope and a reserved control stream", () => {
    const ev = (extra: Partial<EventEnvelope>): EventEnvelope => ({
      id: "x",
      workflowId: "w",
      executionId: "e",
      eventType: "STEP_COMPLETED",
      sequence: 0,
      timestamp: 0,
      payload: { output: { __loomEnc: "loom/aes-256-gcm" } },
      ...extra,
    });
    const none = () => undefined;
    expect(() => assertStreamReadable("e", [ev({})], none)).not.toThrow(); // ciphertext shape, no marker
    const marked = ev({ metadata: { seal: { v: 1, cipher: "c", covers: ["A.b"] } } });
    expect(() => assertStreamReadable("e", [marked], none)).toThrow(SealedStreamUnreadableError);
    expect(() => assertStreamReadable("__loom_inbox__:e", [marked], none)).not.toThrow();
    // a malformed marker is a claim we cannot satisfy: refused
    const bad = ev({ metadata: { seal: { v: 9 } } });
    expect(() => assertStreamReadable("e", [bad], none)).toThrow(SealedStreamUnreadableError);
  });

  it("a pre-marker fold ignores metadata.seal (documented non-protection of a 1.24 node)", async () => {
    const { foldEvents } = await import("@loom/replay-vm");
    const f = fleet(FULL);
    const { e } = await parked(f);
    const withMarker = await f.inner.read(e);
    const without = withMarker.map((x) => {
      if (x.metadata?.seal === undefined) return x;
      const { seal: _s, ...rest } = x.metadata;
      return { ...x, metadata: rest };
    });
    const seed = { executionId: e, workflowId: "secret", workflowVersion: "1.0.0" };
    expect(foldEvents(withMarker, seed)).toEqual(foldEvents(without, seed));
  });
});

describe("internal code distinguishes the sealed refusals by brand", () => {
  it("isSealedUnreadable is true for both sealed refusals and false for any other denial", () => {
    expect(
      isSealedUnreadable(
        new SealedStreamUnreadableError("query", "e", { reason: "key-unavailable" })
      )
    ).toBe(true);
    expect(isSealedUnreadable(new SealedPayloadUnreadableError("e", "m", "t"))).toBe(true);
    expect(isSealedUnreadable(new ExecutionDeniedError("query", "e", "nope"))).toBe(false);
    expect(isSealedUnreadable(new Error("x"))).toBe(false);
    expect(isSealedUnreadable(null)).toBe(false);
    // the delivery-guard refusal is a plain Error, not a denial
    expect(new SealedPayloadUnreadableError("e", "m", "t")).not.toBeInstanceOf(
      ExecutionDeniedError
    );
  });

  it("the main entry does not export the operator detail; the operator entry does", async () => {
    const main = await import("./index");
    expect(Object.keys(main)).not.toContain("sealedDetailOf");
    expect(Object.keys(main)).toContain("SealedStreamUnreadableError");
    expect(typeof operatorEntry.sealedDetailOf).toBe("function");
  });

  it("a TimerService on an incapable node backs off a due row and does not thrash; the row stays", async () => {
    const f = fleet(FULL);
    const { e } = await parked(f);
    await f.timers.schedule({ executionId: e, wakeAt: INBOX_WAKE_AT });
    let clock = 1_000_000;
    const errors: unknown[] = [];
    const svc = new TimerService(f.raw.rt, f.timers, {
      now: () => clock,
      onError: (_i: string, err: unknown) => errors.push(err),
      redriveBackoff: { baseMs: 100, capMs: 10_000, random: () => 1 },
    });
    let loads = 0;
    const real = f.raw.rt.loadState.bind(f.raw.rt);
    f.raw.rt.loadState = (...a: Parameters<typeof real>) => {
      loads++;
      return real(...a);
    };
    for (let i = 0; i < 200; i++) {
      clock += 50;
      await svc.tick(clock);
    }
    expect(loads).toBeGreaterThan(0);
    expect(loads).toBeLessThanOrEqual(10); // unbounded would be ~200
    expect(errors.length).toBeLessThanOrEqual(2);
    expect(errors.every((x) => isSealedUnreadable(x))).toBe(true);
    expect((await f.timers.due(Number.MAX_SAFE_INTEGER)).some((r) => r.executionId === e)).toBe(
      true
    );
  });

  it("recoverAbandoned reports a stream it cannot open as failed (not recovered, pass not aborted) and backs off", async () => {
    const f = fleet(FULL);
    const latch = new Latch();
    const hold = flow("hold", async (ctx) => {
      await ctx.run(echo, { ssn: SECRET });
      await latch.promise;
      return {};
    });
    for (const k of ["capable", "raw"] as const) {
      f[k].rt.registerFlow(hold.definition, hold.runner);
    }
    const e = id();
    void f.capable.rt.start(hold, { ssn: SECRET }, { executionId: e });
    await until(async () => (await f.inner.read(e)).some((x) => x.eventType === "STEP_COMPLETED"));
    const errors: unknown[] = [];
    let resumes = 0;
    const real = f.raw.rt.resume.bind(f.raw.rt);
    f.raw.rt.resume = (...a: Parameters<typeof real>) => {
      resumes++;
      return real(...a);
    };
    const sweep = () =>
      recoverAbandoned(f.raw.rt, {
        source: f.inner,
        isAbandoned: () => true,
        onError: (_i, err) => errors.push(err),
      });
    const first = await sweep();
    expect(first.recovered).toBe(0);
    expect(first.failed).toBe(1);
    expect(errors).toHaveLength(1);
    expect(isSealedUnreadable(errors[0])).toBe(true);
    for (let i = 0; i < 5; i++) expect((await sweep()).failed).toBe(0); // backed off
    expect(errors).toHaveLength(1);
    expect(resumes).toBe(0);
    expect((await f.inner.read(e)).map((x) => x.eventType)).not.toContain("EXECUTION_FAILED");
    latch.release();
  });
});

describe("a node with a SUPERSET sensitive map opens an older, narrower marker", () => {
  it("rolling config change: the wider node reads what the narrower wrote; the narrower refuses the wider", async () => {
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const narrow = new EncryptingEventStore(inner, keys, {
      sensitive: { EXECUTION_STARTED: ["input"] },
    });
    const wide = new EncryptingEventStore(inner, keys, {
      sensitive: { EXECUTION_STARTED: ["input"], STEP_COMPLETED: ["output"] },
    });
    const mk = (s: EventStore) => build({}, { eventStore: s });
    const counter = { runs: 0 };
    const fl = secretFlow(counter);
    const a = mk(narrow);
    const b = mk(wide);
    for (const n of [a, b]) n.rt.registerFlow(fl.definition, fl.runner);
    const e = id();
    await (await a.rt.start(fl, { ssn: SECRET }, { executionId: e })).waitForSuspend();
    // a wrote ONLY EXECUTION_STARTED.input sealed: b (superset) opens it
    expect((await b.rt.loadState(e))?.status).toBe("suspended");
    // b appends a wider marker (STEP_COMPLETED.output): a refuses the stream from then on
    const e2 = id();
    await (await b.rt.start(fl, { ssn: SECRET }, { executionId: e2 })).waitForSuspend();
    expect(isSealedUnreadable(await rejection(a.rt.loadState(e2)))).toBe(true);
  });
});

describe("backstop (b): an UNMARKED legacy stream whose principal record is itself ciphertext", () => {
  const T1 = { actor: "alice", tenant: "t1" };
  async function legacyPrincipalStream(sealPrincipal: boolean) {
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const enc = new EncryptingEventStore(inner, keys, {
      sensitive: sealPrincipal
        ? { EXECUTION_STARTED: ["principal.identity"] }
        : { UNRELATED: ["x"] },
    });
    const a = build(
      { principalIdentity: sealPrincipal ? "encrypted" : "verbatim" },
      { eventStore: enc }
    );
    const fl = flow("p", async (ctx) => {
      await ctx.suspend({ on: "Go" });
      return {};
    });
    a.rt.registerFlow(fl.definition, fl.runner);
    const e = id();
    await (await a.rt.start(fl, {}, { executionId: e, principal: T1 })).waitForSuspend();
    const strip = (events: EventEnvelope[]): EventEnvelope[] =>
      events.map((x) => {
        if (x.metadata?.seal === undefined) return x;
        const { seal: _s, ...rest } = x.metadata;
        return { ...x, metadata: rest };
      });
    const legacy: EventStore = Object.assign(Object.create(inner) as EventStore, {
      read: async (i: string) => strip(await inner.read(i)),
      readFrom: async (i: string, n: number) => strip(await inner.readFrom(i, n)),
      readRange: async (i: string, x: number, y: number) => strip(await inner.readRange!(i, x, y)),
    });
    // ADR 0130 D7: the refusal never DECIDES on the policy; the policy is asked (owner UNSET, never
    // the sealed principal) only to word the error, so an allow-everything policy is still refused.
    const asked: Array<{ owner?: unknown; parentOwner?: unknown }> = [];
    const b = build(
      {
        principalIdentity: sealPrincipal ? "encrypted" : "verbatim",
        executionAuthorizer: {
          authorize: (r: { owner?: unknown; parentOwner?: unknown }) => {
            asked.push(r);
            return { allowed: true };
          },
        },
        executionAuthz: { requirePrincipal: true },
      },
      { eventStore: legacy }
    );
    return { e, b, inner, consulted: () => asked.length, asked };
  }

  it("a ciphertext principal is refused denial-shaped BEFORE the policy (even a policy that allows everything)", async () => {
    const { e, b, inner, asked } = await legacyPrincipalStream(true);
    const before = await inner.read(e);
    const err = await rejection(b.rt.loadState(e, { principal: T1 }));
    expect(err).toBeInstanceOf(SealedStreamUnreadableError);
    // asked only to phrase the error, with the owner UNSET: the sealed principal never reaches it
    for (const r of asked) {
      expect(r.owner).toBeUndefined();
      expect(r.parentOwner).toBeUndefined();
    }
    expect(await inner.read(e)).toEqual(before);
  });

  it("a plaintext principal is never refused: the policy decides", async () => {
    const { e, b, consulted } = await legacyPrincipalStream(false);
    expect((await b.rt.loadState(e, { principal: T1 }))?.status).toBe("suspended");
    expect(consulted()).toBeGreaterThan(0);
  });
});

describe("DST/crash: a crash after a sealed append, recovered by a raw node and by a capable one", () => {
  const sensitive: Sensitive = { EXECUTION_STARTED: ["input"], STEP_COMPLETED: ["output"] };
  const fixedKey = Buffer.alloc(32, 9);
  const keys = (): InMemoryKeyStore => {
    const k = new InMemoryKeyStore();
    k.getOrCreate = async () => fixedKey;
    k.get = async () => fixedKey;
    return k;
  };
  const mk = (store: EventStore) => build({}, { eventStore: store });
  const sealed = (inner: EventStore) =>
    new EncryptingEventStore(inner, keys(), { sensitive, ivSource: seededIvSource("dst-1") });
  const fl = () =>
    flow("dst", async (ctx) => {
      const r = await ctx.run(echo, { ssn: SECRET });
      return { r };
    });
  const bytes = (events: EventEnvelope[]) =>
    JSON.stringify(
      events
        .filter((e) => e.metadata?.seal !== undefined)
        .map((e) => [e.eventType, e.sequence, e.payload, e.metadata?.seal])
    );

  it("raw node: refused, nothing appended; capable node completes; sealed bytes equal the no-crash run", async () => {
    // reference: no crash
    const refInner = new InMemoryAsyncEventStore();
    const ref = mk(sealed(refInner));
    const f0 = fl();
    ref.rt.registerFlow(f0.definition, f0.runner);
    await (await ref.rt.start(f0, { ssn: SECRET }, { executionId: "dst" })).waitForCompletion();

    // crash run: the process dies right before EXECUTION_COMPLETED lands
    const inner = new InMemoryAsyncEventStore();
    const crash = crashingStore(inner, (e) => e.eventType === "EXECUTION_COMPLETED");
    const a = mk(sealed(crash.store));
    const f1 = fl();
    a.rt.registerFlow(f1.definition, f1.runner);
    void a.rt.start(f1, { ssn: SECRET }, { executionId: "dst" }).catch(() => {});
    await until(() => crash.crashed);
    crash.restore();
    const before = await inner.read("dst");
    expect(before.map((e) => e.eventType)).not.toContain("EXECUTION_COMPLETED");

    const raw = mk(inner);
    raw.rt.registerFlow(f1.definition, f1.runner);
    const errs: unknown[] = [];
    const swept = await recoverAbandoned(raw.rt, {
      source: inner,
      isAbandoned: () => true,
      onError: (_i, e) => errs.push(e),
    });
    expect(swept.recovered).toBe(0);
    expect(errs.every((e) => isSealedUnreadable(e))).toBe(true);
    expect(await inner.read("dst")).toEqual(before); // nothing appended

    const a2 = mk(sealed(inner));
    a2.rt.registerFlow(f1.definition, f1.runner);
    const ok = await recoverAbandoned(a2.rt, { source: inner, isAbandoned: () => true });
    expect(ok.recovered).toBeGreaterThanOrEqual(1);
    await until(async () => (await a2.rt.loadState("dst"))?.status === "completed");
    expect(bytes(await inner.read("dst"))).toBe(bytes(await refInner.read("dst")));
  });
});
