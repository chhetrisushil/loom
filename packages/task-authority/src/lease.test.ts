import type { EventEnvelope, FlowDefinition } from "@loomwork/core";
import {
  type EffectContext,
  EffectRuntime,
  type PrincipalChain,
  ToolEffect,
} from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import {
  EFFECT_INDOUBT_RESOLVED,
  type ExecutionContext,
  type FlowRunner,
  WorkflowRuntime,
  recoverAbandoned,
} from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { GrantSource } from "./broker";
import {
  GrantRevokedError,
  LeaseDurabilityError,
  LeaseExhaustedError,
  LeaseUnmappedError,
} from "./errors";
import { type TaskGrant, signTaskGrant } from "./grant";
import { installTaskAuthority } from "./install";
import { taskLeaseMiddleware } from "./lease";
import { InMemoryGrantBroker } from "./renew";

const SECRET = "lease-secret";
const NOW = 1_000_000;
const mkBroker = () => new InMemoryGrantBroker({ secret: SECRET, now: () => NOW });
const mint = (b: InMemoryGrantBroker, ceiling: number, taskId = "t1") =>
  b.mint({
    taskId,
    issuedTo: "agent-a",
    effects: ["act", "other"],
    leases: { w: { ceiling, effects: ["act"] } },
    ttlMs: 60_000,
  });
const chainOf = (g: TaskGrant): PrincipalChain => ({ actor: g.issuedTo, taskGrant: g });
const task = (id: string, toolId = "act") =>
  ({ _tag: "TaskDefinition", kind: "tool", id, toolId }) as never;

const until = async (cond: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};

interface Stores {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
}
const freshStores = (): Stores => ({
  eventStore: new InMemoryAsyncEventStore(),
  snapshotStore: new InMemoryAsyncSnapshotStore(),
});
const types = async (s: Stores, id: string): Promise<string[]> =>
  (await s.eventStore.read(id)).map((e: EventEnvelope) => e.eventType);

interface BootOpts {
  broker: InMemoryGrantBroker;
  runner: FlowRunner<unknown, unknown>;
  stores?: Stores;
  eventStore?: InMemoryAsyncEventStore;
  strict?: boolean;
  idempotent?: boolean;
  body?: () => Promise<void>;
  throws?: boolean;
}
function boot(o: BootOpts) {
  const ran = { n: 0 };
  const effects = new EffectRuntime([
    taskLeaseMiddleware({
      secret: SECRET,
      source: o.broker,
      ...(o.strict !== undefined && { strictLeases: o.strict }),
    }),
  ]);
  const act = new ToolEffect(
    async () => {
      ran.n++;
      await o.body?.();
      if (o.throws === true) throw new Error("boom");
      return { ok: true };
    },
    o.idempotent === undefined ? {} : { idempotent: o.idempotent }
  );
  effects.register("act", act);
  effects.register("other", new ToolEffect(async () => ({ ok: true })));
  const stores = o.stores ?? freshStores();
  const runtime = new WorkflowRuntime({
    ...stores,
    ...(o.eventStore !== undefined && { eventStore: o.eventStore }),
    effectRuntime: effects,
    onWarn: () => {},
  });
  const definition: FlowDefinition = {
    _tag: "FlowDefinition",
    id: "lease-flow",
    name: "lease-flow",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    steps: [],
  } as unknown as FlowDefinition;
  runtime.registerFlow(definition, o.runner);
  installTaskAuthority(runtime, { source: o.broker, secret: SECRET, now: () => NOW });
  const flow = { definition, runner: o.runner } as never;
  const start = (id: string, g: TaskGrant) =>
    runtime.start(flow, {}, { executionId: id, principal: chainOf(g) });
  return { runtime, ran, stores, start, effects, flow };
}

const seq = (n: number, out: { err?: unknown }): FlowRunner<unknown, unknown> => {
  return async (ctx: ExecutionContext) => {
    for (let i = 0; i < n; i++) {
      try {
        await ctx.run(task(`s${i}`), {});
      } catch (e) {
        out.err = e;
        return { stoppedAt: i };
      }
    }
    return { stoppedAt: n };
  };
};

describe("lease ceiling", () => {
  it("N calls run, call N+1 throws a renewable LeaseExhaustedError and is logged", async () => {
    const broker = mkBroker();
    const g = await mint(broker, 3);
    const out: { err?: unknown } = {};
    const h = boot({ broker, runner: seq(5, out) });
    const run = await h.start("e1", g);
    await run.waitForCompletion();
    expect(h.ran.n).toBe(3);
    expect(out.err).toBeInstanceOf(LeaseExhaustedError);
    expect(out.err).toMatchObject({ renewable: true, lease: "w", ceiling: 3, spent: 3, epoch: 0 });
    const t = await types(h.stores, "e1");
    expect(t.filter((x) => x === "RESOURCE_METERED")).toHaveLength(3);
    expect(t.filter((x) => x === "QUOTA_EXCEEDED")).toHaveLength(1);
  });

  it("concurrent effects never exceed the ceiling (K > ceiling, gated together)", async () => {
    const broker = mkBroker();
    const g = await mint(broker, 3);
    const K = 8;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const settled: unknown[] = [];
    const runner: FlowRunner<unknown, unknown> = async (ctx: ExecutionContext) => {
      const rs = await Promise.allSettled(
        Array.from({ length: K }, (_, i) => ctx.run(task(`c${i}`), {}))
      );
      settled.push(...rs);
      return {};
    };
    const h = boot({ broker, runner, body: () => gate });
    const run = await h.start("e2", g);
    await until(
      async () =>
        (await types(h.stores, "e2")).filter((x) => x === "QUOTA_EXCEEDED").length === K - 3,
      "the refusals"
    );
    await until(() => h.ran.n === 3, "the admitted effects to start");
    release();
    await run.waitForCompletion();
    expect(h.ran.n).toBe(3);
    expect(
      settled.filter((s) => (s as PromiseSettledResult<unknown>).status === "rejected")
    ).toHaveLength(K - 3);
  });

  it("spend survives a crash and restart: a fresh runtime counts from the fold", async () => {
    const broker = mkBroker();
    const g = await mint(broker, 3);
    const out: { err?: unknown } = {};
    const runner: FlowRunner<unknown, unknown> = async (ctx: ExecutionContext, input) => {
      await ctx.run(task("a0"), {});
      await ctx.run(task("a1"), {});
      await ctx.suspend({ on: "GO" });
      return seq(3, out)(ctx, input);
    };
    const h1 = boot({ broker, runner });
    const r1 = await h1.start("e3", g);
    await r1.waitForSuspend();
    const h2 = boot({ broker, runner, stores: h1.stores });
    const r2 = await h2.runtime.resume(
      "e3",
      { eventType: "GO", payload: {} },
      { principal: chainOf(g) }
    );
    await r2.waitForCompletion();
    expect(h1.ran.n + h2.ran.n).toBe(3); // 2 before, 1 after: the fourth overall is refused
    expect(out.err).toBeInstanceOf(LeaseExhaustedError);
  });

  it("an effect that throws is still counted", async () => {
    const broker = mkBroker();
    const g = await mint(broker, 2);
    const out: { err?: unknown } = {};
    const h = boot({ broker, runner: seq(4, out), throws: true });
    const run = await h.start("e8", g);
    await run.waitForCompletion().catch(() => {});
    const t = await types(h.stores, "e8");
    expect(t.indexOf("RESOURCE_METERED")).toBeGreaterThan(-1);
    expect(t.indexOf("RESOURCE_METERED")).toBeLessThan(t.indexOf("STEP_FAILED"));
    expect(h.ran.n).toBe(1);
  });
});

describe("digest decision and grant-less calls", () => {
  it("one digest decision per step per epoch, none without a grant", async () => {
    const broker = mkBroker();
    const g = await mint(broker, 5);
    const h = boot({ broker, runner: seq(2, {}) });
    const run = await h.start("e4", g);
    await run.waitForCompletion();
    const evs = await h.stores.eventStore.read("e4");
    const decisions = evs.filter((e) => e.eventType === "DECISION_RECORDED");
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.payload).toMatchObject({
      choice: { epoch: 0, exp: g.exp, digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });

    const plain = boot({ broker, runner: seq(2, {}) });
    const bare = await plain.runtime.start(plain.flow, {}, { executionId: "e4b" });
    await bare.waitForCompletion();
    expect(plain.ran.n).toBe(2);
    const bareTypes = await types(plain.stores, "e4b");
    expect(bareTypes).not.toContain("RESOURCE_METERED");
    expect(bareTypes).not.toContain("DECISION_RECORDED");
  });

  it("a second effect in the same step and attempt does not re-emit the decision", async () => {
    const g = signTaskGrant(
      SECRET,
      grantBody({ leases: { w: { ceiling: 10, effects: ["act"] } } })
    );
    const mw = taskLeaseMiddleware({ secret: SECRET });
    const { ctx, emitted } = fakeCtx(g);
    await mw(ctx, {}, async () => 1);
    await mw(ctx, {}, async () => 1);
    expect(emitted.filter((e) => e === "DECISION_RECORDED")).toHaveLength(1);
    expect(emitted.filter((e) => e === "RESOURCE_METERED")).toHaveLength(2);
    const next = fakeCtx(g, { attempt: 2 });
    await mw(next.ctx, {}, async () => 1);
    expect(next.emitted).toContain("DECISION_RECORDED");
  });

  it("no grant: next runs untouched and nothing is emitted", async () => {
    const mw = taskLeaseMiddleware({ secret: SECRET });
    const { ctx, emitted } = fakeCtx(undefined);
    expect(await mw(ctx, {}, async () => "ran")).toBe("ran");
    expect(emitted).toEqual([]);
  });
});

function grantBody(over: Partial<TaskGrant> = {}) {
  return {
    taskId: "tg",
    rootId: "tg",
    issuedTo: "agent-a",
    effects: ["act"],
    leases: { w: { ceiling: 2, effects: ["act"] } },
    exp: NOW + 60_000,
    epoch: 0,
    ...over,
  };
}
function fakeCtx(
  g: TaskGrant | undefined,
  over: { attempt?: number; flush?: boolean; toolId?: string; exec?: string } = {}
) {
  const emitted: string[] = [];
  const ctx = {
    executionId: over.exec ?? "fx",
    stepId: "s",
    workflowId: "w",
    attempt: over.attempt ?? 1,
    toolId: over.toolId ?? "act",
    emit: (t: string) => {
      emitted.push(t);
    },
    ...(over.flush !== false && { flush: async () => {} }),
    ...(g !== undefined && { principal: { actor: "agent-a", taskGrant: g } }),
  } as unknown as EffectContext;
  return { ctx, emitted };
}

describe("mapping", () => {
  it("strictLeases refuses an unmapped effect; non-strict lets it through uncounted", async () => {
    const broker = mkBroker();
    const g = await mint(broker, 3);
    const strict = taskLeaseMiddleware({ secret: SECRET, strictLeases: true });
    const loose = taskLeaseMiddleware({ secret: SECRET });
    const a = fakeCtx(g, { toolId: "other" });
    await expect(strict(a.ctx, {}, async () => 1)).rejects.toBeInstanceOf(LeaseUnmappedError);
    expect(a.emitted).toEqual([]);
    const b = fakeCtx(g, { toolId: "other", flush: false });
    expect(await loose(b.ctx, {}, async () => 7)).toBe(7);
    expect(b.emitted).toEqual([]);
  });

  it("a forged grant makes the middleware throw", async () => {
    const g = signTaskGrant("other-secret", grantBody());
    const { ctx, emitted } = fakeCtx(g);
    await expect(taskLeaseMiddleware({ secret: SECRET })(ctx, {}, async () => 1)).rejects.toThrow(
      /failed verification/
    );
    expect(emitted).toEqual([]);
  });
});

describe("revocation", () => {
  const g = signTaskGrant(SECRET, grantBody());
  const src = (revoked: (d: string) => Promise<boolean>): GrantSource => ({
    current: async () => g,
    claim: async () => true,
    revoked,
  });
  it("a revoked digest throws a renewable GrantRevokedError and counts nothing", async () => {
    const mw = taskLeaseMiddleware({ secret: SECRET, source: src(async () => true) });
    const { ctx, emitted } = fakeCtx(g);
    const err = await mw(ctx, {}, async () => 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrantRevokedError);
    expect((err as GrantRevokedError).renewable).toBe(true);
    expect(emitted).toEqual([]);
  });

  it("a hanging revoked() fails closed within the timeout and is not cached", async () => {
    let calls = 0;
    const mw = taskLeaseMiddleware({
      secret: SECRET,
      revocationTimeoutMs: 20,
      source: src(() => {
        calls++;
        return new Promise<boolean>(() => {});
      }),
    });
    for (let i = 0; i < 2; i++) {
      await expect(mw(fakeCtx(g).ctx, {}, async () => 1)).rejects.toBeInstanceOf(GrantRevokedError);
    }
    expect(calls).toBe(2);
  });

  it("a false answer is cached per digest", async () => {
    let calls = 0;
    const mw = taskLeaseMiddleware({
      secret: SECRET,
      source: src(async () => {
        calls++;
        return false;
      }),
    });
    await mw(fakeCtx(g).ctx, {}, async () => 1);
    await mw(fakeCtx(g, { exec: "other" }).ctx, {}, async () => 1);
    expect(calls).toBe(1);
  });
});

/** Parks the RESOURCE_METERED append (hold) or lets it pass. */
function heldMeterStore(inner: InMemoryAsyncEventStore, order: string[]) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "append") {
        return async (envelope: EventEnvelope, ...rest: unknown[]) => {
          order.push(`append:${envelope.eventType}`);
          if (envelope.eventType === "RESOURCE_METERED") await gate;
          return (target.append as (...a: unknown[]) => Promise<void>)(envelope, ...rest);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { store, release };
}

describe("durability of the count (ADR 0151)", () => {
  it("the effect has not started while the meter append is held; the meter precedes the effect", async () => {
    const broker = mkBroker();
    const g = await mint(broker, 3);
    const durable = new InMemoryAsyncEventStore();
    const order: string[] = [];
    const held = heldMeterStore(durable, order);
    const h = boot({
      broker,
      runner: seq(1, {}),
      eventStore: held.store,
      body: async () => {
        order.push("effect");
      },
    });
    const run = await h.start("d1", g);
    await until(() => order.includes("append:RESOURCE_METERED"), "the held meter append");
    for (let i = 0; i < 5; i++) {
      await durable.read("d1");
      for (let j = 0; j < 20; j++) await Promise.resolve();
    }
    expect(h.ran.n).toBe(0);
    held.release();
    await run.waitForCompletion();
    expect(order.indexOf("append:RESOURCE_METERED")).toBeLessThan(order.indexOf("effect"));
  });

  it("an idempotent:false effect adopted as completed-with-result still has its count in the log", async () => {
    const broker = mkBroker();
    const g = await mint(broker, 3);
    const stores = freshStores();
    const never = () => new Promise<void>(() => {});
    const runner: FlowRunner<unknown, unknown> = async (ctx: ExecutionContext) => {
      await ctx.run(task("only"), {});
      return {};
    };
    const a = boot({ broker, runner, stores, idempotent: false, body: never });
    void a.start("d2", g);
    await until(() => a.ran.n === 1, "the effect to run, then 'crash'");
    const b = boot({ broker, runner, stores, idempotent: false });
    await recoverAbandoned(b.runtime, { source: stores.eventStore, isAbandoned: () => true });
    const parked = await b.runtime.loadState("d2");
    expect(parked?.suspendedOn?.on).toBe(EFFECT_INDOUBT_RESOLVED);
    const resumed = await b.runtime.resume(
      "d2",
      {
        eventType: EFFECT_INDOUBT_RESOLVED,
        payload: { stepId: "only", resolution: "completed-with-result", output: { ok: true } },
      },
      { principal: chainOf(g) }
    );
    await resumed.waitForCompletion();
    expect(b.ran.n).toBe(0); // adopted, never re-run
    const state = await b.runtime.loadState("d2");
    expect((state?.variables._resources as { custom?: Record<string, number> }).custom).toEqual({
      "lease.w": 1,
    });
    expect(await types(stores, "d2")).toContain("RESOURCE_METERED");
  });

  it("a context without flush (transient seam) refuses a leased effect; it never runs", async () => {
    const broker = mkBroker();
    const g = await mint(broker, 3);
    const h = boot({ broker, runner: seq(0, {}) });
    await expect(
      h.effects.invokeTransient("act", {}, { principal: chainOf(g) })
    ).rejects.toBeInstanceOf(LeaseDurabilityError);
    expect(h.ran.n).toBe(0);
    const bare = fakeCtx(g, { flush: false });
    await expect(
      taskLeaseMiddleware({ secret: SECRET })(bare.ctx, {}, async () => 1)
    ).rejects.toBeInstanceOf(LeaseDurabilityError);
    expect(bare.emitted).toEqual([]);
    // an unleased effect and a no-grant call need no flush
    const other = fakeCtx(g, { flush: false, toolId: "other" });
    await taskLeaseMiddleware({ secret: SECRET })(other.ctx, {}, async () => 1);
  });
});
