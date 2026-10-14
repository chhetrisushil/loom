import type { ExecutionState } from "@loom/core";
import { type EventStore, InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { build, echo, flow } from "./__tests__/r2Harness";
import { UNKNOWN_OWNER_REASON, executionAccessPolicy } from "./executionAccessPolicy";
import { isSealedUnreadable } from "./sealGuard";
import { sealedDetailOf } from "./sealGuard";

// ADR 0130 residuals D7 - EVERY public op that can read a stream turns a sealed refusal into the
// denial an ordinary existing id with an UNKNOWN OWNER gets, compared field by field against that
// real denial (not against a freshly constructed error).

const SECRET = "123-45-6789";
const FULL = {
  EXECUTION_STARTED: ["input"],
  STEP_STARTED: ["input"],
  STEP_COMPLETED: ["output"],
};
const STRANGER = { actor: "mallory", tenant: "t9" };
const OWNER = { actor: "alice", tenant: "t1" };

const secret = () =>
  flow("secret", async (ctx) => {
    await ctx.run(echo, { ssn: SECRET });
    await ctx.suspend({ on: "Go" });
    return null;
  });

type Denied = { op: string; executionId: string; principal: unknown; reason: unknown };

/** A node over `store`, with a strict authorizer; records every audit callback. */
function node(
  store: EventStore,
  timers = new InMemoryTimerStore(),
  policy: Parameters<typeof executionAccessPolicy>[0] = { rules: { discard: "tenant" } }
) {
  const denied: Denied[] = [];
  const f = secret();
  const h = build(
    {
      // `discard` opened to `tenant` so the baseline is an OWNER denial: the default `discard: "deny"`
      // is an op-level rule that answers before ownership, which a refusal that never consults the
      // policy cannot reproduce (stated residual, ADR 0130 D7).
      executionAuthorizer: executionAccessPolicy(policy),
      executionAuthz: { requirePrincipal: true },
      onExecutionDenied: (
        r: { op: string; executionId: string; principal?: unknown },
        reason?: string
      ) => denied.push({ op: r.op, executionId: r.executionId, principal: r.principal, reason }),
    },
    { eventStore: store, snapshotStore: new InMemoryAsyncSnapshotStore(), timers }
  );
  h.rt.registerFlow(f.definition, f.runner);
  return { h, f, denied };
}

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e
  );

const shape = (e: unknown) => {
  const err = e as Error & { op?: unknown; reason?: unknown; executionId?: unknown };
  return {
    ctor: Object.getPrototypeOf(err) === Error.prototype ? "Error" : err.name,
    name: err.name,
    message: err.message,
    keys: Object.keys(err).sort(),
    json: JSON.stringify(err),
    op: err.op,
    reason: err.reason,
    executionId: err.executionId,
  };
};

const fakeState = (e: string): ExecutionState =>
  ({
    executionId: e,
    workflowId: "secret",
    workflowVersion: "1.0.0",
    status: "suspended",
    sequence: 3,
    variables: {},
  }) as never;

describe("a sealed refusal is indistinguishable from an unknown-owner denial of an existing id", () => {
  for (const kind of ["raw", "wrongKey", "narrower"] as const) {
    it(`${kind} node: every public op`, async () => {
      // the baseline: an ordinary PLAINTEXT existing id started with no principal (owner unknown)
      const plainInner = new InMemoryAsyncEventStore();
      const E = "shape-1";
      const f0 = secret();
      const setup = build(
        {},
        { eventStore: plainInner, snapshotStore: new InMemoryAsyncSnapshotStore() }
      );
      setup.rt.registerFlow(f0.definition, f0.runner);
      await (await setup.rt.start(f0, {}, { executionId: E })).waitForSuspend();
      const base = node(plainInner);

      // the sealed world: the same id, sealed by a capable node, read by `kind`
      const inner = new InMemoryAsyncEventStore();
      const keys = new InMemoryKeyStore();
      const owner = node(new EncryptingEventStore(inner, keys, { sensitive: FULL }));
      await (
        await owner.h.rt.start(owner.f, {}, { executionId: E, principal: OWNER })
      ).waitForSuspend();
      const incapable: EventStore =
        kind === "raw"
          ? inner
          : new EncryptingEventStore(inner, kind === "wrongKey" ? new InMemoryKeyStore() : keys, {
              sensitive: kind === "wrongKey" ? FULL : { UNRELATED: ["x"] },
            });
      const before = JSON.stringify(await inner.read(E));
      const sealed = node(incapable);

      const calls: Array<[string, (n: ReturnType<typeof node>) => Promise<unknown>]> = [
        ["loadState", (n) => n.h.rt.loadState(E, { principal: STRANGER })],
        ["parkedAtSequence", (n) => n.h.rt.parkedAtSequence(E, { principal: STRANGER })],
        ["followToHead", (n) => n.h.rt.followToHead(E, { principal: STRANGER })],
        [
          "resume",
          (n) => n.h.rt.resume(E, { eventType: "Go", payload: null }, { principal: STRANGER }),
        ],
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
        ["start", (n) => n.h.rt.start(n.f, {}, { executionId: E, principal: STRANGER })],
      ];
      for (const [name, call] of calls) {
        base.denied.length = 0;
        sealed.denied.length = 0;
        const want = await rejection(call(base));
        const got = await rejection(call(sealed));
        expect(want, `${name}: baseline must refuse`).toBeInstanceOf(Error);
        expect(got, `${name}: sealed must refuse`).toBeInstanceOf(Error);
        // everything a caller can observe is that of the ordinary refusal
        expect(shape(got), name).toEqual(shape(want));
        // the audit callback: same op / id / principal / reason (workflowId is unreadable here)
        expect(sealed.denied, name).toEqual(base.denied);
        // the operator channel is the ONLY difference, and it carries the real cause
        if (isSealedUnreadable(got)) {
          expect(sealedDetailOf(got), name).toBeDefined();
        }
      }
      // the operator channel (and only it) carries the real cause: first refusal, then every 16th
      expect(sealed.h.storageErrors.length).toBeGreaterThanOrEqual(1);
      expect(base.h.storageErrors).toHaveLength(0);
      expect(JSON.stringify(await inner.read(E))).toBe(before); // nothing appended, ever
    });
  }
});

// ADR 0130 D7 (user ruling 2026-10-14): the sealed refusal is PHRASED by consulting the policy with
// the owner UNSET (what an ordinary unknown-owner execution produces), never the sealed principal;
// the refusal itself is unconditional.
describe("a sealed refusal is worded as the ordinary unknown-owner call of the same op", () => {
  async function world(policy: Parameters<typeof executionAccessPolicy>[0]) {
    const E = "shape-op";
    const plainInner = new InMemoryAsyncEventStore();
    const f0 = secret();
    const setup = build(
      {},
      { eventStore: plainInner, snapshotStore: new InMemoryAsyncSnapshotStore() }
    );
    setup.rt.registerFlow(f0.definition, f0.runner);
    await (await setup.rt.start(f0, {}, { executionId: E })).waitForSuspend();
    const base = node(plainInner, new InMemoryTimerStore(), policy);
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const owner = node(new EncryptingEventStore(inner, keys, { sensitive: FULL }));
    await (
      await owner.h.rt.start(owner.f, {}, { executionId: E, principal: OWNER })
    ).waitForSuspend();
    const sealed = node(inner, new InMemoryTimerStore(), policy);
    return { E, base, sealed, inner };
  }

  it("discard: deny gives the op-level 'not permitted' wording, as the ordinary call does", async () => {
    const { E, base, sealed, inner } = await world({ rules: { discard: "deny" } });
    const before = JSON.stringify(await inner.read(E));
    const call = (n: ReturnType<typeof node>) =>
      n.h.rt.discardInbox(E, { topic: "t", throughSeq: 1 }, { principal: STRANGER });
    const want = await rejection(call(base));
    const got = await rejection(call(sealed));
    expect((want as Error).message).toContain("not permitted");
    expect(shape(got)).toEqual(shape(want));
    expect(sealed.denied).toEqual(base.denied);
    expect(isSealedUnreadable(got)).toBe(true);
    expect(JSON.stringify(await inner.read(E))).toBe(before);
  });

  it("unknownOwner: allow still refuses, with the generic unknown-owner wording", async () => {
    const { E, base, sealed } = await world({
      unknownOwner: "allow",
      rules: { discard: "deny" },
    });
    // the ordinary call on a plaintext unknown-owner id is ALLOWED by this policy
    expect(await base.h.rt.loadState(E, { principal: STRANGER })).not.toBeNull();
    const got = await rejection(sealed.h.rt.loadState(E, { principal: STRANGER }));
    expect(isSealedUnreadable(got)).toBe(true);
    expect((got as Error).message).toContain(UNKNOWN_OWNER_REASON);
    // an op the policy denies outright keeps ITS wording even here
    const d = await rejection(
      sealed.h.rt.discardInbox(E, { topic: "t", throughSeq: 1 }, { principal: STRANGER })
    );
    expect((d as Error).message).toContain("not permitted");
  });
});
