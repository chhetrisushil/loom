import type { FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import {
  EncryptingEventStore,
  EncryptingSnapshotStore,
  InMemoryKeyStore,
} from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import {
  type ExecutionAuthorizer,
  type ExecutionAuthzRequest,
  ExecutionDeniedError,
  type FlowRunner,
  type PrincipalCodec,
  type RegisteredFlow,
  WorkflowRuntime,
  executionAccessPolicy,
} from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig } from "./defineConfig";

// ── ADR 0130 residuals, S0 — a PROBE, not a fix ─────────────────────────────────────────────
//
// `defineConfig` crypto seals the principal's identity (`principal.identity.*` on
// EXECUTION_STARTED, `recordedBy` on OUTCOME_RECORDED; principalPolicy.ts:99-101). A node WITHOUT the
// crypto key reads that log through a RAW store, so the owner it reads is the sealed envelope, not a
// tenant. Does the execution authorizer (keyed on the owner's tenant) fail CLOSED there?
//
// Each case's name states the outcome observed TODAY. Outcomes: allowed, denied (typed
// ExecutionDeniedError), crashed (any other error).

const io = { inputSchema: z.any(), outputSchema: z.any() };
const T1 = { actor: "alice", tenant: "t1" };
const T2 = { actor: "mallory", tenant: "t2" };

const parkDef: FlowDefinition<unknown, unknown> = {
  _tag: "FlowDefinition",
  id: "park",
  name: "park",
  version: "1.0.0",
  ...io,
  steps: [],
};
const parkRunner: FlowRunner<unknown, unknown> = async (ctx) => {
  await ctx.suspend({ on: "Go" });
  await ctx.receive("m");
  return { done: true };
};
const decideDef: FlowDefinition<unknown, unknown> = { ...parkDef, id: "decide", name: "decide" };
const decideRunner: FlowRunner<unknown, unknown> = async (ctx) => {
  await ctx.decide("route", () => "a");
  return { done: true };
};
const parkFlow = { definition: parkDef, runner: parkRunner } as RegisteredFlow;
const decideFlow = { definition: decideDef, runner: decideRunner } as RegisteredFlow;

type Outcome = "allowed" | "denied" | "crashed";

async function outcomeOf(
  fn: () => Promise<unknown>
): Promise<{ outcome: Outcome; error?: unknown }> {
  try {
    await fn();
    return { outcome: "allowed" };
  } catch (error) {
    return { outcome: error instanceof ExecutionDeniedError ? "denied" : "crashed", error };
  }
}

/** The same policy on both nodes, wrapped to record the owner the kernel handed it. */
function spyPolicy(unknownOwner?: "allow") {
  const owners: Array<{ op: string; executionId: string; owner: unknown }> = [];
  const inner = executionAccessPolicy({
    rules: { discard: "tenant", annotate: "tenant" },
    ...(unknownOwner !== undefined && { unknownOwner }),
  });
  const authorizer: ExecutionAuthorizer = {
    authorize: (req: ExecutionAuthzRequest) => {
      owners.push({ op: req.op, executionId: req.executionId, owner: req.owner });
      return inner.authorize(req);
    },
  };
  return { authorizer, owners };
}

/**
 * "crypto"  — node A seals the identity (defineConfig crypto); node B reads the RAW store, no key.
 * "codec"   — node A has a `principalCodec` and NO crypto (log holds an opaque ref); B has NO codec.
 * "codecB"  — as "codec" but B HAS the codec (the positive control for the ref path).
 * "wrongKey" — node A seals; B reads through an Encrypting store holding a DIFFERENT, empty KeyStore.
 */
type Mode = "crypto" | "codec" | "codecB" | "wrongKey";

/** A tenant/actor <-> opaque ref codec: the identity lives in the ref, never as `identity` in the log. */
const codec: PrincipalCodec = {
  toRef: (c) => `r:${String(c.tenant)}:${String(c.actor)}`,
  fromRef: (ref) => {
    const [, tenant, actor] = ref.split(":");
    return { tenant: tenant ?? "", actor: actor ?? "" };
  },
};

async function boot(mode: Mode = "crypto", unknownOwner?: "allow") {
  const raw = new InMemoryAsyncEventStore();
  const rawSnaps = new InMemoryAsyncSnapshotStore();
  const timerStore = new InMemoryTimerStore();
  const keys = new InMemoryKeyStore();
  const sealed = mode === "crypto" || mode === "wrongKey";
  const events = sealed ? new EncryptingEventStore(raw, keys, { sensitive: {} }) : raw;
  const snaps = sealed ? new EncryptingSnapshotStore(rawSnaps, keys, { sensitive: [] }) : rawSnaps;
  const spyA = spyPolicy(unknownOwner);

  // Node A: defineConfig. Crypto registers the principal identity + recordedBy paths; the codec
  // path records only an opaque ref (strict stays off: it is not what is under test).
  const a = defineConfig({
    storage: { kind: "custom", eventStore: events, snapshotStore: snaps },
    timers: { store: timerStore },
    flows: [parkFlow, decideFlow],
    autostart: false,
    security: {
      strict: false,
      ...(sealed
        ? {
            crypto: {
              events: events as EncryptingEventStore,
              snapshots: snaps as EncryptingSnapshotStore,
            },
          }
        : { principalCodec: codec }),
      executionAuthorizer: spyA.authorizer,
    },
    kernel: { features: { inbox: true } },
    observability: { onWarn: () => {} },
  });

  // Node B: the SAME stores through a store that cannot open the principal, the SAME policy, strict
  // (`requirePrincipal`), and the same identity mode, so it reads sequence 0 as written.
  const spyB = spyPolicy(unknownOwner);
  const eventsB =
    mode === "wrongKey"
      ? new EncryptingEventStore(raw, new InMemoryKeyStore(), { sensitive: {} })
      : raw;
  const snapsB =
    mode === "wrongKey"
      ? new EncryptingSnapshotStore(rawSnaps, new InMemoryKeyStore(), { sensitive: [] })
      : rawSnaps;
  const b = new WorkflowRuntime({
    eventStore: eventsB,
    snapshotStore: snapsB,
    effectRuntime: new EffectRuntime([]),
    timerStore,
    executionAuthorizer: spyB.authorizer,
    executionAuthz: { requirePrincipal: true },
    principalIdentity: sealed ? "encrypted" : "ref",
    ...(mode === "codecB" && { principalCodec: codec }),
    inboxEnabled: true,
  });
  b.registerFlow(parkDef, parkRunner);
  b.registerFlow(decideDef, decideRunner);

  return { a, b, raw, rawSnaps, ownersB: spyB.owners, close: () => a.close() };
}

type Ctx = Awaited<ReturnType<typeof boot>>;

async function parked(c: Ctx, id: string): Promise<void> {
  const h = await c.a.runtime.start(parkFlow, {}, { executionId: id, principal: T1 });
  await h.waitForSuspend();
  await c.a.runtime.send(
    id,
    { topic: "m", payload: "hello", messageId: `${id}-m` },
    { principal: T1 }
  );
}

const OPS = ["loadState", "send", "resume", "cancel", "discardInbox"] as const;
type Op = (typeof OPS)[number];

function run(c: Ctx, op: Op, id: string, who: typeof T1) {
  const rt = c.b;
  switch (op) {
    case "loadState":
      return () => rt.loadState(id, { principal: who });
    case "send":
      return () => rt.send(id, { topic: "m", payload: "x" }, { principal: who });
    case "resume":
      return () => rt.resume(id, { eventType: "Go", payload: {} }, { principal: who });
    case "cancel":
      return () => rt.cancel(id, "probe", { principal: who });
    case "discardInbox":
      return () => rt.discardInbox(id, { topic: "m", throughSeq: 1 }, { principal: who });
  }
}

/** Events a denied op may append: resume/cancel record one best-effort EXECUTION_DENIED; the rest write nothing. */
const APPENDED: Record<Op, string[]> = {
  loadState: [],
  send: [],
  resume: ["EXECUTION_DENIED"],
  cancel: ["EXECUTION_DENIED"],
  discardInbox: [],
};

const WHO = [
  ["T1 (the owner's tenant)", T1],
  ["T2 (a stranger)", T2],
] as const;

/** Every op is DENIED (typed, owner-unknown), the policy saw owner===undefined, and only the expected facts landed. */
function denyMatrix(title: string, mode: Mode) {
  describe(title, () => {
    for (const op of OPS) {
      for (const [n, who] of WHO) {
        it(`${op} is DENIED (typed, owner unknown) for ${n}`, async () => {
          const c = await boot(mode);
          try {
            const id = `${mode}-${op}-${n.slice(0, 2)}`;
            await parked(c, id);
            const before = await c.raw.read(id);
            const r = await outcomeOf(run(c, op, id, who));
            expect(r.outcome).toBe("denied");
            expect((r.error as ExecutionDeniedError).reason).toMatch(/owner is unknown/);
            const seen = c.ownersB.filter((o) => o.executionId === id);
            expect(seen.length).toBeGreaterThan(0);
            for (const o of seen) expect(o.owner).toBeUndefined();
            const added = (await c.raw.read(id)).slice(before.length).map((e) => e.eventType);
            expect(added).toEqual(APPENDED[op]);
          } finally {
            await c.close();
          }
        });
      }
    }

    // OUTCOME_RECORDED.recordedBy variant: a late reward on a finished execution (op "annotate").
    for (const [n, who] of WHO) {
      it(`recordOutcome is DENIED (typed, owner unknown) for ${n}`, async () => {
        const c = await boot(mode);
        try {
          const id = `${mode}-o-${n.slice(0, 2)}`;
          const h = await c.a.runtime.start(decideFlow, {}, { executionId: id, principal: T1 });
          await h.waitForCompletion();
          const before = (await c.raw.read(id)).length;
          const r = await outcomeOf(() =>
            c.b.recordOutcome(
              id,
              { decisionId: "route", key: "a", success: true },
              { principal: who }
            )
          );
          expect(r.outcome).toBe("denied");
          expect((r.error as ExecutionDeniedError).reason).toMatch(/owner is unknown/);
          // No EXECUTION_DENIED audit fact for "annotate" by design (WorkflowRuntime.recordOutcome
          // passes recordAfterSequence undefined): the log is a finished execution's evidence and a
          // denied writer must leave it untouched. Only the onExecutionDenied callback fires.
          expect((await c.raw.read(id)).length).toBe(before);
          const seen = c.ownersB.filter((o) => o.executionId === id && o.op === "annotate");
          expect(seen.length).toBeGreaterThan(0);
          for (const o of seen) expect(o.owner).toBeUndefined();
        } finally {
          await c.close();
        }
      });
    }
  });
}

describe("S0 — a sealed/opaque principal read by a node that cannot open it (same strict authorizer)", () => {
  it("control: the sealed identity really is an envelope in the raw log, and the snapshot is ciphertext too", async () => {
    const c = await boot();
    try {
      await parked(c, "ctl");
      const first = (await c.raw.read("ctl"))[0];
      const text = JSON.stringify(first?.payload);
      expect(text).toContain("__loomEnc");
      // JSON-quoted: base64 ciphertext never contains `"`, so a random `t1` inside it cannot match.
      expect(text).not.toContain('"t1"');
      expect(text).not.toContain('"alice"');
      const snap = await c.rawSnaps.loadLatest("ctl");
      expect(snap).not.toBeNull();
      const snapText = JSON.stringify(snap);
      expect(snapText).toContain("__loomEnc");
      expect(snapText).not.toContain('"t1"');
      expect(snapText).not.toContain('"alice"');
    } finally {
      await c.close();
    }
  });

  it("control: node A (has the key) allows T1 and DENIES T2 on loadState", async () => {
    const c = await boot();
    try {
      await parked(c, "ctl2");
      expect(
        (await outcomeOf(() => c.a.runtime.loadState("ctl2", { principal: T1 }))).outcome
      ).toBe("allowed");
      expect(
        (await outcomeOf(() => c.a.runtime.loadState("ctl2", { principal: T2 }))).outcome
      ).toBe("denied");
    } finally {
      await c.close();
    }
  });

  // Note it also denies the legitimate owner (T1): closed, not correct.
  denyMatrix("crypto: raw node WITHOUT the key", "crypto");

  // A node whose KeyStore cannot open the log (decrypt-failure path). OBSERVED: only cancel is a typed denial.
  // The store throws PayloadShreddedError while reading the execution (snapshot or inbox stream)
  // before / instead of the authorizer's verdict, so the op CRASHES: closed (nothing runs, nothing is
  // appended), but with a store error rather than ExecutionDeniedError.
  describe("crypto: node holding a DIFFERENT (empty) KeyStore (decrypt-failure path)", () => {
    for (const op of OPS) {
      for (const [n, who] of WHO) {
        const name =
          op === "cancel"
            ? `cancel is DENIED (typed, owner unknown; cancel reads no decrypting stream first) for ${n}`
            : `${op} CRASHES with PayloadShreddedError (not allowed, not typed-denied) for ${n}`;
        it(name, async () => {
          const c = await boot("wrongKey");
          try {
            const id = `wk-${op}-${n.slice(0, 2)}`;
            await parked(c, id);
            const before = await c.raw.read(id);
            const r = await outcomeOf(run(c, op, id, who));
            if (op === "cancel") {
              expect(r.outcome).toBe("denied");
              expect((r.error as ExecutionDeniedError).reason).toMatch(/owner is unknown/);
              const added = (await c.raw.read(id)).slice(before.length).map((e) => e.eventType);
              expect(added).toEqual(["EXECUTION_DENIED"]);
              return;
            }
            expect(r.outcome).toBe("crashed");
            expect((r.error as Error).name).toBe("PayloadShreddedError");
            expect(await c.raw.read(id)).toEqual(before);
          } finally {
            await c.close();
          }
        });
      }
    }
  });

  describe("principalCodec (no crypto): the log holds an opaque ref", () => {
    it("control: the raw log records only { v, ref }, never an identity", async () => {
      const c = await boot("codec");
      try {
        await parked(c, "cref");
        const rec = JSON.stringify((await c.raw.read("cref"))[0]?.payload);
        expect(rec).toContain("r:t1:alice");
        expect(rec).not.toContain('"identity"');
        expect(rec).not.toContain("__loomEnc");
      } finally {
        await c.close();
      }
    });

    it("control: node B WITH the codec ALLOWS T1 and DENIES T2, the policy sees the real owner", async () => {
      const c = await boot("codecB");
      try {
        await parked(c, "cb");
        expect((await outcomeOf(run(c, "loadState", "cb", T1))).outcome).toBe("allowed");
        const t2 = await outcomeOf(run(c, "loadState", "cb", T2));
        expect(t2.outcome).toBe("denied");
        expect((t2.error as ExecutionDeniedError).reason).not.toMatch(/owner is unknown/);
        for (const o of c.ownersB.filter((x) => x.executionId === "cb")) {
          expect(o.owner).toEqual({ tenant: "t1", actor: "alice" });
        }
      } finally {
        await c.close();
      }
    });
  });
  denyMatrix("principalCodec: node B has NO codec", "codec");

  // The closed result rests on the policy's `unknownOwner: "deny"` default, NOT on the kernel
  // recognising the envelope. A policy that opts into `unknownOwner: "allow"` is fail-OPEN on a
  // sealed principal for a stranger. That is the operator's explicit choice, recorded here so S2
  // knows the kernel itself offers no second line of defence.
  it("with unknownOwner:'allow' a raw node ALLOWS T2 (a stranger) on loadState: closed only by the policy default", async () => {
    const c = await boot("crypto", "allow");
    try {
      await parked(c, "open");
      const before = await c.raw.read("open");
      expect((await outcomeOf(run(c, "loadState", "open", T2))).outcome).toBe("allowed");
      const seen = c.ownersB.filter((o) => o.executionId === "open");
      expect(seen.length).toBeGreaterThan(0);
      for (const o of seen) expect(o.owner).toBeUndefined();
      expect(await c.raw.read("open")).toEqual(before);
    } finally {
      await c.close();
    }
  });
});
