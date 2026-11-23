import type { FlowDefinition } from "@loomwork/core";
import {
  type CapabilityAuthorizer,
  EffectRuntime,
  type PrincipalChain,
  ToolEffect,
} from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import {
  type ExecutionContext,
  type FlowRunner,
  type ResumeAuthenticator,
  WorkflowRuntime,
} from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TaskGrantAuthorizer } from "./authorizer";
import { taskAuthorityPrincipalCodec } from "./codec";
import {
  type GrantKeys,
  type TaskGrant,
  type UnsignedTaskGrant,
  keyRing,
  sealKeys,
  signTaskGrant,
  taskGrantDigest,
  verifyTaskGrant,
} from "./grant";
import { installTaskAuthority } from "./install";
import { taskLeaseMiddleware } from "./lease";
import { InMemoryGrantBroker, type RenewalPolicy } from "./renew";
import { RENEWAL_GATE, answerRenewal, renewalResumeSchema, withRenewal } from "./renewal";

const A = "key-A";
const B = "key-B";
const NOW = 1_000_000;
const RING: GrantKeys = { current: B, previous: [A] };
const unsigned = (): UnsignedTaskGrant => ({
  taskId: "t1",
  rootId: "t1",
  issuedTo: "agent-a",
  effects: ["act"],
  leases: { w: { ceiling: 2, effects: ["act"] } },
  exp: NOW + 60_000,
  epoch: 0,
});

describe("key ring (R31)", () => {
  it("signs with current, verifies any, a removed key fails closed", () => {
    const g = signTaskGrant(A, unsigned());
    expect(verifyTaskGrant(RING, g)).toEqual(g);
    expect(verifyTaskGrant({ current: B }, g)).toBeUndefined();
    const g2 = signTaskGrant(RING, unsigned());
    expect(verifyTaskGrant(B, g2)).toBeDefined();
    expect(verifyTaskGrant(A, g2)).toBeUndefined();
    expect(g2.sig).not.toBe(g.sig);
    // a plain string is { current }
    expect(keyRing(A)).toEqual({ sign: A, verify: [A] });
  });

  it("the digest does not depend on the verifying key", () => {
    const g = signTaskGrant(A, unsigned());
    const viaA = verifyTaskGrant(A, g) as TaskGrant;
    const viaRing = verifyTaskGrant({ current: B, previous: [A] }, g) as TaskGrant;
    expect(taskGrantDigest(viaRing)).toBe(taskGrantDigest(viaA));
  });

  it("refuses a bad ring at construction", () => {
    const bad: GrantKeys[] = [
      { current: "" },
      { current: B, previous: Array.from({ length: 9 }, (_, i) => `k${i}`) },
      { current: B, previous: [B] },
      { current: B, previous: [""] },
    ];
    for (const k of bad) {
      expect(() => keyRing(k)).toThrow();
      expect(() => signTaskGrant(k, unsigned())).toThrow();
      expect(verifyTaskGrant(k, signTaskGrant(B, unsigned()))).toBeUndefined();
      expect(() => new InMemoryGrantBroker({ secret: k })).toThrow();
      expect(
        () => new TaskGrantAuthorizer({ secret: k, base: { authorize: () => ({ allowed: true }) } })
      ).toThrow();
      expect(() =>
        taskLeaseMiddleware({ secret: k, source: { current: async () => undefined } as never })
      ).toThrow();
    }
    expect(() =>
      keyRing({ current: B, previous: Array.from({ length: 8 }, (_, i) => `k${i}`) })
    ).not.toThrow();
  });

  it("a ring is copied at construction: later mutation of the caller's object changes nothing", () => {
    const ring = { current: B, previous: [A] };
    const sealed = sealKeys(ring);
    ring.previous.length = 0;
    ring.current = "other";
    expect(verifyTaskGrant(sealed, signTaskGrant(A, unsigned()))).toBeDefined();
  });

  it("authorizer: an A-signed grant is allowed by {B,[A]}, denied by {B} with task-grant:signature", () => {
    const base: CapabilityAuthorizer = { authorize: () => ({ allowed: true }) };
    const g = signTaskGrant(A, unsigned());
    const req = {
      toolId: "act",
      executionId: "e",
      workflowId: "wf",
      stepId: "s",
      principal: { actor: "agent-a", taskGrant: g },
    } as never;
    const ok = new TaskGrantAuthorizer({ secret: RING, base, now: () => NOW }).authorize(req);
    expect(ok).toEqual({ allowed: true });
    const d = new TaskGrantAuthorizer({ secret: { current: B }, base, now: () => NOW }).authorize(
      req
    );
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toMatch(/^task-grant:signature/);
  });
});

describe("codec across rotation", () => {
  const mk = (b: InMemoryGrantBroker, secret: GrantKeys) =>
    taskAuthorityPrincipalCodec(b, { secret, now: () => NOW });
  const ctx = { executionId: "e1" };
  const brokerA = () =>
    new InMemoryGrantBroker({ secret: A, now: () => NOW, policy: () => ({ leases: { w: 9 } }) });
  const mint = (b: InMemoryGrantBroker) =>
    b.mint({
      taskId: "t1",
      issuedTo: "agent-a",
      effects: ["act"],
      leases: { w: { ceiling: 2, effects: ["act"] } },
      ttlMs: 60_000,
    });
  const chainOf = (g: TaskGrant): PrincipalChain => ({ actor: g.issuedTo, taskGrant: g });

  it("a ref MAC'd with a previous key restores under {B,[A]}; new refs use the current key", async () => {
    const b = brokerA();
    const g = await mint(b);
    const refA = mk(b, A).toRef(chainOf(g)) as string;
    const restored = await mk(b, RING).fromRef(refA, ctx);
    expect(restored?.taskGrant).toBeDefined();
    // the grant is still A-signed in the ledger and the ring verifies it
    const refB = mk(b, RING).toRef(chainOf(g)) as string;
    expect(refB).not.toBe(refA);
    expect(refB.split(".").at(-1)).not.toBe(refA.split(".").at(-1));
    // a B-only codec restores the new ref but never the A-ref
    expect(
      (await mk(b, { current: B, previous: [A] }).fromRef(refB, { executionId: "e1" }))?.taskGrant
    ).toBeDefined();
  });

  it("mixed rings: the grant verifies under {B,[A]} but a codec holding only B refuses an A-ref (fail closed)", async () => {
    // ledger grant re-signed with B (as a renewal would), ref still A-MAC'd
    const b = new InMemoryGrantBroker({ secret: RING, now: () => NOW });
    const g = await mint(b); // B-signed
    const other = brokerA(); // same taskId + holder, A-signed: its ref MAC is what an old run recorded
    const refA = mk(other, A).toRef(chainOf(await mint(other))) as string;
    const r = await mk(b, B).fromRef(refA, ctx);
    expect(r?.taskGrant).toBeUndefined();
    expect(r?.principalUnresolved).toMatch(/does not match the grant's holder/);
    expect((await mk(b, RING).fromRef(refA, ctx))?.taskGrant).toBeDefined();
  });
});

// ── real runtime: start under A, rotate, renew, rotate again ──────────────────

class RotBroker extends InMemoryGrantBroker {
  rotate(keys: GrantKeys) {
    (this as unknown as { secret: GrantKeys }).secret = sealKeys(keys);
  }
}
const verified: ResumeAuthenticator = {
  verify: () => ({ status: "verified", actor: "ops", verifiedBy: "test" }),
};
const task = (id: string) => ({ _tag: "TaskDefinition", kind: "tool", id, toolId: "act" }) as never;
const grow: RenewalPolicy = (_r, h) => ({ leases: { w: 2 + 2 * (h.renewals + 1) } });
const runner: FlowRunner<unknown, unknown> = async (ctx: ExecutionContext) => {
  const out: string[] = [];
  for (let i = 0; i < 5; i++)
    out.push(
      await withRenewal(
        ctx as never,
        `c${i}`,
        async (a) => await ctx.run(task(a), {}).then(() => a)
      )
    );
  return out;
};
const stores = () => ({
  eventStore: new InMemoryAsyncEventStore(),
  snapshotStore: new InMemoryAsyncSnapshotStore(),
});

function boot(b: RotBroker, keys: GrantKeys, shared: ReturnType<typeof stores>) {
  const ran = { n: 0 };
  const effects = new EffectRuntime(
    [taskLeaseMiddleware({ secret: keys, source: b, now: () => NOW })],
    {
      authorizer: new TaskGrantAuthorizer({
        secret: keys,
        base: { authorize: () => ({ allowed: true }) },
        now: () => NOW,
      }),
    }
  );
  effects.register(
    "act",
    new ToolEffect(async () => {
      ran.n++;
      return { ok: true };
    })
  );
  const runtime = new WorkflowRuntime({
    ...shared,
    effectRuntime: effects,
    resumeAuthenticator: verified,
    onWarn: () => {},
  });
  const definition = {
    _tag: "FlowDefinition",
    id: "rot-flow",
    name: "rot-flow",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    steps: [],
    resumeSchemas: { [RENEWAL_GATE]: renewalResumeSchema },
  } as unknown as FlowDefinition;
  runtime.registerFlow(definition, runner);
  installTaskAuthority(runtime, { source: b, secret: keys, now: () => NOW });
  return { runtime, ran, flow: { definition, runner } as never };
}
const gateKey = async (rt: WorkflowRuntime, id: string) =>
  (await rt.loadState(id))?.suspendedOn?.correlationKey;

async function parkedAtC4() {
  const b = new RotBroker({ secret: A, now: () => NOW, policy: grow });
  const g = await b.mint({
    taskId: "t1",
    issuedTo: "agent-a",
    effects: ["act"],
    leases: { w: { ceiling: 2, effects: ["act"] } },
    ttlMs: 60_000,
  });
  const shared = stores();
  const h1 = boot(b, A, shared);
  const run = await h1.runtime.start(
    h1.flow,
    {},
    { executionId: "e1", principal: { actor: g.issuedTo, taskGrant: g } }
  );
  await run.waitForSuspend();
  expect(await gateKey(h1.runtime, "e1")).toBe("e1#c2#0");
  expect(h1.ran.n).toBe(2);
  expect(verifyTaskGrant({ current: B }, (await b.current("t1")) as TaskGrant)).toBeUndefined();
  // rotate every component; a FRESH runtime restores the A-MAC'd ref and renews
  b.rotate(RING);
  const h2 = boot(b, RING, shared);
  const r2 = await answerRenewal(h2.runtime, b, "e1");
  await r2.waitForSuspend(); // c4 exhausts the renewed ceiling
  expect(await gateKey(h2.runtime, "e1")).toBe("e1#c4#0");
  expect(h2.ran.n).toBe(2); // c2, c3 ran after the restore + renewal
  const renewed = (await b.current("t1")) as TaskGrant;
  expect(renewed.epoch).toBe(1);
  expect(verifyTaskGrant({ current: B }, renewed)).toBeDefined(); // re-signed with the CURRENT key
  return { b, shared };
}

describe("rotation with a real runtime", () => {
  it("a run started under A survives rotation to {B,[A]}, renews onto B, and completes while A stays in previous", async () => {
    const { b, shared } = await parkedAtC4();
    const h = boot(b, RING, shared);
    const done = await answerRenewal(h.runtime, b, "e1");
    expect((await done.waitForCompletion()).variables._output).toEqual([
      "c0",
      "c1",
      "c2:r1",
      "c3",
      "c4:r1",
    ]);
  });

  it("removing A strands a run started under it for its WHOLE life, even though its grant is now B-signed: the recorded ref is never rewritten", async () => {
    const { b, shared } = await parkedAtC4();
    b.rotate({ current: B });
    const h = boot(b, { current: B }, shared);
    const r = await answerRenewal(h.runtime, b, "e1");
    await expect(r.waitForCompletion()).rejects.toThrow(
      /recorded principal could not be restored: task grant t1: ref does not match the grant's holder/
    );
    expect(h.ran.n).toBe(0); // fail closed: no effect ran
    expect((await h.runtime.loadState("e1"))?.status).toBe("failed");
  });
});
