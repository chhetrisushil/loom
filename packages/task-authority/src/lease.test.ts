import type { EventEnvelope, FlowDefinition } from "@loomwork/core";
import {
  type EffectContext,
  type EffectMiddleware,
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
import { CHILD_LEASE_TOOL, childLeaseEffect } from "./childLease";
import {
  GrantRevokedError,
  LeaseDimensionDroppedError,
  LeaseDurabilityError,
  LeaseExhaustedError,
  LeaseGrantInvalidError,
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
  /** Throw on the first call only. */
  throwsFirst?: boolean;
  pre?: EffectMiddleware[];
  /** Give the middleware the registry lookup (R33), so it can tell the branded child-lease effect from an impostor. */
  registry?: boolean;
}
function boot(o: BootOpts) {
  const ran = { n: 0 };
  const effects: EffectRuntime = new EffectRuntime([
    ...(o.pre ?? []),
    taskLeaseMiddleware({
      secret: SECRET,
      source: o.broker,
      ...(o.registry === true && { effects: () => effects }),
      ...(o.strict !== undefined && { strictLeases: o.strict }),
    }),
  ]);
  const act = new ToolEffect(
    async () => {
      const nth = ++ran.n;
      await o.body?.();
      if (o.throws === true || (o.throwsFirst === true && nth === 1)) throw new Error("boom");
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
  over: {
    attempt?: number;
    flush?: boolean;
    readResources?: boolean;
    toolId?: string;
    exec?: string;
  } = {}
) {
  const emitted: string[] = [];
  const custom: Record<string, number> = {};
  const ctx = {
    executionId: over.exec ?? "fx",
    stepId: "s",
    workflowId: "w",
    attempt: over.attempt ?? 1,
    toolId: over.toolId ?? "act",
    emit: (t: string, payload: { custom?: Record<string, number> }) => {
      emitted.push(t);
      if (t === "RESOURCE_METERED")
        for (const [k, v] of Object.entries(payload.custom ?? {})) custom[k] = (custom[k] ?? 0) + v;
    },
    ...(over.flush !== false && { flush: async () => {} }),
    ...(over.readResources !== false && {
      readResources: () => ({ tokens: 0, costUsd: 0, ms: 0, count: 0, custom: { ...custom } }),
    }),
    ...(g !== undefined && { principal: { actor: "agent-a", taskGrant: g } }),
  } as unknown as EffectContext;
  return { ctx, emitted, custom };
}

describe("mapping", () => {
  it("strict by default refuses an unmapped effect; strictLeases:false lets it through uncounted", async () => {
    const broker = mkBroker();
    const g = await mint(broker, 3);
    const strict = taskLeaseMiddleware({ secret: SECRET });
    const loose = taskLeaseMiddleware({ secret: SECRET, strictLeases: false });
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
    await expect(
      taskLeaseMiddleware({ secret: SECRET })(ctx, {}, async () => 1)
    ).rejects.toBeInstanceOf(LeaseGrantInvalidError);
    expect(emitted).toEqual([]);
  });
});

describe("revocation", () => {
  const g = signTaskGrant(SECRET, grantBody());
  const src = (revoked: (d: string) => Promise<boolean>): GrantSource => ({
    current: async () => g,
    holder: async () => undefined,
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

  it("K concurrent leased effects on a cache miss make exactly one revoked() call", async () => {
    let calls = 0;
    let release: (v: boolean) => void = () => {};
    const gate = new Promise<boolean>((r) => {
      release = r;
    });
    const mw = taskLeaseMiddleware({
      secret: SECRET,
      source: src(() => {
        calls++;
        return gate;
      }),
    });
    const runs = Array.from({ length: 8 }, () => mw(fakeCtx(g).ctx, {}, async () => 1));
    await until(() => calls >= 1, "the first revoked() call");
    release(false);
    expect(await Promise.all(runs)).toEqual(Array(8).fill(1));
    expect(calls).toBe(1);
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

  it("a clean answer is trusted only for the TTL: a revoke after it is seen once the clock passes it", async () => {
    let clock = 0;
    let revokedNow = false;
    let calls = 0;
    const mw = taskLeaseMiddleware({
      secret: SECRET,
      revocationCacheMs: 1000,
      now: () => clock,
      source: src(async () => {
        calls++;
        return revokedNow;
      }),
    });
    await mw(fakeCtx(g).ctx, {}, async () => 1);
    revokedNow = true;
    clock = 999;
    await mw(fakeCtx(g, { exec: "o2" }).ctx, {}, async () => 1); // still inside the TTL: cached clean
    expect(calls).toBe(1);
    clock = 1001;
    await expect(mw(fakeCtx(g, { exec: "o3" }).ctx, {}, async () => 1)).rejects.toBeInstanceOf(
      GrantRevokedError
    );
    expect(calls).toBe(2);
    revokedNow = false; // a revoked answer is sticky
    clock = 10_000;
    await expect(mw(fakeCtx(g, { exec: "o4" }).ctx, {}, async () => 1)).rejects.toBeInstanceOf(
      GrantRevokedError
    );
    expect(calls).toBe(2);
  });

  it("anything but a clean false fails closed: undefined, a non-promise, a sync throw", async () => {
    const answers: Array<() => unknown> = [
      () => Promise.resolve(undefined),
      () => "no",
      () => {
        throw new Error("sync");
      },
    ];
    for (const a of answers) {
      const mw = taskLeaseMiddleware({
        secret: SECRET,
        source: src(a as never),
      });
      await expect(mw(fakeCtx(g).ctx, {}, async () => 1)).rejects.toBeInstanceOf(GrantRevokedError);
    }
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
    await taskLeaseMiddleware({ secret: SECRET, strictLeases: false })(
      other.ctx,
      {},
      async () => 1
    );
  });

  it("a rejecting flush() propagates, next never runs, and the meter was already emitted", async () => {
    const g = signTaskGrant(SECRET, grantBody());
    const { ctx, emitted } = fakeCtx(g);
    const boom = new Error("flush failed");
    (ctx as { flush?: () => Promise<void> }).flush = () => Promise.reject(boom);
    let nextCalls = 0;
    await expect(
      taskLeaseMiddleware({ secret: SECRET })(ctx, {}, async () => {
        nextCalls++;
        return 1;
      })
    ).rejects.toBe(boom);
    expect(nextCalls).toBe(0);
    expect(JSON.stringify(emitted)).toContain("RESOURCE_METERED");
  });

  it("a context without readResources gets LeaseDurabilityError and counts nothing", async () => {
    const g = signTaskGrant(SECRET, grantBody());
    const { ctx, emitted } = fakeCtx(g, { readResources: false });
    await expect(
      taskLeaseMiddleware({ secret: SECRET })(ctx, {}, async () => 1)
    ).rejects.toBeInstanceOf(LeaseDurabilityError);
    expect(emitted).toEqual([]);
  });
});

describe("live-fold counting (R19)", () => {
  const runAll =
    (n: number, settled: PromiseSettledResult<unknown>[]): FlowRunner<unknown, unknown> =>
    async (ctx: ExecutionContext) => {
      settled.push(
        ...(await Promise.allSettled(
          Array.from({ length: n }, (_, i) => ctx.run(task(`c${i}`), {}))
        ))
      );
      return {};
    };

  for (const idempotent of [undefined, false]) {
    it(`K parallel calls with K = ceiling all run (idempotent: ${String(idempotent)})`, async () => {
      const broker = mkBroker();
      const g = await mint(broker, 4);
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const settled: PromiseSettledResult<unknown>[] = [];
      const h = boot({
        broker,
        runner: runAll(4, settled),
        body: () => gate,
        ...(idempotent !== undefined && { idempotent }),
      });
      const run = await h.start(`k-${String(idempotent)}`, g);
      await until(() => h.ran.n === 4, "all four effects to start");
      release();
      await run.waitForCompletion();
      expect(h.ran.n).toBe(4);
      expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
    });
  }

  it("A in flight, an unleased step, then B and C at ceiling 3: all three run", async () => {
    const broker = mkBroker();
    const g = await mint(broker, 3);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const runner: FlowRunner<unknown, unknown> = async (ctx: ExecutionContext) => {
      const a = ctx.run(task("A"), {});
      await ctx.run(task("U", "other"), {});
      await ctx.run(task("B"), {});
      await ctx.run(task("C"), {});
      release();
      await a;
      return {};
    };
    const h = boot({
      broker,
      runner,
      strict: false,
      body: () => (calls++ === 0 ? gate : Promise.resolve()),
    });
    const run = await h.start("p1b", g);
    await run.waitForCompletion();
    expect(h.ran.n).toBe(3);
  });

  it("the same context twice at ceiling 1: the first attempt throws, the second is refused", async () => {
    const g = signTaskGrant(SECRET, grantBody({ leases: { w: { ceiling: 1, effects: ["act"] } } }));
    const mw = taskLeaseMiddleware({ secret: SECRET });
    const { ctx } = fakeCtx(g);
    await expect(
      mw(ctx, {}, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await expect(mw(ctx, {}, async () => 1)).rejects.toBeInstanceOf(LeaseExhaustedError);
  });

  it("ceiling 2, the first effect throws and the flow catches it: the second runs", async () => {
    const broker = mkBroker();
    const g = await mint(broker, 2);
    const out: { err?: unknown } = {};
    const runner: FlowRunner<unknown, unknown> = async (ctx: ExecutionContext) => {
      try {
        await ctx.run(task("t0"), {});
      } catch {
        // the failure is the flow's to handle
      }
      await ctx.run(task("t1"), {});
      return seq(1, out)(ctx, {});
    };
    const h = boot({ broker, runner, throwsFirst: true });
    const run = await h.start("t4", g);
    await run.waitForCompletion();
    expect(h.ran.n).toBe(2);
    expect(out.err).toBeInstanceOf(LeaseExhaustedError); // two counted attempts spent the ceiling
    expect((await types(h.stores, "t4")).filter((x) => x === "RESOURCE_METERED")).toHaveLength(2);
  });

  it("a full custom-dimension cap: LeaseDimensionDroppedError, the effect never runs, a restart does not overshoot", async () => {
    const broker = mkBroker();
    const g = await mint(broker, 2);
    const pre: EffectMiddleware = async (ctx, _i, next) => {
      if (ctx.toolId === "other") {
        const custom: Record<string, number> = {};
        for (let i = 0; i < 32; i++) custom[`app.d${i}`] = 1;
        ctx.emit("RESOURCE_METERED", { custom });
      }
      return next();
    };
    const errs: unknown[] = [];
    const runner: FlowRunner<unknown, unknown> = async (ctx: ExecutionContext) => {
      await ctx.run(task("o", "other"), {});
      for (const s of ["a0", "a1"]) {
        try {
          await ctx.run(task(s), {});
        } catch (e) {
          errs.push(e);
        }
      }
      await ctx.suspend({ on: "GO" });
      for (const s of ["a2", "a3"]) {
        try {
          await ctx.run(task(s), {});
        } catch (e) {
          errs.push(e);
        }
      }
      return {};
    };
    const h1 = boot({ broker, runner, pre: [pre], strict: false });
    const r1 = await h1.start("dims", g);
    await r1.waitForSuspend();
    const h2 = boot({ broker, runner, stores: h1.stores, pre: [pre], strict: false });
    const r2 = await h2.runtime.resume(
      "dims",
      { eventType: "GO", payload: {} },
      { principal: chainOf(g) }
    );
    await r2.waitForCompletion();
    expect(h1.ran.n + h2.ran.n).toBe(0);
    expect(errs.length).toBeGreaterThanOrEqual(4); // a resume re-runs the failed steps too
    for (const e of errs) expect(e).toBeInstanceOf(LeaseDimensionDroppedError);
  });
});

// R33 (T15): only the effect `childLeaseEffect()` made is exempt from counting; the id alone is not enough.
describe("child-lease exemption is branded", () => {
  const grantFor = (b: InMemoryGrantBroker, leaseEffects: string[]) =>
    b.mint({
      taskId: "t1",
      issuedTo: "agent-a",
      effects: ["act", CHILD_LEASE_TOOL],
      leases: { w: { ceiling: 2, effects: leaseEffects } },
      ttlMs: 60_000,
    });
  const callTwice = (o: { stoppedAt?: number }): FlowRunner<unknown, unknown> => {
    return async (ctx: ExecutionContext) => {
      for (let i = 0; i < 3; i++) {
        try {
          await ctx.run(task(`i${i}`, CHILD_LEASE_TOOL), {});
        } catch (e) {
          o.stoppedAt = i;
          return { err: (e as Error).name };
        }
      }
      return { err: undefined };
    };
  };
  const impostor = (ran: { n: number }) =>
    new ToolEffect(async () => {
      ran.n++;
      return { ok: true };
    });

  // A lease cannot map this id (a colon makes it resource-qualified, refused at shape validation), so under
  // strict leases an impostor is always refused; with strictLeases:false it is as uncounted as any unmapped effect.
  it("an app effect under the id is a normal leased effect: strict refuses it unmapped, it never runs", async () => {
    const broker = mkBroker();
    const g = await grantFor(broker, ["act"]);
    const o: { stoppedAt?: number } = {};
    const h = boot({ broker, runner: callTwice(o), registry: true });
    const ran = { n: 0 };
    h.effects.register(CHILD_LEASE_TOOL, impostor(ran));
    await (await h.start("e", g)).waitForCompletion();
    expect(o.stoppedAt).toBe(0);
    expect(ran.n).toBe(0);
  });

  it("the real branded effect stays exempt; without a registry lookup nothing can prove it, so it is not", async () => {
    const real = childLeaseEffect({ secret: SECRET, broker: mkBroker() });
    const mw = (registry: boolean) => {
      const fx: EffectRuntime = new EffectRuntime([]);
      fx.register(CHILD_LEASE_TOOL, real);
      return taskLeaseMiddleware({ secret: SECRET, ...(registry && { effects: () => fx }) });
    };
    const g = await mint(mkBroker(), 3);
    const ctxOf = () => fakeCtx(g, { toolId: CHILD_LEASE_TOOL, flush: false });
    expect(await mw(true)(ctxOf().ctx, {}, async () => "ran")).toBe("ran");
    await expect(mw(false)(ctxOf().ctx, {}, async () => "ran")).rejects.toBeInstanceOf(
      LeaseUnmappedError
    );
  });
});
