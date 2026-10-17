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
  PayloadShreddedError,
  shredSubject,
} from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore, type SnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { build, echo, flow } from "./__tests__/r2Harness";
import { UNKNOWN_OWNER_REASON, executionAccessPolicy } from "./executionAccessPolicy";
import { ExecutionStoreUnavailableError } from "./index";
import { isSealedUnreadable } from "./sealGuard";

// The C.1 authorizer decides FIRST, from sequence 0 alone. Folding (or reading any later data)
// before the verdict let a caller the authorizer would deny tell, from WHICH error the fold raised
// (PayloadShreddedError, a sealed refusal, a checkpoint failure...), that an execution exists and
// what became of it. A denied caller must get the denial an ordinary execution gives, whatever the
// state of the log; an authorized caller keeps today's errors.

// WHICH WORLD EXERCISES WHICH OP. Measured by running this file against the PRE-change runtime
// (949a0667); a cell that PASSED there is vacuous for that op (it pins the contract, it does not guard
// a regression), and is listed so the matrix is not read as more coverage than it is:
//
//   world                              fails pre-change (a real regression guard)
//   shredded, principal plaintext      loadState, parkedAtSequence, followToHead, resume, resumeAs
//                                      VACUOUS: restoreFromState (errors via the same gate it always
//                                      had), cancel (folds the redacted view), acquireFence, fork,
//                                      send, discardInbox, quarantineInbox, releaseInbox, recordOutcome
//                                      (they read only sequence 0, which is plaintext here)
//   shredded, principal SEALED         every op except cancel and restoreFromState (even the anchor
//                                      read raised the erasure error)
//   sealed stream, wrong key           the error CLASS was already ordinary for every op (the seal
//                                      guard, ADR 0130 D7); the cells fail pre-change only on the
//                                      `onExecutionDenied` workflow id, which was "" and is now the
//                                      plaintext one the refusal carries. VACUOUS for loadState,
//                                      parkedAtSequence, followToHead (never audited a denial).
//   checkpoint key unavailable /       loadState, parkedAtSequence, followToHead, resume, resumeAs,
//   checkpoint of another identity     cancel (audit placement). VACUOUS for the seq-0-only ops.
//
// AUDIT FACT: a denied resume / resumeAs / cancel appends a best-effort EXECUTION_DENIED at the folded
// tip. Where the fold itself is unreadable (the shredded worlds, the sealed world) that fact is
// SKIPPED rather than surface the fold's error, so the added-events list is [] there instead of the
// baseline's ["EXECUTION_DENIED"]; everywhere else the two worlds append the same kinds.

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

type Denied = {
  op: string;
  executionId: string;
  workflowId: unknown;
  principal: unknown;
  reason: unknown;
};

function node(
  store: EventStore,
  snapshotStore?: SnapshotStore,
  extra: Record<string, unknown> = {},
  mk: () => ReturnType<typeof secret> = secret
) {
  const denied: Denied[] = [];
  const f = mk();
  const h = build(
    {
      executionAuthorizer: executionAccessPolicy(POLICY),
      executionAuthz: { requirePrincipal: true },
      onExecutionDenied: (
        r: { op: string; executionId: string; workflowId?: unknown; principal?: unknown },
        reason?: string
      ) =>
        denied.push({
          op: r.op,
          executionId: r.executionId,
          workflowId: r.workflowId,
          principal: r.principal,
          reason,
        }),
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

type Who = typeof OWNER;
/** Every authorizer-gated public op, as `who` (the STRANGER unless a test says otherwise). */
const OPS: Array<[string, (n: Node, who?: Who) => Promise<unknown>]> = [
  ["loadState", (n, who = STRANGER) => n.h.rt.loadState(E, { principal: who })],
  ["parkedAtSequence", (n, who = STRANGER) => n.h.rt.parkedAtSequence(E, { principal: who })],
  ["followToHead", (n, who = STRANGER) => n.h.rt.followToHead(E, { principal: who })],
  [
    "resume",
    (n, who = STRANGER) => n.h.rt.resume(E, { eventType: "Go", payload: null }, { principal: who }),
  ],
  [
    "resumeAs",
    (n, who = STRANGER) =>
      n.h.rt.resumeAs(
        E,
        "secret",
        { eventType: "Go", payload: null },
        {
          strategy: "operator-ack",
          principal: who,
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
    (n, who = STRANGER) => n.h.rt.restoreFromState(fakeState(E), undefined, { principal: who }),
  ],
  ["cancel", (n, who = STRANGER) => n.h.rt.cancel(E, "no", { principal: who })],
  ["acquireFence", (n, who = STRANGER) => n.h.rt.acquireFence(E, { principal: who })],
  ["fork", (n, who = STRANGER) => n.h.rt.fork(E, 1, { principal: who })],
  ["send", (n, who = STRANGER) => n.h.rt.send(E, { topic: "t", payload: "x" }, { principal: who })],
  [
    "discardInbox",
    (n, who = STRANGER) =>
      n.h.rt.discardInbox(E, { topic: "t", throughSeq: 1 }, { principal: who }),
  ],
  [
    "quarantineInbox",
    (n, who = STRANGER) => n.h.rt.quarantineInbox(E, { topic: "t" }, { principal: who }),
  ],
  [
    "releaseInbox",
    (n, who = STRANGER) =>
      n.h.rt.releaseInbox(E, { topic: "t", messageId: "m" }, { principal: who }),
  ],
  [
    "recordOutcome",
    (n, who = STRANGER) =>
      n.h.rt.recordOutcome(E, { decisionId: "d", key: "k", success: true }, { principal: who }),
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

type World = { inner: InMemoryAsyncEventStore; n: Node };

/**
 * One op as the stranger against `subject` and the ordinary `baseline`; demand identity.
 * `auditSkipped`: the ops whose best-effort EXECUTION_DENIED is skipped (nothing appended) because
 * the subject's fold is unreadable, where the baseline appends its fact.
 */
async function expectIndistinguishable(
  name: string,
  call: (n: Node) => Promise<unknown>,
  subject: World,
  baseline: World,
  auditSkipped: ReadonlySet<string>
) {
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
  // the audit callback too, workflow id included
  expect(subject.n.denied, name).toEqual(baseline.n.denied);
  expect(transformCalls, `${name}: the caller's code never saw the recorded input`).toEqual([]);
  const added = (await kindsOf(subject.inner)).slice(beforeSubject.length);
  const addedBase = (await kindsOf(baseline.inner)).slice(beforeBaseline.length);
  const writesAudit = ["resume", "resumeAs", "cancel"].includes(name);
  const skipped = auditSkipped.has(name);
  // a read or an inbox/outcome/fence op appends NOTHING; a write op only its audit fact
  expect(addedBase, `${name}: baseline appends`).toEqual(writesAudit ? ["EXECUTION_DENIED"] : []);
  expect(added, `${name}: appended events`).toEqual(skipped ? [] : addedBase);
}

/**
 * [world name, subject factory, baseline factory, ops whose audit fact is skipped (unreadable fold)].
 * The baseline is the ordinary execution the world must be indistinguishable from.
 */
const RESUME_ONLY: ReadonlySet<string> = new Set(["resume", "resumeAs"]);
const AUDITING_OPS: ReadonlySet<string> = new Set(["resume", "resumeAs", "cancel"]);
const WORLDS: Array<[string, () => Promise<World>, () => Promise<World>, ReadonlySet<string>]> = [
  // shreddedWorld(false): the recorded principal is PLAINTEXT, so sequence 0 reads fine and the owner
  // is known: the ordinary comparison is an execution OWNED by `OWNER` (another tenant's denial).
  // `cancel` folds the REDACTED view (an erased owner is still cancellable), so it keeps its audit fact;
  // `resume` / `resumeAs` fold strictly and skip it.
  [
    "crypto-shredded, principal plaintext",
    () => shreddedWorld(false),
    () => plainWorld(OWNER),
    RESUME_ONLY,
  ],
  // shreddedWorld(true): the principal is sealed and shredded too: the owner is UNKNOWN, so the
  // comparison is an execution started with no principal (the unknown-owner denial).
  [
    "crypto-shredded, principal sealed",
    () => shreddedWorld(true),
    () => plainWorld(undefined),
    RESUME_ONLY,
  ],
  [
    "sealed stream this node cannot open",
    () => sealedWorld(),
    () => plainWorld(undefined),
    AUDITING_OPS,
  ],
  [
    "checkpoint key unavailable",
    keyUnavailableCheckpointWorld,
    () => plainWorld(OWNER),
    AUDITING_OPS,
  ],
  ["checkpoint of another identity", foreignCheckpointWorld, () => plainWorld(OWNER), AUDITING_OPS],
];

async function keyUnavailableCheckpointWorld(): Promise<World> {
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
  // the same plaintext log, read through a node whose checkpoint store throws on every load
  return { inner: plain.inner, n: node(plain.inner, broken) };
}

async function foreignCheckpointWorld(): Promise<World> {
  const plain = await plainWorld(OWNER);
  const snaps = new InMemoryAsyncSnapshotStore();
  // a checkpoint for E whose recorded identity names a DIFFERENT execution
  await snaps.save({
    executionId: E,
    sequence: 1,
    state: { executionId: "someone-else", workflowId: "secret", workflowVersion: "1.0.0" },
  } as never);
  return { inner: plain.inner, n: node(plain.inner, snaps) };
}

describe("a denied caller learns nothing from the state of the log", () => {
  for (const [world, subject, baseline, auditSkipped] of WORLDS) {
    describe(world, () => {
      for (const [name, call] of OPS) {
        it(`${name} reads as the ordinary denial`, async () => {
          await expectIndistinguishable(
            name,
            call,
            await subject(),
            await baseline(),
            auditSkipped
          );
        });
      }
    });
  }
});

describe("the denial REASON still tells an unknown owner from an owned execution (documented residual)", () => {
  // ADR 0039 amendment, "Reason oracle": the error CLASS, message shape, callback and appended events
  // of a shredded / sealed / unreadable execution are the ordinary denial's. The REASON TEXT is the
  // policy's own and is not redesigned: an execution whose owner is unknown (erased principal, sealed
  // stream, legacy log) is refused with UNKNOWN_OWNER_REASON, an execution with a recorded owner of
  // another tenant with "belongs to another tenant". This test PINS that difference.
  it("a stranger is told 'owner unknown' for an erased principal and 'another tenant' for an owned one", async () => {
    const erased = await shreddedWorld(true);
    const owned = await plainWorld(OWNER);
    const loadState = OPS.find(([name]) => name === "loadState")![1];
    const a = await rejection(loadState(erased.n));
    const b = await rejection(loadState(owned.n));
    expect(nameOf(a)).toBe("ExecutionDeniedError");
    expect(nameOf(b)).toBe("ExecutionDeniedError");
    expect((a as { reason?: unknown }).reason).toBe(UNKNOWN_OWNER_REASON);
    expect((b as { reason?: unknown }).reason).toBe("the execution belongs to another tenant");
    // everything but the reason (and so the message that quotes it) is the same
    expect(Object.keys(a as object).sort()).toEqual(Object.keys(b as object).sort());
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

/** Count the reads a node makes of a store, by kind (sequence-0 point reads apart from other ranges). */
function counted(inner: EventStore) {
  const counts = { read: 0, readFrom: 0, seq0: 0, otherRange: 0, loadLatest: 0 };
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (prop === "read") counts.read++;
        if (prop === "readFrom") counts.readFrom++;
        if (prop === "readRange") {
          if (args[1] === 0 && args[2] === 0) counts.seq0++;
          else counts.otherRange++;
        }
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as EventStore;
  const reset = () => {
    counts.read = counts.readFrom = counts.seq0 = counts.otherRange = counts.loadLatest = 0;
  };
  return { store, counts, reset };
}

describe("an authorized call makes no more sequence-0 reads than before the verdict moved first", () => {
  // The verdict needs sequence 0 BEFORE the fold, so it is ONE indexed point read; every path then
  // reuses that envelope instead of reading it again. Counts are deterministic (a counting proxy over
  // the in-memory store); the expected numbers are those of the PRE-change runtime (949a0667) on the
  // same script, measured with this very test, so "no more than before" is a hard-coded comparison:
  //   loadState (snapshot present)      before: 2 (the fold's existence anchor + the owner read) -> 1
  //   resume, CARRIED stray scanner     before: 1 (the carried path's own read of sequence 0) -> 1
  //   resume, first (uncarried) call    before: 0 (the full read supplies sequence 0) -> now 1: the
  //                                     inherent cost of a verdict that precedes the full read
  //   resumeAs                          before: 0 (same) -> now 1, same reason (it reads the whole log)
  const twice = () =>
    flow("secret", async (ctx) => {
      await ctx.run(echo, { ssn: SECRET });
      await ctx.suspend({ on: "Go" });
      await ctx.suspend({ on: "Go2" });
      return null;
    });

  async function script() {
    const c = counted(new InMemoryAsyncEventStore());
    const n = node(c.store, new InMemoryAsyncSnapshotStore(), { snapshotEvery: 1 }, twice);
    await (await n.h.rt.start(n.f, {}, { executionId: E, principal: OWNER })).waitForSuspend();
    return { c, n };
  }

  it("loadState: one sequence-0 read where there were two", async () => {
    const { c, n } = await script();
    c.reset();
    await n.h.rt.loadState(E, { principal: OWNER });
    // before: { read: 0, readFrom: 1, seq0: 2 }. The verdict's anchor is handed to the fold, which
    // used to re-read it as its existence check, and to the owner lookup.
    expect(c.counts).toEqual({ read: 0, readFrom: 1, seq0: 1, otherRange: 0, loadLatest: 0 });
  });

  it("resume: the carried (hot) path reads sequence 0 once, as before; the first call pays one point read", async () => {
    const { c, n } = await script();
    c.reset();
    const h1 = await n.h.rt.resume(E, { eventType: "Go", payload: null }, { principal: OWNER });
    await h1.waitForSuspend();
    // before: { read: 1, readFrom: 1, seq0: 0 }; the only addition is the verdict's point read
    expect(c.counts).toEqual({ read: 1, readFrom: 1, seq0: 1, otherRange: 0, loadLatest: 0 });
    c.reset();
    const h2 = await n.h.rt.resume(E, { eventType: "Go2", payload: null }, { principal: OWNER });
    await h2.waitForCompletion?.();
    // before: { read: 2, readFrom: 1, seq0: 1, otherRange: 1 }: the carried path's own read of
    // sequence 0 is now the verdict's (`gated.first` is threaded into the scan), so the total is equal
    expect(c.counts).toEqual({ read: 2, readFrom: 1, seq0: 1, otherRange: 1, loadLatest: 0 });
  });
});

/** A store whose sequence-0 point read (the authorizer's anchor) fails while `fault.on` is set. */
function faulty(inner: EventStore, fail: () => unknown) {
  const fault = { on: false };
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (fault.on && prop === "readRange" && args[1] === 0 && args[2] === 0) {
          return Promise.reject(fail());
        }
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as EventStore;
  return { store, fault };
}

describe("a sequence-0 read that fails for a reason that is not an erasure is retryable, never a denial", () => {
  const CAUSE = "ECONNRESET db-primary.internal:5432 (tenant t1, workflow secret)";

  async function faultyWorld() {
    const inner = new InMemoryAsyncEventStore();
    const f = faulty(inner, () => new Error(CAUSE));
    const reports: unknown[] = [];
    const n = node(f.store, undefined, {
      onStorageError: (_id: string, e: unknown) => reports.push(e),
    });
    await (await n.h.rt.start(n.f, {}, { executionId: E, principal: OWNER })).waitForSuspend();
    return { inner, f, n, reports };
  }

  for (const [name, call] of OPS) {
    it(`${name}: the owner and a stranger get the SAME sanitized retryable error`, async () => {
      const w = await faultyWorld();
      const before = await kindsOf(w.inner);
      w.f.fault.on = true;
      const owner = await rejection(call(w.n, OWNER));
      const stranger = await rejection(call(w.n, STRANGER));
      w.f.fault.on = false;
      expect(nameOf(owner), "owner").toBe("ExecutionStoreUnavailableError");
      expect(owner).toBeInstanceOf(ExecutionStoreUnavailableError);
      expect((owner as { retryable?: unknown }).retryable).toBe(true);
      expect(shape(stranger)).toEqual(shape(owner));
      // no execution-derived detail, no cause, nothing of the fault
      for (const e of [owner, stranger]) {
        expect(Object.keys(e as object).sort()).toEqual(["executionId", "name", "op", "retryable"]);
        expect((e as Error).message).not.toContain("ECONNRESET");
        expect((e as Error).message).not.toContain("secret");
        expect((e as { cause?: unknown }).cause).toBeUndefined();
      }
      // not a denial: no audit callback, no EXECUTION_DENIED, nothing appended, no caller code run
      expect(w.n.denied).toEqual([]);
      expect(await kindsOf(w.inner)).toEqual(before);
      expect(transformCalls).toEqual([]);
      // the operator channel gets the real cause
      expect(w.reports.map((r) => (r as Error).message)).toContain(CAUSE);
    });
  }

  it("a missing id under a storage fault is NOT judged to exist (and not denied): retryable", async () => {
    const w = await faultyWorld();
    w.f.fault.on = true;
    const err = await rejection(w.n.h.rt.loadState("never-started", { principal: OWNER }));
    expect(nameOf(err)).toBe("ExecutionStoreUnavailableError");
    w.f.fault.on = false;
    expect(await w.n.h.rt.loadState("never-started", { principal: OWNER })).toBeNull();
  });

  it("the same owner succeeds once the fault clears", async () => {
    const w = await faultyWorld();
    w.f.fault.on = true;
    await rejection(w.n.h.rt.loadState(E, { principal: OWNER }));
    w.f.fault.on = false;
    expect((await w.n.h.rt.loadState(E, { principal: OWNER }))?.status).toBe("suspended");
  });

  describe("KeyUnavailableError at sequence 0", () => {
    // Through the runtime's real stack the seal guard (in front of every read) turns a
    // KeyUnavailableError into the denial-shaped sealed refusal (ADR 0130 D7), so the owner and a
    // stranger get the unknown-owner denial and `readAnchor` never sees the raw error.
    it("through the seal guard it is the sealed, denial-shaped refusal (unchanged)", async () => {
      const inner = new InMemoryAsyncEventStore();
      const f = faulty(inner, () => new KeyUnavailableError("alice", E, "secret"));
      const n = node(f.store);
      await (await n.h.rt.start(n.f, {}, { executionId: E, principal: OWNER })).waitForSuspend();
      f.fault.on = true;
      for (const who of [OWNER, STRANGER]) {
        const err = await rejection(n.h.rt.loadState(E, { principal: who }));
        expect(nameOf(err)).toBe("ExecutionDeniedError");
        expect(isSealedUnreadable(err)).toBe(true);
      }
    });

    // The defensive branch of `readAnchor` (a raw KeyUnavailableError reaching it, e.g. a future
    // store layering that bypasses the guard): reached by swapping the runtime's store for the raw one.
    const rawThrowing = (err: unknown): EventStore =>
      ({
        readRange: async () => {
          throw err;
        },
        read: async () => {
          throw err;
        },
        readFrom: async () => {
          throw err;
        },
      }) as never;
    const pending = (subjectId: string): EventEnvelope =>
      ({
        id: `${E}-0`,
        workflowId: "secret",
        executionId: E,
        eventType: "ERASURE_PENDING",
        sequence: 0,
        timestamp: 0,
        payload: { subjectId },
      }) as never;

    it("WITHOUT erasure proof it is retryable (the owner is not denied)", async () => {
      for (const err of [
        new KeyUnavailableError("alice", E, "secret"),
        new KeyUnavailableError("alice", E, "secret", [pending("someone-else")]),
      ]) {
        const n = node(new InMemoryAsyncEventStore());
        (n.h.rt as unknown as { eventStore: EventStore }).eventStore = rawThrowing(err);
        const owner = await rejection(n.h.rt.loadState(E, { principal: OWNER }));
        const stranger = await rejection(n.h.rt.loadState(E, { principal: STRANGER }));
        expect(nameOf(owner)).toBe("ExecutionStoreUnavailableError");
        expect(shape(stranger)).toEqual(shape(owner));
        expect(n.denied).toEqual([]);
      }
    });

    it("WITH the erase intent proven it is the unreadable (unknown-owner) path, workflow id from the redacted view", async () => {
      const n = node(new InMemoryAsyncEventStore());
      (n.h.rt as unknown as { eventStore: EventStore }).eventStore = rawThrowing(
        new KeyUnavailableError("alice", E, "secret", [pending("alice")])
      );
      // a denied cancel: the audit callback carries the plaintext workflow id
      const err = await rejection(n.h.rt.cancel(E, "x", { principal: STRANGER }));
      expect(nameOf(err)).toBe("ExecutionDeniedError");
      expect((err as { reason?: unknown }).reason).toBe(UNKNOWN_OWNER_REASON);
      expect(n.denied.map((d) => d.workflowId)).toEqual(["secret"]);
    });
  });

  describe("the workflow id of an unreadable sequence 0", () => {
    const view = (workflowId: string): EventEnvelope[] =>
      [
        {
          id: `${E}-0`,
          workflowId,
          executionId: E,
          eventType: "EXECUTION_STARTED",
          sequence: 0,
          timestamp: 0,
          payload: {},
        },
      ] as never;
    const shredded = (redacted?: EventEnvelope[]) => new PayloadShreddedError("alice", E, redacted);

    async function denyCancel(err: unknown) {
      const n = node(new InMemoryAsyncEventStore());
      (n.h.rt as unknown as { eventStore: EventStore }).eventStore = {
        readRange: async () => {
          throw err;
        },
      } as never;
      const r = await rejection(n.h.rt.cancel(E, "x", { principal: STRANGER }));
      expect(nameOf(r)).toBe("ExecutionDeniedError");
      return n.denied.map((d) => d.workflowId);
    }

    it("is the envelope's plaintext column, read from the redacted view the erasure error carries", async () => {
      expect(await denyCancel(shredded(view("secret")))).toEqual(["secret"]);
    });

    it("is the empty string only for a third-party decorator whose erasure error carries no view (documented)", async () => {
      expect(await denyCancel(shredded(undefined))).toEqual([""]);
    });
  });
});

describe("an AUTHORIZED caller keeps the old error where the verdict alone lets it through", () => {
  // `unknownOwner: "allow"` admits an execution whose principal is erased. acquireFence and fork used
  // to throw PayloadShreddedError there (they read sequence 0 unguarded); they still do.
  const allow = {
    executionAuthorizer: executionAccessPolicy({ ...POLICY, unknownOwner: "allow" }),
  };

  async function erasedWorld() {
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const events = new EncryptingEventStore(inner, keys, {
      sensitive: { STEP_COMPLETED: ["output"], EXECUTION_STARTED: PRINCIPAL_PATHS },
    });
    const opts = { principalIdentity: "encrypted", ...allow };
    const w = node(events, undefined, opts);
    await (await w.h.rt.start(w.f, {}, { executionId: E, principal: OWNER })).waitForSuspend();
    await shredSubject(keys, inner, E, { snapshotStore: { loadLatest: async () => null } });
    return node(events, undefined, opts);
  }

  it("acquireFence", async () => {
    const n = await erasedWorld();
    expect(nameOf(await rejection(n.h.rt.acquireFence(E, { principal: OWNER })))).toBe(
      "PayloadShreddedError"
    );
  });

  it("fork", async () => {
    const n = await erasedWorld();
    expect(nameOf(await rejection(n.h.rt.fork(E, 1, { principal: OWNER })))).toBe(
      "PayloadShreddedError"
    );
  });
});

describe("a 'missing' id never shows what an ORPHAN checkpoint would say", () => {
  // A retention sweep against a snapshot store without `deleteExecution` leaves a checkpoint behind
  // for an id with no log. Its load can fail (corrupt, key gone). A caller the authorizer is asked
  // about must get what any missing id gets; the kernel's system grant keeps the real error.
  const BOOM = "orphan checkpoint exploded";
  const orphanNode = () => {
    const raw = new InMemoryAsyncSnapshotStore();
    const broken: SnapshotStore = {
      ...raw,
      save: (s: never) => raw.save(s),
      loadLatest: async (id: string) => {
        if (id === "orphan") throw new Error(BOOM);
        return null;
      },
      loadAt: async () => null,
      loadLatestBefore: async () => null,
      close: async () => {},
    } as never;
    return node(new InMemoryAsyncEventStore(), broken);
  };
  const same = (a: unknown, b: unknown, ida: string, idb: string) => {
    const sa = shape(a);
    const sb = shape(b);
    return {
      a: {
        ...sa,
        message: sa.message.replaceAll(ida, "ID"),
        executionId: sa.executionId === ida ? "ID" : sa.executionId,
      },
      b: {
        ...sb,
        message: sb.message.replaceAll(idb, "ID"),
        executionId: sb.executionId === idb ? "ID" : sb.executionId,
      },
    };
  };

  it("loadState: an identified caller gets null, as for a truly missing id", async () => {
    const n = orphanNode();
    expect(await n.h.rt.loadState("orphan", { principal: STRANGER })).toBeNull();
    expect(await n.h.rt.loadState("nope", { principal: STRANGER })).toBeNull();
  });

  it("loadState: an anonymous caller (strict) gets the same denial for an orphan and a missing id", async () => {
    const n = orphanNode();
    const a = await rejection(n.h.rt.loadState("orphan", {}));
    const b = await rejection(n.h.rt.loadState("nope", {}));
    expect(nameOf(a)).toBe("ExecutionDeniedError");
    const s = same(a, b, "orphan", "nope");
    expect(s.a).toEqual(s.b);
    expect(String((a as Error).message)).not.toContain(BOOM);
  });

  it("resume: the same not-found for an orphan and a missing id", async () => {
    const n = orphanNode();
    const go = (id: string, who: Who | undefined) =>
      rejection(
        n.h.rt.resume(id, { eventType: "Go", payload: null }, who ? { principal: who } : {})
      );
    for (const who of [STRANGER, undefined]) {
      const a = await go("orphan", who);
      const b = await go("nope", who);
      const s = same(a, b, "orphan", "nope");
      expect(s.a).toEqual(s.b);
      expect(String((a as Error).message)).not.toContain(BOOM);
    }
  });

  it("the kernel's system grant keeps the real checkpoint error", async () => {
    const n = orphanNode();
    const err = await rejection(n.h.rt.loadState("orphan", n.h.rt.systemOptions()));
    expect((err as Error).message).toBe(BOOM);
  });
});

// ── FU-B (ADR 0039 amendment 2026-10-17, second) ────────────────────────────────────────────────
// Reading sequence 0 fine and THEN failing to resolve the owner (the principal resolver throws, a
// lineage hop's store read fails) is the same kind of fault as a failed anchor read: no evidence about
// the execution. It used to become an "unknown owner" (denying the REAL owner, and ADMITTING a stranger
// under `unknownOwner: "allow"`). It is now the sanitized, retryable ExecutionStoreUnavailableError.

describe("an owner-resolution fault AFTER sequence 0 read fine is retryable, never an unknown owner", () => {
  const CAUSE = "resolver backend ECONNREFUSED idp.internal:443 (tenant t1, workflow secret)";

  async function resolverWorld(extra: Record<string, unknown> = {}) {
    const inner = new InMemoryAsyncEventStore();
    const fault = { on: false, error: () => new Error(CAUSE) as unknown };
    const reports: unknown[] = [];
    const opts = {
      principalResolver: {
        resolve: (rec: { identity?: Record<string, string> }) => {
          if (fault.on) throw fault.error();
          return rec.identity !== undefined ? { ...rec.identity } : undefined;
        },
      },
      onStorageError: (_id: string, e: unknown) => reports.push(e),
      ...extra,
    };
    const first = node(inner, undefined, opts);
    await (
      await first.h.rt.start(first.f, {}, { executionId: E, principal: OWNER })
    ).waitForSuspend();
    // a fresh node over the same log: no live start record, so the owner is read and RESOLVED
    return { inner, fault, reports, n: node(inner, undefined, opts) };
  }

  for (const [name, call] of OPS) {
    it(`${name}: a resolver fault is the same sanitized retryable error for the owner and a stranger; the owner succeeds after`, async () => {
      transformCalls.length = 0; // the module-level spy: the previous op's RETRY may have run it
      const w = await resolverWorld();
      const before = await kindsOf(w.inner);
      w.fault.on = true;
      const owner = await rejection(call(w.n, OWNER));
      const stranger = await rejection(call(w.n, STRANGER));
      w.fault.on = false;
      expect(nameOf(owner), "owner").toBe("ExecutionStoreUnavailableError");
      expect(owner).toBeInstanceOf(ExecutionStoreUnavailableError);
      expect((owner as { retryable?: unknown }).retryable).toBe(true);
      expect(shape(stranger), "a stranger learns nothing the owner does not").toEqual(shape(owner));
      for (const e of [owner, stranger]) {
        expect(Object.keys(e as object).sort()).toEqual(["executionId", "name", "op", "retryable"]);
        expect((e as Error).message).not.toContain("ECONNREFUSED");
        expect((e as Error).message).not.toContain("secret");
        expect((e as { cause?: unknown }).cause).toBeUndefined();
      }
      // not a denial: no audit callback, nothing appended, no caller code run
      expect(w.n.denied).toEqual([]);
      expect(await kindsOf(w.inner)).toEqual(before);
      expect(transformCalls).toEqual([]);
      // the operator channel gets the real cause
      expect(w.reports.map((r) => (r as Error).message)).toContain(CAUSE);
      // the retry, with the fault cleared, is neither the fault nor a denial
      const retry = await rejection(call(w.n, OWNER));
      expect(nameOf(retry), "retry").not.toBe("ExecutionStoreUnavailableError");
      expect(nameOf(retry), "retry").not.toBe("ExecutionDeniedError");
    });
  }

  it("loadState: the owner reads the state once the resolver recovers", async () => {
    const w = await resolverWorld();
    w.fault.on = true;
    expect(nameOf(await rejection(w.n.h.rt.loadState(E, { principal: OWNER })))).toBe(
      "ExecutionStoreUnavailableError"
    );
    w.fault.on = false;
    expect((await w.n.h.rt.loadState(E, { principal: OWNER }))?.status).toBe("suspended");
  });

  it("a fault is NEVER an allow: a stranger under unknownOwner 'allow' gets the retryable error, not the state", async () => {
    const w = await resolverWorld({
      executionAuthorizer: executionAccessPolicy({ ...POLICY, unknownOwner: "allow" }),
    });
    w.fault.on = true;
    for (const [name, call] of OPS) {
      const err = await rejection(call(w.n, STRANGER));
      expect(nameOf(err), name).toBe("ExecutionStoreUnavailableError");
    }
    // ...and once the resolver is back the owner is known, so the stranger is refused as usual
    w.fault.on = false;
    expect(nameOf(await rejection(w.n.h.rt.loadState(E, { principal: STRANGER })))).toBe(
      "ExecutionDeniedError"
    );
  });

  it("a resolver error that is a proven ERASURE is still an unknown owner (the policy decides), as before", async () => {
    const w = await resolverWorld();
    w.fault.error = () =>
      Object.assign(new Error("subject erased"), { name: "PayloadShreddedError" });
    w.fault.on = true;
    const err = await rejection(w.n.h.rt.loadState(E, { principal: STRANGER }));
    expect(nameOf(err)).toBe("ExecutionDeniedError");
    expect((err as { reason?: unknown }).reason).toBe(UNKNOWN_OWNER_REASON);
    expect(w.reports).toEqual([]);
  });

  it("the system grant never consults the resolver, so it is unchanged by the fault", async () => {
    const w = await resolverWorld();
    w.fault.on = true;
    const sys = w.n.h.rt.systemOptions();
    expect((await w.n.h.rt.loadState(E, sys))?.status).toBe("suspended");
    expect(w.reports).toEqual([]);
  });

  describe("a lineage hop (the parent's sequence 0) that faults", () => {
    const CHILD = "authz-child";
    async function lineageWorld() {
      const inner = new InMemoryAsyncEventStore();
      const fault = { on: false };
      const reports: unknown[] = [];
      // only the PARENT's sequence 0 fails: the child's own anchor reads fine
      const store = new Proxy(inner, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver);
          if (typeof v !== "function") return v;
          return (...args: unknown[]) =>
            fault.on && prop === "readRange" && args[0] === E && args[1] === 0 && args[2] === 0
              ? Promise.reject(new Error(CAUSE))
              : (v as (...a: unknown[]) => unknown).apply(target, args);
        },
      }) as unknown as EventStore;
      const opts = { onStorageError: (_id: string, e: unknown) => reports.push(e) };
      const a = node(inner, undefined, opts);
      await (await a.h.rt.start(a.f, {}, { executionId: E, principal: OWNER })).waitForSuspend();
      await (
        await a.h.rt.start(
          a.f,
          {},
          { executionId: CHILD, parentExecutionId: E, ...a.h.rt.systemOptions() }
        )
      ).waitForSuspend();
      return { inner, fault, reports, n: node(store, undefined, opts) };
    }

    it("the parent's owner is told to retry (not denied) and succeeds after; a stranger gets the same error", async () => {
      const w = await lineageWorld();
      // sanity: the parent's owner may read the child (ADR 0111 D6) while the chain reads fine
      expect((await w.n.h.rt.loadState(CHILD, { principal: OWNER }))?.status).toBe("suspended");
      w.fault.on = true;
      const owner = await rejection(w.n.h.rt.loadState(CHILD, { principal: OWNER }));
      const stranger = await rejection(w.n.h.rt.loadState(CHILD, { principal: STRANGER }));
      expect(nameOf(owner)).toBe("ExecutionStoreUnavailableError");
      expect(shape(stranger)).toEqual(shape(owner));
      expect((owner as { op?: unknown }).op).toBe("query");
      expect(w.n.denied).toEqual([]);
      expect(w.reports.map((r) => (r as Error).message)).toContain(CAUSE);
      w.fault.on = false;
      expect((await w.n.h.rt.loadState(CHILD, { principal: OWNER }))?.status).toBe("suspended");
    });
  });
});

describe("an AUTHORIZED caller on an ERASED anchor keeps PayloadShreddedError (the authorizer lets it through)", () => {
  // `unknownOwner: "allow"` admits an execution whose principal is erased. The shared helper then
  // RE-READS the anchor so the caller gets the very error it got before the authorizer moved first,
  // never "No execution found" for an execution that exists.
  const allow = {
    executionAuthorizer: executionAccessPolicy({ ...POLICY, unknownOwner: "allow" }),
  };
  async function erased() {
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const events = new EncryptingEventStore(inner, keys, {
      sensitive: { STEP_COMPLETED: ["output"], EXECUTION_STARTED: PRINCIPAL_PATHS },
    });
    const opts = { principalIdentity: "encrypted", ...allow };
    const w = node(events, undefined, opts);
    await (await w.h.rt.start(w.f, {}, { executionId: E, principal: OWNER })).waitForSuspend();
    await shredSubject(keys, inner, E, { snapshotStore: { loadLatest: async () => null } });
    return node(events, undefined, opts);
  }
  const cases: Array<[string, (n: Node) => Promise<unknown>]> = [
    ["send", (n) => n.h.rt.send(E, { topic: "t", payload: "x" }, { principal: OWNER })],
    [
      "discardInbox",
      (n) => n.h.rt.discardInbox(E, { topic: "t", throughSeq: 1 }, { principal: OWNER }),
    ],
    ["quarantineInbox", (n) => n.h.rt.quarantineInbox(E, { topic: "t" }, { principal: OWNER })],
    [
      "releaseInbox",
      (n) => n.h.rt.releaseInbox(E, { topic: "t", messageId: "m" }, { principal: OWNER }),
    ],
    [
      "recordOutcome",
      (n) =>
        n.h.rt.recordOutcome(E, { decisionId: "d", key: "k", success: true }, { principal: OWNER }),
    ],
  ];
  for (const [name, call] of cases) {
    it(name, async () => {
      const n = await erased();
      const err = await rejection(call(n));
      expect(nameOf(err)).toBe("PayloadShreddedError");
      expect(n.denied).toEqual([]);
    });
  }
});
