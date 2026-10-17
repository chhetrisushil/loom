import type { EventEnvelope } from "@loom/core";
import {
  type EventStore,
  InMemoryAsyncEventStore,
  InMemoryTimerStore,
  KeyUnavailableError,
} from "@loom/event-runtime";
import {
  EncryptingEventStore,
  EncryptingSnapshotStore,
  InMemoryKeyStore,
  shredSubject,
} from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore, type SnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { build, echo, flow } from "./__tests__/r2Harness";
import { executionAccessPolicy } from "./executionAccessPolicy";

// The C.1 authorizer decides FIRST, from sequence 0 alone. Folding (or reading any later data)
// before the verdict let a caller the authorizer would deny tell, from WHICH error the fold raised
// (PayloadShreddedError, a sealed refusal, a checkpoint failure...), that an execution exists and
// what became of it. A denied caller must get the denial an ordinary execution gives, whatever the
// state of the log; an authorized caller keeps today's errors.

const SECRET = "123-45-6789";
const OWNER = { actor: "alice", tenant: "t1" };
const STRANGER = { actor: "mallory", tenant: "t9" };
const PRINCIPAL_PATHS = [
  "principal.identity.tenant",
  "principal.identity.actor",
  "principal.identity.onBehalfOf",
];
const E = "authz-1";
const POLICY = {
  rules: {
    discard: "tenant" as const,
    annotate: "tenant" as const,
    quarantine: "tenant" as const,
    release: "tenant" as const,
  },
};

const secret = () =>
  flow("secret", async (ctx) => {
    await ctx.run(echo, { ssn: SECRET });
    await ctx.suspend({ on: "Go" });
    return null;
  });

type Denied = { op: string; executionId: string; principal: unknown; reason: unknown };

function node(
  store: EventStore,
  snapshotStore?: SnapshotStore,
  extra: Record<string, unknown> = {}
) {
  const denied: Denied[] = [];
  const f = secret();
  const h = build(
    {
      executionAuthorizer: executionAccessPolicy(POLICY),
      executionAuthz: { requirePrincipal: true },
      onExecutionDenied: (
        r: { op: string; executionId: string; principal?: unknown },
        reason?: string
      ) => denied.push({ op: r.op, executionId: r.executionId, principal: r.principal, reason }),
      ...extra,
    } as never,
    {
      eventStore: store,
      ...(snapshotStore !== undefined && { snapshotStore }),
      timers: new InMemoryTimerStore(),
    }
  );
  h.rt.registerFlow(f.definition, f.runner);
  return { h, f, denied };
}

type Node = ReturnType<typeof node>;

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e
  );
const nameOf = (e: unknown): unknown => (e as { name?: unknown } | null)?.name;
const shape = (e: unknown) => {
  const err = e as Error & { op?: unknown; reason?: unknown; executionId?: unknown };
  return {
    name: err.name,
    message: err.message,
    keys: Object.keys(err).sort(),
    op: err.op,
    reason: err.reason,
    executionId: err.executionId,
  };
};

const fakeState = (id: string) =>
  ({
    executionId: id,
    workflowId: "secret",
    workflowVersion: "1.0.0",
    status: "suspended",
    sequence: 3,
    variables: {},
  }) as never;

/** Every authorizer-gated public op, as the STRANGER. */
const OPS: Array<[string, (n: Node) => Promise<unknown>]> = [
  ["loadState", (n) => n.h.rt.loadState(E, { principal: STRANGER })],
  ["parkedAtSequence", (n) => n.h.rt.parkedAtSequence(E, { principal: STRANGER })],
  ["followToHead", (n) => n.h.rt.followToHead(E, { principal: STRANGER })],
  ["resume", (n) => n.h.rt.resume(E, { eventType: "Go", payload: null }, { principal: STRANGER })],
  [
    "resumeAs",
    (n) =>
      n.h.rt.resumeAs(
        E,
        "secret",
        { eventType: "Go", payload: null },
        {
          strategy: "operator-ack",
          principal: STRANGER,
          // runs on the recorded input: it must never be called for a denied caller
          transformState: (i: unknown) => {
            transformCalls.push(i);
            return i;
          },
        }
      ),
  ],
  [
    "restoreFromState",
    (n) => n.h.rt.restoreFromState(fakeState(E), undefined, { principal: STRANGER }),
  ],
  ["cancel", (n) => n.h.rt.cancel(E, "no", { principal: STRANGER })],
  ["acquireFence", (n) => n.h.rt.acquireFence(E, { principal: STRANGER })],
  ["fork", (n) => n.h.rt.fork(E, 1, { principal: STRANGER })],
  ["send", (n) => n.h.rt.send(E, { topic: "t", payload: "x" }, { principal: STRANGER })],
  [
    "discardInbox",
    (n) => n.h.rt.discardInbox(E, { topic: "t", throughSeq: 1 }, { principal: STRANGER }),
  ],
  ["quarantineInbox", (n) => n.h.rt.quarantineInbox(E, { topic: "t" }, { principal: STRANGER })],
  [
    "releaseInbox",
    (n) => n.h.rt.releaseInbox(E, { topic: "t", messageId: "m" }, { principal: STRANGER }),
  ],
  [
    "recordOutcome",
    (n) =>
      n.h.rt.recordOutcome(
        E,
        { decisionId: "d", key: "k", success: true },
        { principal: STRANGER }
      ),
  ],
];
const transformCalls: unknown[] = [];

const kindsOf = async (store: EventStore): Promise<string[]> =>
  (await store.read(E)).map((e: EventEnvelope) => e.eventType);

/** The ordinary world: a PLAINTEXT suspended execution, started by `owner` (or nobody). */
async function plainWorld(owner: typeof OWNER | undefined) {
  const inner = new InMemoryAsyncEventStore();
  // started by a plain (no authorizer) runtime, so a principal-less start is possible
  const setup = build({}, { eventStore: inner });
  const f = secret();
  setup.rt.registerFlow(f.definition, f.runner);
  await (
    await setup.rt.start(
      f,
      {},
      { executionId: E, ...(owner !== undefined && { principal: owner }) }
    )
  ).waitForSuspend();
  return { inner, n: node(inner) };
}

/**
 * A suspended execution of `OWNER`, crypto-shredded. `sealPrincipal` also seals the recorded
 * principal at sequence 0, so even the anchor read raises the erasure error under a strict store.
 */
async function shreddedWorld(sealPrincipal: boolean) {
  const inner = new InMemoryAsyncEventStore();
  const rawSnaps = new InMemoryAsyncSnapshotStore();
  const keys = new InMemoryKeyStore();
  const sensitive = {
    STEP_COMPLETED: ["output"],
    ...(sealPrincipal && { EXECUTION_STARTED: PRINCIPAL_PATHS }),
  };
  const events = new EncryptingEventStore(inner, keys, { sensitive });
  const snaps = new EncryptingSnapshotStore(rawSnaps, keys, { sealState: true, events: inner });
  const opts = { snapshotEvery: 1, ...(sealPrincipal && { principalIdentity: "encrypted" }) };
  const n = node(events, snaps, opts);
  await (await n.h.rt.start(n.f, {}, { executionId: E, principal: OWNER })).waitForSuspend();
  await shredSubject(keys, inner, E, { snapshotStore: snaps });
  // a fresh node over the same stores, as after a restart
  return { inner, n: node(events, snaps, opts) };
}

async function sealedWorld() {
  const inner = new InMemoryAsyncEventStore();
  const keys = new InMemoryKeyStore();
  const full = {
    EXECUTION_STARTED: ["input"],
    STEP_STARTED: ["input"],
    STEP_COMPLETED: ["output"],
  };
  const owner = node(new EncryptingEventStore(inner, keys, { sensitive: full }));
  await (
    await owner.h.rt.start(owner.f, {}, { executionId: E, principal: OWNER })
  ).waitForSuspend();
  // a node that cannot open it: the right store, the wrong (empty) key store
  return {
    inner,
    n: node(new EncryptingEventStore(inner, new InMemoryKeyStore(), { sensitive: full })),
  };
}

/** Run every op as the stranger against `subject` and the ordinary `baseline`; demand identity. */
async function expectIndistinguishable(
  subject: { inner: InMemoryAsyncEventStore; n: Node },
  baseline: { inner: InMemoryAsyncEventStore; n: Node }
) {
  for (const [name, call] of OPS) {
    subject.n.denied.length = 0;
    baseline.n.denied.length = 0;
    transformCalls.length = 0;
    const beforeSubject = await kindsOf(subject.inner);
    const beforeBaseline = await kindsOf(baseline.inner);
    const want = await rejection(call(baseline.n));
    const got = await rejection(call(subject.n));
    expect(want, `${name}: the ordinary execution refuses`).toBeInstanceOf(Error);
    expect(nameOf(want), `${name}: the baseline is the authorizer's denial`).toBe(
      "ExecutionDeniedError"
    );
    expect(got, `${name}: refuses`).toBeInstanceOf(Error);
    expect(shape(got), name).toEqual(shape(want));
    expect(subject.n.denied, name).toEqual(baseline.n.denied);
    expect(transformCalls, `${name}: the caller's code never saw the recorded input`).toEqual([]);
    // nothing but the best-effort EXECUTION_DENIED audit of a write op (resume / cancel) is added
    const added = (await kindsOf(subject.inner)).slice(beforeSubject.length);
    expect(
      added.every((k) => k === "EXECUTION_DENIED"),
      `${name}: only audit facts may be appended, got ${added.join(",")}`
    ).toBe(true);
    if (!["resume", "resumeAs", "cancel"].includes(name)) expect(added, name).toEqual([]);
    const addedBase = (await kindsOf(baseline.inner)).slice(beforeBaseline.length);
    expect(addedBase.every((k) => k === "EXECUTION_DENIED")).toBe(true);
  }
}

describe("a denied caller learns nothing from the state of the log", () => {
  it("a crypto-shredded execution (checkpoint and steps sealed) reads as an ordinary denial", async () => {
    await expectIndistinguishable(await shreddedWorld(false), await plainWorld(OWNER));
  });

  it("a shredded execution whose RECORDED PRINCIPAL is sealed too: the unknown-owner denial", async () => {
    // the owner is unreadable, so the ordinary comparison is an execution started with no principal
    await expectIndistinguishable(await shreddedWorld(true), await plainWorld(undefined));
  });

  it("a sealed stream this node cannot open reads as an ordinary unknown-owner denial", async () => {
    await expectIndistinguishable(await sealedWorld(), await plainWorld(undefined));
  });

  it("a checkpoint whose key is unavailable (no tombstone) reads as an ordinary denial", async () => {
    const plain = await plainWorld(OWNER);
    const rawSnaps = new InMemoryAsyncSnapshotStore();
    const broken: SnapshotStore = {
      ...rawSnaps,
      save: (s: never) => rawSnaps.save(s),
      loadLatest: async () => {
        throw new KeyUnavailableError("alice", E, "secret");
      },
      loadAt: async () => null,
      loadLatestBefore: async () => null,
      close: async () => {},
    } as never;
    const inner = plain.inner;
    // the same plaintext log, read through a node whose checkpoint store throws on every load
    await expectIndistinguishable({ inner, n: node(inner, broken) }, await plainWorld(OWNER));
  });

  it("a checkpoint recording another execution's identity reads as an ordinary denial", async () => {
    const plain = await plainWorld(OWNER);
    const snaps = new InMemoryAsyncSnapshotStore();
    const writer = build({ snapshotEvery: 1 }, { eventStore: plain.inner, snapshotStore: snaps });
    const f = secret();
    writer.rt.registerFlow(f.definition, f.runner);
    // a checkpoint for E whose recorded identity names a DIFFERENT execution
    await snaps.save({
      executionId: E,
      sequence: 1,
      state: { executionId: "someone-else", workflowId: "secret", workflowVersion: "1.0.0" },
    } as never);
    await expectIndistinguishable(
      { inner: plain.inner, n: node(plain.inner, snaps) },
      await plainWorld(OWNER)
    );
  });
});

describe("an authorized caller keeps today's errors", () => {
  it("a shredded execution still raises PayloadShreddedError; a cancel still works", async () => {
    const w = await shreddedWorld(false);
    for (const call of [
      () => w.n.h.rt.loadState(E, { principal: OWNER }),
      () => w.n.h.rt.parkedAtSequence(E, { principal: OWNER }),
      () => w.n.h.rt.followToHead(E, { principal: OWNER }),
      () => w.n.h.rt.resume(E, { eventType: "Go", payload: null }, { principal: OWNER }),
    ]) {
      expect(nameOf(await rejection(call()))).toBe("PayloadShreddedError");
    }
    await expect(w.n.h.rt.cancel(E, "done", { principal: OWNER })).resolves.toBe(true);
    expect(await kindsOf(w.inner)).toContain("EXECUTION_CANCELLED");
  });

  it("an ordinary execution is served exactly as before", async () => {
    const w = await plainWorld(OWNER);
    const state = await w.n.h.rt.loadState(E, { principal: OWNER });
    expect(state?.status).toBe("suspended");
    expect(await w.n.h.rt.loadState("nope", { principal: OWNER })).toBeNull();
    await expect(w.n.h.rt.cancel(E, "x", { principal: OWNER })).resolves.toBe(true);
  });
});

describe("the verdict is reached before the log is folded", () => {
  it("a denied loadState reads no event range and loads no checkpoint", async () => {
    const inner = new InMemoryAsyncEventStore();
    const counts = { read: 0, readFrom: 0, loadLatest: 0 };
    const counting = new Proxy(inner, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (prop === "read") counts.read++;
          if (prop === "readFrom") counts.readFrom++;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as unknown as EventStore;
    const rawSnaps = new InMemoryAsyncSnapshotStore();
    const snaps = new Proxy(rawSnaps, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (prop === "loadLatest") counts.loadLatest++;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as unknown as SnapshotStore;
    const n = node(counting, snaps);
    await (await n.h.rt.start(n.f, {}, { executionId: E, principal: OWNER })).waitForSuspend();
    counts.read = counts.readFrom = counts.loadLatest = 0;
    const err = await rejection(n.h.rt.loadState(E, { principal: STRANGER }));
    expect(nameOf(err)).toBe("ExecutionDeniedError");
    expect(counts).toEqual({ read: 0, readFrom: 0, loadLatest: 0 });
    // the allowed call folds, as before
    await n.h.rt.loadState(E, { principal: OWNER });
    expect(counts.read + counts.readFrom + counts.loadLatest).toBeGreaterThan(0);
  });
});

describe("resumeAs hands the recorded input to the caller code only once authorized", () => {
  it("a denied caller transformState is never called, on an ordinary execution", async () => {
    const w = await plainWorld(OWNER);
    transformCalls.length = 0;
    const resumeAs = OPS.find(([name]) => name === "resumeAs")![1];
    const err = await rejection(resumeAs(w.n));
    expect(nameOf(err)).toBe("ExecutionDeniedError");
    expect(transformCalls).toEqual([]);
  });
});
