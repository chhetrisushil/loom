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

/** Waits on a condition, never a fixed sleep. */
async function until(cond: () => Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("until: condition not met");
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

async function boot(unknownOwner?: "allow") {
  const raw = new InMemoryAsyncEventStore();
  const rawSnaps = new InMemoryAsyncSnapshotStore();
  const timerStore = new InMemoryTimerStore();
  const keys = new InMemoryKeyStore();
  const events = new EncryptingEventStore(raw, keys, { sensitive: {} });
  const snaps = new EncryptingSnapshotStore(rawSnaps, keys, { sensitive: [] });

  // Node A: defineConfig + crypto (this registers the principal identity + recordedBy paths).
  const a = defineConfig({
    storage: { kind: "custom", eventStore: events, snapshotStore: snaps },
    timers: { store: timerStore },
    flows: [parkFlow, decideFlow],
    autostart: false,
    security: {
      strict: false,
      crypto: { events, snapshots: snaps },
      executionAuthorizer: spyPolicy(unknownOwner).authorizer,
    },
    kernel: { features: { inbox: true } },
    observability: { onWarn: () => {} },
  });

  // Node B: the SAME stores through the RAW (non-decrypting) store, the SAME policy, strict
  // (`requirePrincipal`), and the same identity mode, so it reads sequence 0 as written.
  const spyB = spyPolicy(unknownOwner);
  const b = new WorkflowRuntime({
    eventStore: raw,
    snapshotStore: rawSnaps,
    effectRuntime: new EffectRuntime([]),
    timerStore,
    executionAuthorizer: spyB.authorizer,
    executionAuthz: { requirePrincipal: true },
    principalIdentity: "encrypted",
    inboxEnabled: true,
  });
  b.registerFlow(parkDef, parkRunner);
  b.registerFlow(decideDef, decideRunner);

  return { a, b, raw, ownersB: spyB.owners, close: () => a.close() };
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

describe("S0 — a sealed principal read by a node WITHOUT the key (raw store, same strict authorizer)", () => {
  it("control: the sealed identity really is an envelope in the raw log (not a tenant string)", async () => {
    const c = await boot();
    try {
      await parked(c, "ctl");
      const first = (await c.raw.read("ctl"))[0];
      const text = JSON.stringify(first?.payload);
      expect(text).toContain("__loomEnc");
      expect(text).not.toContain("t1");
      expect(text).not.toContain("alice");
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

  it("ownerForAuthz does NOT hand the sealed envelope to the policy as the owner: it reports NO owner", async () => {
    const c = await boot();
    try {
      await parked(c, "own");
      await outcomeOf(run(c, "loadState", "own", T1));
      const seen = c.ownersB.filter((o) => o.executionId === "own" && o.op === "query");
      expect(seen.length).toBeGreaterThan(0);
      for (const o of seen) expect(o.owner).toBeUndefined();
    } finally {
      await c.close();
    }
  });

  // Observed today: every op, for the owner's own tenant AND a stranger, is DENIED with the typed
  // ExecutionDeniedError ("the execution's owner is unknown to this policy"): authorization fails
  // CLOSED on a sealed principal. Note it also denies the legitimate owner (T1): closed, not correct.
  for (const op of OPS) {
    for (const [n, who] of [
      ["T1 (the owner's tenant)", T1],
      ["T2 (a stranger)", T2],
    ] as const) {
      it(`${op} on a sealed principal by a raw node is DENIED (typed) for ${n}`, async () => {
        const c = await boot();
        try {
          const id = `m-${op}-${n.slice(0, 2)}`;
          await parked(c, id);
          const before = await c.raw.read(id);
          const r = await outcomeOf(run(c, op, id, who));
          expect(r.outcome).toBe("denied");
          expect((r.error as ExecutionDeniedError).reason).toMatch(/owner is unknown/);
          // Nothing but the kernel's own denial audit fact may be appended (resume / cancel record
          // one best-effort); no resume, cancel, inbox or discard fact lands.
          const added = (await c.raw.read(id)).slice(before.length).map((e) => e.eventType);
          for (const t of added) expect(t).toMatch(/DENIED/);
        } finally {
          await c.close();
        }
      });
    }
  }

  // OUTCOME_RECORDED.recordedBy variant: a late reward on a finished execution (op "annotate").
  for (const [n, who] of [
    ["T1 (the owner's tenant)", T1],
    ["T2 (a stranger)", T2],
  ] as const) {
    it(`recordOutcome on a sealed principal by a raw node is DENIED (typed) for ${n}`, async () => {
      const c = await boot();
      try {
        const id = `o-${n.slice(0, 2)}`;
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
        expect((await c.raw.read(id)).length).toBe(before);
      } finally {
        await c.close();
      }
    });
  }

  // The closed result rests on the policy's `unknownOwner: "deny"` default, NOT on the kernel
  // recognising the envelope. A policy that opts into `unknownOwner: "allow"` is fail-OPEN on a
  // sealed principal for a stranger. That is the operator's explicit choice, recorded here so S2
  // knows the kernel itself offers no second line of defence.
  it("with unknownOwner:'allow' a raw node ALLOWS T2 (a stranger) on loadState: closed only by the policy default", async () => {
    const c = await boot("allow");
    try {
      await parked(c, "open");
      expect((await outcomeOf(run(c, "loadState", "open", T2))).outcome).toBe("allowed");
    } finally {
      await c.close();
    }
  });
});
