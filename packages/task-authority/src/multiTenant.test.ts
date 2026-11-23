import { policy$ } from "@loomwork/core";
import type { FlowDefinition } from "@loomwork/core";
import {
  EffectRuntime,
  PolicyAuthorizer,
  type PrincipalChain,
  ToolEffect,
} from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import {
  type FlowRunner,
  type PrincipalIdentityMode,
  type RegisteredFlow,
  WorkflowRuntime,
} from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TaskGrantAuthorizer } from "./authorizer";
import { GrantBrokerError, type MintRequest } from "./broker";
import { taskAuthorityPrincipalCodec } from "./codec";
import { TaskAuthorityPrincipalError } from "./errors";
import { type TaskGrant, signTaskGrant, verifyTaskGrant } from "./grant";
import { installTaskAuthority } from "./install";
import { InMemoryGrantBroker } from "./renew";

const SECRET = "mt-secret";
const NOW = 1_000_000;
const broker = () =>
  new InMemoryGrantBroker({
    secret: SECRET,
    now: () => NOW,
    policy: () => ({ leases: { w: 20 } }),
  });
const req = (over: Partial<MintRequest> = {}): MintRequest => ({
  taskId: "t1",
  issuedTo: "agent-a",
  effects: ["act"],
  leases: { w: { ceiling: 10, effects: ["act"] } },
  ttlMs: 60_000,
  ...over,
});
const chainOf = (g: TaskGrant, over: Partial<PrincipalChain> = {}): PrincipalChain => ({
  actor: g.issuedTo,
  taskGrant: g,
  ...over,
});
const codec = (b: InMemoryGrantBroker) =>
  taskAuthorityPrincipalCodec(b, { secret: SECRET, now: () => NOW });

// ── real runtime ──────────────────────────────────────────────────────────────
const runner: FlowRunner<unknown, { ok: boolean }> = async (ctx) => {
  const t = { _tag: "TaskDefinition", kind: "tool", id: "s", toolId: "act" } as never;
  await ctx.execute(t, {});
  await ctx.suspend({ on: "GO" });
  await ctx.execute({ _tag: "TaskDefinition", kind: "tool", id: "s2", toolId: "act" } as never, {});
  return { ok: true };
};
const definition: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "mt-flow",
  name: "mt-flow",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  steps: [],
};
const flow = { definition, runner } as unknown as RegisteredFlow;
interface Stores {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
  timerStore: InMemoryTimerStore;
}
function boot(b: InMemoryGrantBroker, shared?: Stores, identity?: PrincipalIdentityMode) {
  const seen: (PrincipalChain | undefined)[] = [];
  const policy = policy$({
    id: "p",
    name: "P",
    rules: { match: [{ effect: "act", tenant: "acme" }] },
  });
  const effects = new EffectRuntime([], {
    authorizer: new TaskGrantAuthorizer({
      secret: SECRET,
      base: new PolicyAuthorizer({ "mt-flow": [policy] }),
      now: () => NOW,
    }),
  });
  effects.register(
    "act",
    new ToolEffect(async (_a, ctx) => {
      seen.push((ctx as { principal?: PrincipalChain }).principal);
      return { ok: true };
    })
  );
  const stores = shared ?? {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    timerStore: new InMemoryTimerStore(),
  };
  const runtime = new WorkflowRuntime({
    ...stores,
    effectRuntime: effects,
    ...(identity && { principalIdentity: identity }),
  });
  runtime.registerFlow(definition, runner as FlowRunner<unknown, unknown>);
  installTaskAuthority(runtime, { source: b, secret: SECRET, now: () => NOW });
  return { runtime, seen, ...stores };
}
const GO = { eventType: "GO", payload: {} };

describe("multi-tenant task grants (R30), real runtime", () => {
  for (const identity of [undefined, "ref"] as const) {
    it(`records only a ref (identity mode ${identity ?? "default"}); a fresh runtime restores the tenant and the tenant policy allows`, async () => {
      const b = broker();
      const g = await b.mint(req({ tenant: "acme", onBehalfOf: "user-7" }));
      const h = boot(b, undefined, identity);
      const run = await h.runtime.start(
        flow,
        {},
        { executionId: "e1", principal: chainOf(g, { tenant: "acme", onBehalfOf: "user-7" }) }
      );
      await run.waitForSuspend();
      const events = await h.eventStore.read("e1");
      expect((events[0]!.payload as { principal: unknown }).principal).toEqual({
        v: 1,
        ref: expect.stringMatching(/^ta2:t1\./),
      });
      const dump = async () =>
        JSON.stringify([
          await h.eventStore.read("e1"),
          await Promise.all(
            (await h.snapshotStore.listSequences("e1")).map((q) => h.snapshotStore.loadAt("e1", q))
          ),
        ]);
      const text = await dump();
      expect(text.length).toBeGreaterThan(100);
      expect(text).not.toContain("acme");
      expect(text).not.toContain("user-7");
      const h2 = boot(b, h, identity);
      const resumed = await h2.runtime.resume("e1", GO, {
        principal: chainOf(g, { tenant: "acme", onBehalfOf: "user-7" }),
      });
      await resumed.waitForCompletion();
      expect(h2.seen.length).toBeGreaterThan(0);
      expect(h2.seen.at(-1)).toMatchObject({
        actor: "agent-a",
        tenant: "acme",
        onBehalfOf: "user-7",
      });
      expect(await dump()).not.toContain("acme");
    });
  }

  it("the tenant policy DENIES a task of another tenant (the authorizer sees the tenant)", async () => {
    const b = broker();
    const g = await b.mint(req({ tenant: "globex" }));
    const h = boot(b);
    const run = await h.runtime.start(
      flow,
      {},
      { executionId: "e2", principal: chainOf(g, { tenant: "globex" }) }
    );
    await expect(run.waitForSuspend()).rejects.toThrow();
    expect(h.seen).toHaveLength(0);
  });

  const refused = async (grantOver: Partial<MintRequest>, chain: Partial<PrincipalChain>) => {
    const b = broker();
    const g = await b.mint(req(grantOver));
    const h = boot(b);
    await expect(
      h.runtime.start(flow, {}, { executionId: "r1", principal: chainOf(g, chain) })
    ).rejects.toThrow(TaskAuthorityPrincipalError);
    expect(await h.eventStore.read("r1")).toHaveLength(0);
  };
  it("a mismatched tenant refuses the start", () =>
    refused({ tenant: "acme" }, { tenant: "globex" }));
  it("a mismatched onBehalfOf refuses the start", () =>
    refused({ tenant: "acme", onBehalfOf: "u1" }, { tenant: "acme", onBehalfOf: "u2" }));
  it("a grant with a tenant on a chain without one is refused", () =>
    refused({ tenant: "acme" }, {}));
  it("a chain with a tenant on a grant without one is refused", () =>
    refused({}, { tenant: "acme" }));
});

describe("multi-tenant codec and grant (R30)", () => {
  it("a delegation alongside a tenant grant stays refused", async () => {
    const b = broker();
    const g = await b.mint(req({ tenant: "acme" }));
    expect(() => codec(b).toRef(chainOf(g, { tenant: "acme", delegation: {} as never }))).toThrow(
      TaskAuthorityPrincipalError
    );
  });
  it("a grant without identity encodes byte-identically to before (pre-change fixture)", () => {
    // The signature was computed by the PRE-change grant.ts (T12 base 0d7202c6) for this exact grant.
    const fixture = {
      taskId: "fx",
      rootId: "fx",
      issuedTo: "agent-a",
      effects: ["act"],
      leases: { w: { ceiling: 3, effects: ["act"] } },
      exp: 5000,
      epoch: 1,
    };
    const signed = {
      ...fixture,
      sig: "213f32a4de3f73cf3387d3e910740939e6fb192bd60408ca5b44ee25fe4badc3",
    };
    expect(signTaskGrant("fixture-secret", fixture).sig).toBe(signed.sig);
    expect(verifyTaskGrant("fixture-secret", signed as TaskGrant)).toBeDefined();
  });
  it("tenant/onBehalfOf are signed: tampering breaks the signature; shape bounds hold", async () => {
    const g = await broker().mint(req({ tenant: "acme" }));
    expect(verifyTaskGrant(SECRET, { ...g, tenant: "globex" })).toBeUndefined();
    expect(verifyTaskGrant(SECRET, { ...g, onBehalfOf: "x" })).toBeUndefined();
    const { sig: _s, ...u } = g;
    for (const bad of ["", "x".repeat(257), "a\nb"])
      expect(() => signTaskGrant(SECRET, { ...u, tenant: bad })).toThrow();
  });
  it("the ref MAC binds the tenant: a ta2 ref cannot restore a grant of another tenant, a ta1 ref never restores a tenant grant", async () => {
    const b = broker();
    const g = await b.mint(req({ tenant: "acme" }));
    const c = codec(b);
    const ref = c.toRef(chainOf(g, { tenant: "acme" })) as string;
    expect(await c.fromRef(ref, { executionId: "x" })).toMatchObject({
      tenant: "acme",
      actor: "agent-a",
    });
    const mac = ref.slice(ref.lastIndexOf(".") + 1);
    const b2 = broker();
    await b2.mint(req({ tenant: "globex" }));
    const moved = await codec(b2).fromRef(ref, { executionId: "y" });
    expect(moved?.principalUnresolved).toMatch(/holder|tenant/);
    const asV1 = await codec(b).fromRef(`ta1:t1.${mac}`, { executionId: "z" });
    expect(asV1?.principalUnresolved).toBeDefined();
  });
  it("a ta1 ref recorded by earlier code still restores", async () => {
    const b = broker();
    const g = await b.mint(req());
    const c = codec(b);
    const ref = c.toRef(chainOf(g)) as string;
    expect(ref.startsWith("ta1:")).toBe(true);
    const restored = await c.fromRef(ref, { executionId: "x" });
    expect(restored).toMatchObject({ actor: "agent-a" });
    expect(restored?.tenant).toBeUndefined();
  });
});

describe("multi-tenant broker (R30)", () => {
  it("a child inherits tenant and onBehalfOf; a different or newly named one is refused", async () => {
    const b = broker();
    await b.mint(req({ tenant: "acme", onBehalfOf: "u1" }));
    const child = (over: Partial<MintRequest>) =>
      b.mint(
        req({
          taskId: `c${Math.random()}`,
          parent: { taskId: "t1" },
          leases: { w: { ceiling: 1, effects: ["act"] } },
          ...over,
        })
      );
    const ok = await child({});
    expect(ok).toMatchObject({ tenant: "acme", onBehalfOf: "u1" });
    expect(await child({ tenant: "acme" })).toMatchObject({ tenant: "acme" });
    await expect(child({ tenant: "globex" })).rejects.toThrow(GrantBrokerError);
    await expect(child({ onBehalfOf: "u2" })).rejects.toThrow(GrantBrokerError);
    const p2 = broker();
    await p2.mint(req());
    await expect(
      p2.mint(req({ taskId: "c", parent: { taskId: "t1" }, tenant: "acme" }))
    ).rejects.toThrow(GrantBrokerError);
  });
  it("renewal keeps tenant and onBehalfOf", async () => {
    const b = broker();
    await b.mint(req({ tenant: "acme", onBehalfOf: "u1" }));
    expect(await b.renew({ taskId: "t1", epoch: 0, spent: {}, renewals: 0 })).toMatchObject({
      granted: true,
    });
    expect(await b.current("t1")).toMatchObject({ epoch: 1, tenant: "acme", onBehalfOf: "u1" });
  });
  it("an inherited tenant reaches the child's restored principal", async () => {
    const b = broker();
    await b.mint(req({ tenant: "acme" }));
    const c = await b.mint(req({ taskId: "kid", issuedTo: "agent-k", parent: { taskId: "t1" } }));
    const cd = codec(b);
    const ref = cd.toRef(chainOf(c, { tenant: "acme" })) as string;
    expect(await cd.fromRef(ref, { executionId: "k" })).toMatchObject({
      actor: "agent-k",
      tenant: "acme",
    });
  });
});

describe("multi-tenant ref guards and erasure (R30 review)", () => {
  it("M1: a ta1 ref recorded against an identity-free grant never restores a reissue that carries a tenant", async () => {
    const a = broker();
    const ref = codec(a).toRef(chainOf(await a.mint(req()))) as string;
    expect(ref.startsWith("ta1:")).toBe(true);
    const b = broker();
    await b.mint(req({ tenant: "acme" }));
    const r = await codec(b).fromRef(ref, { executionId: "x" });
    expect(r?.principalUnresolved).toMatch(/does not bind/);
  });
  it("M2: the ta2 MAC binds onBehalfOf", async () => {
    const a = broker();
    const ref = codec(a).toRef(
      chainOf(await a.mint(req({ tenant: "acme", onBehalfOf: "u1" })), {
        tenant: "acme",
        onBehalfOf: "u1",
      })
    ) as string;
    const b = broker();
    await b.mint(req({ tenant: "acme", onBehalfOf: "u2" }));
    const r = await codec(b).fromRef(ref, { executionId: "x" });
    expect(r?.principalUnresolved).toMatch(/does not match/);
  });
  it("M5: a ta2 ref never restores an identity-free grant", async () => {
    const a = broker();
    const ref = codec(a).toRef(
      chainOf(await a.mint(req({ tenant: "acme" })), { tenant: "acme" })
    ) as string;
    const b = broker();
    await b.mint(req());
    const r = await codec(b).fromRef(ref, { executionId: "x" });
    expect(r?.principalUnresolved).toMatch(/does not carry/);
  });
  it("M4: erasing onBehalfOf at the broker makes the task permanently unrestorable", async () => {
    const a = broker();
    const g = await a.mint(req({ tenant: "acme", onBehalfOf: "u1" }));
    const ref = codec(a).toRef(chainOf(g, { tenant: "acme", onBehalfOf: "u1" })) as string;
    const { sig: _s, onBehalfOf: _o, ...stripped } = g;
    const erased = signTaskGrant(SECRET, stripped);
    const src = { ...a, current: async () => erased } as unknown as InMemoryGrantBroker;
    Object.setPrototypeOf(src, Object.getPrototypeOf(a));
    const r = await codec(src).fromRef(ref, { executionId: "x" });
    expect(r?.principalUnresolved).toMatch(/does not match/);
    expect(r?.taskGrant).toBeUndefined();
  });
});
