import { type EventEnvelope, type FlowDefinition, SuspendError } from "@loomwork/core";
import { EffectRuntime, type PrincipalChain, ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { awaitChild, awaitChildren, superviseChildren } from "@loomwork/orchestration";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import {
  EFFECT_INDOUBT_RESOLVED,
  type ExecutionContext,
  type FlowRunner,
  type RegisteredFlow,
  WorkflowRuntime,
  recoverAbandoned,
} from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TaskGrantAuthorizer } from "./authorizer";
import { GrantBrokerError } from "./broker";
import {
  CHILD_LEASE_TOOL,
  type ChildGrantMinter,
  childGrantMinter,
  childLeaseEffect,
  reserveChildLease,
} from "./childLease";
import { LeaseExhaustedError } from "./errors";
import type { TaskGrant } from "./grant";
import { installTaskAuthority } from "./install";
import { taskLeaseMiddleware } from "./lease";
import { InMemoryGrantBroker } from "./renew";
import { RENEWAL_GATE, withRenewal } from "./renewal";

// ADR 0150 D6: a child's lease is carved from the parent's by RESERVATION in the parent's own fold.
const SECRET = "child-lease-secret";
const NOW = 1_000_000;
const PARENT = "P";
const CHILD = "P::k";
const task = (id: string) => ({ _tag: "TaskDefinition", kind: "tool", id, toolId: "act" }) as never;
const def = (id: string): FlowDefinition =>
  ({
    _tag: "FlowDefinition",
    id,
    name: id,
    version: "1.0.0",
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    steps: [],
  }) as unknown as FlowDefinition;

type Out = { ownRan: number; ownErr?: string; childOut?: unknown; err?: string };
type Parent = (ctx: ExecutionContext) => Promise<unknown>;

/** Run up to `n` acts, stop at the first refusal. */
async function acts(ctx: ExecutionContext, prefix: string, n: number) {
  let ran = 0;
  let err: string | undefined;
  for (let i = 0; i < n; i++) {
    try {
      await ctx.run(task(`${prefix}${i}`), {});
      ran++;
    } catch (e) {
      err = (e as Error).name;
      break;
    }
  }
  return { ran, err };
}

interface Std {
  lease: number;
  before?: number;
  childActs?: number;
  childFails?: boolean;
  after?: number;
  hook?: () => Promise<void>;
  reserveKey?: () => string;
}
/** The documented usage: reserve, spawn from the recorded step, settle after a COMPLETED child, then own acts. */
const std =
  (i: Std): Parent =>
  async (ctx) => {
    const out: Out = { ownRan: 0 };
    await acts(ctx, "b", i.before ?? 0);
    try {
      const res = await reserveChildLease(ctx, i.reserveKey?.() ?? "k", { w: i.lease });
      await i.hook?.();
      out.childOut = await awaitChild(ctx, {
        key: "k",
        flowId: "child",
        input: { n: i.childActs ?? 0, fails: i.childFails },
        ...res.spawn,
      });
      await res.settle();
    } catch (e) {
      if (e instanceof SuspendError) throw e; // a park is control flow, not a failure
      out.err = (e as Error).name;
    }
    const own = await acts(ctx, "a", i.after ?? 0);
    out.ownRan = own.ran;
    if (own.err !== undefined) out.ownErr = own.err;
    return out;
  };

function world() {
  return {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
  };
}
interface BootOpts {
  /** The store the runtime appends to (a decorated view of `world().eventStore`). */
  store?: InMemoryAsyncEventStore;
  /** Wrap the real minter (crash simulation). */
  wrapMint?: (real: ChildGrantMinter) => ChildGrantMinter;
  noMinter?: boolean;
  /** Put the real grant authorizer on the ring (needed to see a `reads` refusal). */
  authorize?: boolean;
}

function boot(
  w: ReturnType<typeof world>,
  broker: InMemoryGrantBroker,
  parent: Parent,
  o: BootOpts = {}
) {
  const errors: unknown[] = [];
  const ran = { n: 0, seen: [] as (PrincipalChain | undefined)[] };
  const effects: EffectRuntime = new EffectRuntime(
    [taskLeaseMiddleware({ secret: SECRET, source: broker, effects: () => effects })],
    o.authorize === true
      ? {
          authorizer: new TaskGrantAuthorizer({
            secret: SECRET,
            base: { authorize: () => ({ allowed: true }) },
            now: () => NOW,
          }),
        }
      : {}
  );
  effects.register(
    "rd",
    new ToolEffect(async () => ({ ok: true }), {
      resourceOf: (i: { scope?: string }) => i.scope,
      capabilities: { read: true },
    })
  );
  effects.register(
    "act",
    new ToolEffect(async (_a, ctx) => {
      ran.n++;
      ran.seen.push((ctx as { principal?: PrincipalChain }).principal);
      return { ok: true };
    })
  );
  effects.register(CHILD_LEASE_TOOL, childLeaseEffect({ secret: SECRET, broker }));
  const holder: { sup?: ReturnType<typeof superviseChildren> } = {};
  const runtime = new WorkflowRuntime({
    ...w,
    ...(o.store !== undefined && { eventStore: o.store }),
    effectRuntime: effects,
    onWarn: () => {},
    onEvent: (e) => holder.sup?.onEvent(e),
  });
  const childRunner: FlowRunner<unknown, unknown> = async (ctx: ExecutionContext, input) => {
    const { n, fails, forge, reads } = input as {
      n: number;
      fails?: boolean;
      forge?: boolean;
      reads?: string[];
    };
    if (reads !== undefined) {
      const got: Record<string, boolean> = {};
      for (const scope of reads)
        got[scope] = await ctx
          .run({ _tag: "TaskDefinition", kind: "tool", id: `r-${scope}`, toolId: "rd" } as never, {
            scope,
          })
          .then(
            () => true,
            () => false
          );
      return got;
    }
    if (forge === true) ctx.emit("RESOURCE_METERED", { custom: { "lease.w.returned": 100 } });
    const r = await acts(ctx, "c", n);
    if (fails === true) throw new Error("child blew up");
    return { ran: r.ran, err: r.err };
  };
  runtime.registerFlow(def("child"), childRunner);
  runtime.registerFlow(def("parent"), parent as FlowRunner<unknown, unknown>);
  installTaskAuthority(runtime, { source: broker, secret: SECRET, now: () => NOW });
  const real = childGrantMinter(broker, { ttlMs: 60_000, now: () => NOW });
  holder.sup = superviseChildren({
    runtime,
    flows: { child: { definition: def("child"), runner: childRunner } as RegisteredFlow },
    ...(o.noMinter !== true && { taskAuthority: o.wrapMint?.(real) ?? real }),
    onError: (e) => errors.push(e),
  });
  const parentFlow = { definition: def("parent"), runner: parent } as never;
  return { runtime, errors, ran, parentFlow, sup: holder.sup };
}

const root = (b: InMemoryGrantBroker, ceiling = 10): Promise<TaskGrant> =>
  b.mint({
    taskId: PARENT,
    issuedTo: PARENT,
    effects: ["act", CHILD_LEASE_TOOL],
    leases: { w: { ceiling, effects: ["act"] } },
    ttlMs: 60_000,
  });
const chain = (g: TaskGrant): PrincipalChain => ({ actor: g.issuedTo, taskGrant: g });
const mk = (policy?: ConstructorParameters<typeof InMemoryGrantBroker>[0]["policy"]) =>
  new InMemoryGrantBroker({ secret: SECRET, now: () => NOW, ...(policy && { policy }) });

async function until(cond: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 10_000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out on ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function finished(rt: WorkflowRuntime, id: string) {
  const box: { s?: NonNullable<Awaited<ReturnType<WorkflowRuntime["loadState"]>>> } = {};
  await until(async () => {
    const s = await rt.loadState(id);
    if (s?.status === "completed" || s?.status === "failed") box.s = s;
    return box.s !== undefined;
  }, `${id} to finish`);
  return box.s as NonNullable<typeof box.s>;
}
const custom = async (rt: WorkflowRuntime, id: string) =>
  ((await rt.loadState(id))?.variables._resources as { custom?: Record<string, number> })?.custom ??
  {};
const output = async (rt: WorkflowRuntime, id: string) =>
  (await finished(rt, id)).variables._output as Out;

async function runParent(parent: Parent, o: BootOpts = {}, ceiling = 10) {
  const w = world();
  const broker = mk();
  const g = await root(broker, ceiling);
  const h = boot(w, broker, parent, o);
  await h.runtime.start(h.parentFlow, {}, { executionId: PARENT, principal: chain(g) });
  return { w, broker, h, g };
}
/** A flow that tries to spawn a child with a lease of its own choosing, however it got it. */
const raw =
  (lease: number, reserve?: number, own = 10): Parent =>
  async (ctx) => {
    const out: Out = { ownRan: 0 };
    try {
      if (reserve !== undefined) await reserveChildLease(ctx, "k", { w: reserve });
      out.childOut = await awaitChild(ctx, {
        key: "k",
        flowId: "child",
        input: { n: 10 },
        lease: { w: lease },
        leaseParent: PARENT,
      });
    } catch (e) {
      if (e instanceof SuspendError) throw e;
      out.err = (e as Error).name;
    }
    out.ownRan = (await acts(ctx, "a", own)).ran;
    return out;
  };

describe("child lease under a tenant parent (R30/R34)", () => {
  it("a supervised child completes and its restored principal carries the tenant", async () => {
    const w = world();
    const broker = mk();
    const g = await broker.mint({
      taskId: PARENT,
      issuedTo: PARENT,
      effects: ["act", CHILD_LEASE_TOOL],
      leases: { w: { ceiling: 10, effects: ["act"] } },
      ttlMs: 60_000,
      tenant: "acme",
      onBehalfOf: "user-1",
    });
    const h = boot(w, broker, std({ lease: 4, childActs: 2, after: 1 }));
    await h.runtime.start(
      h.parentFlow,
      {},
      { executionId: PARENT, principal: { ...chain(g), tenant: "acme", onBehalfOf: "user-1" } }
    );
    const out = await output(h.runtime, PARENT);
    expect(out.childOut).toEqual({ ran: 2 });
    expect(h.errors).toEqual([]);
    const kid = h.ran.seen.filter((p) => p?.actor === CHILD);
    expect(kid.length).toBe(2);
    for (const p of kid) expect(p).toMatchObject({ tenant: "acme", onBehalfOf: "user-1" });
  });
});

describe("child lease reservation (ADR 0150 D6)", () => {
  it("(a) the child is bounded by its reservation; the parent by ceiling - reserved", async () => {
    const { h } = await runParent(std({ lease: 6, childActs: 7, after: 6 }));
    const out = await output(h.runtime, PARENT);
    expect(out.childOut).toEqual({ ran: 6, err: "LeaseExhaustedError" }); // 7th refused in the child
    expect(out.ownRan).toBe(4); // the child spent all 6, so nothing came back
    expect(out.ownErr).toBe("LeaseExhaustedError");
    expect(await custom(h.runtime, CHILD)).toMatchObject({ "lease.w": 6 });
    expect(h.ran.n).toBe(10);
    expect(h.errors).toEqual([]);
  });

  it("(b) a child that used 2 of 6 returns 4 (recorded by the supervisor, taken once)", async () => {
    const { h } = await runParent(std({ lease: 6, before: 4, childActs: 2, after: 6 }));
    const out = await output(h.runtime, PARENT);
    expect(out.ownRan).toBe(4); // 4 + 4 = 8 own, plus the child's 2 = the ceiling of 10
    expect(out.ownErr).toBe("LeaseExhaustedError");
    expect(await custom(h.runtime, PARENT)).toEqual({
      "lease.w": 8,
      "lease.w.reserved": 6,
      "lease.w.returned": 4,
    });
    expect(h.ran.n).toBe(10);
  });

  it("(c) a crash between the reservation and the spawn does not reserve twice", async () => {
    const run = async (mutate: boolean) => {
      const w = world();
      const broker = mk();
      const g = await root(broker, 20); // room for a second reservation, so only the log can stop it
      let first = true;
      const never = new Promise<void>(() => {});
      const parent = std({
        lease: 6,
        childActs: 1,
        ...(mutate && { reserveKey: () => `k${Math.random()}` }),
        hook: async () => {
          if (!first) return;
          first = false;
          await never; // "crash": the reservation is durable, the spawn decision is not
        },
      });
      const a = boot(w, broker, parent);
      void a.runtime.start(a.parentFlow, {}, { executionId: PARENT, principal: chain(g) });
      await until(
        async () => (await custom(a.runtime, PARENT))["lease.w.reserved"] !== undefined,
        "the reservation"
      );
      const b = boot(w, broker, parent);
      await recoverAbandoned(b.runtime, { source: w.eventStore, isAbandoned: () => true });
      await output(b.runtime, PARENT);
      return custom(b.runtime, PARENT);
    };
    const c = await run(false);
    expect(c["lease.w.reserved"]).toBe(6); // exactly the request
    expect(c["lease.w.returned"]).toBe(5);
    // Fail-proof: a reservation that is not a recorded step (a fresh step id per run) meters again.
    expect((await run(true))["lease.w.reserved"]).toBeGreaterThanOrEqual(12);
  }, 20_000);

  it("(c2) a crash after the spawn decision, before or after the mint, recovers with one grant", async () => {
    for (const when of ["before", "after"] as const) {
      const w = world();
      const broker = mk();
      const g = await root(broker);
      const parent = std({ lease: 6, childActs: 2, after: 10 });
      const hang: BootOpts = {
        wrapMint: (real: ChildGrantMinter): ChildGrantMinter => ({
          settleChild: (id: string, r: Record<string, number>) => real.settleChild(id, r),
          mintChildGrant: async (p, s) => {
            if (when === "after") await real.mintChildGrant(p, s);
            return new Promise<never>(() => {}); // "crash": the child was never started
          },
        }),
      };
      const a = boot(w, broker, parent, hang);
      await a.runtime.start(a.parentFlow, {}, { executionId: PARENT, principal: chain(g) });
      await until(async () => (await w.eventStore.read(PARENT)).length > 0, "the parent");
      await until(
        async () => (await a.runtime.loadState(PARENT))?.status === "suspended",
        "the park"
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(await a.runtime.loadState(CHILD)).toBeNull();
      const b = boot(w, broker, parent);
      expect((await b.sup.recover()).started).toBe(1);
      const out = await output(b.runtime, PARENT);
      expect(b.errors).toEqual([]);
      expect((await broker.current(CHILD))?.leases.w?.ceiling).toBe(6);
      expect(await custom(b.runtime, PARENT)).toMatchObject({ "lease.w.reserved": 6 });
      expect(out.ownRan).toBe(8); // 10 - 6 reserved + 4 returned - ... child spent 2
      expect(a.ran.n + b.ran.n).toBe(10);
    }
  }, 30_000);

  it("(c3) a crash inside the reserve step goes in doubt; the operator's answer decides, nothing doubles", async () => {
    const w = world();
    const broker = mk();
    const g = await root(broker);
    const held: InMemoryAsyncEventStore = new Proxy(w.eventStore, {
      get(target, prop, receiver) {
        if (prop === "append") {
          return async (env: EventEnvelope, ...rest: unknown[]) => {
            if (
              env.eventType === "STEP_COMPLETED" &&
              JSON.stringify(env.payload).includes("reserve")
            )
              return new Promise<void>(() => {}); // the meter is durable, the step's completion is not
            return (target.append as (...a: unknown[]) => Promise<void>)(env, ...rest);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const parent = std({ lease: 6, childActs: 1, after: 10 });
    const a = boot(w, broker, parent, { store: held });
    void a.runtime.start(a.parentFlow, {}, { executionId: PARENT, principal: chain(g) });
    await until(
      async () => (await custom(a.runtime, PARENT))["lease.w.reserved"] !== undefined,
      "the meter"
    );
    const b = boot(w, broker, parent);
    await recoverAbandoned(b.runtime, { source: w.eventStore, isAbandoned: () => true });
    expect((await b.runtime.loadState(PARENT))?.suspendedOn?.on).toBe(EFFECT_INDOUBT_RESOLVED);
    expect((await custom(b.runtime, PARENT))["lease.w.reserved"]).toBe(6); // not re-run
    const resumed = await b.runtime.resume(
      PARENT,
      {
        eventType: EFFECT_INDOUBT_RESOLVED,
        payload: {
          stepId: "task-authority:reserve:k",
          resolution: "completed-with-result",
          output: { taskId: PARENT, lease: { w: 6 } },
        },
      },
      { principal: chain(g) }
    );
    void resumed;
    const out = await output(b.runtime, PARENT);
    expect((await custom(b.runtime, PARENT))["lease.w.reserved"]).toBe(6);
    expect(out.err).toBeUndefined();
    expect(a.ran.n + b.ran.n).toBeLessThanOrEqual(10);
  }, 20_000);

  it("(d) nothing can be minted above a reservation, by the broker or the supervisor's minter", async () => {
    const { h, broker } = await runParent(std({ lease: 6, childActs: 1 }));
    await output(h.runtime, PARENT);
    expect((await broker.current(CHILD))?.leases.w?.ceiling).toBe(6);
    await expect(
      broker.mint({
        taskId: "g",
        issuedTo: "g",
        effects: ["act"],
        leases: { w: { ceiling: 7, effects: ["act"] } },
        ttlMs: 1000,
        parent: { taskId: CHILD },
      })
    ).rejects.toThrow(/headroom/);
    const minter = childGrantMinter(broker, { ttlMs: 1000, now: () => NOW });
    await expect(
      minter.mintChildGrant(
        { executionId: CHILD, taskId: CHILD, resources: { "lease.w.reserved": 99 } },
        { childId: `${CHILD}::g`, lease: { w: 7 } }
      )
    ).rejects.toThrow(/headroom/);
  });

  it("(P1) a raw spawn that skipped the reservation is refused; total runs stay within the ceiling", async () => {
    const { h } = await runParent(raw(10));
    const out = await output(h.runtime, PARENT);
    expect(out.err).toBe("TypedFailure");
    expect(String(h.errors[0])).toMatch(/reserved in its fold/);
    expect(await h.runtime.loadState(CHILD)).toBeNull();
    expect(h.ran.n).toBeLessThanOrEqual(10);
  });

  it("(P4) one reservation cannot back two children", async () => {
    const parent: Parent = async (ctx) => {
      const out: unknown[] = [];
      for (const k of ["k1", "k2"]) {
        const res = await reserveChildLease(ctx, "same", { w: 5 });
        try {
          out.push(
            await awaitChild(ctx, { key: k, flowId: "child", input: { n: 5 }, ...res.spawn })
          );
        } catch (e) {
          if (e instanceof SuspendError) throw e;
          out.push((e as Error).name);
        }
      }
      return { out, own: (await acts(ctx, "a", 10)).ran };
    };
    const { h } = await runParent(parent);
    await finished(h.runtime, PARENT);
    expect(h.ran.n).toBeLessThanOrEqual(10);
    expect(String(h.errors[0])).toMatch(/reserved in its fold/);
    expect((await custom(h.runtime, PARENT))["lease.w.reserved"]).toBe(5);
  });

  it("(P5) a spawn larger than the reservation is refused", async () => {
    const { h } = await runParent(raw(10, 1));
    await output(h.runtime, PARENT);
    expect(String(h.errors[0])).toMatch(/reserved in its fold/);
    expect(h.ran.n).toBeLessThanOrEqual(10);
  });

  it("(P2/P3) a flow cannot forge a return: no amount is accepted, early or foreign takes return nothing", async () => {
    const parent: Parent = async (ctx) => {
      const ret = (id: string, input: unknown) =>
        ctx.run({ ...(task(id) as object), toolId: CHILD_LEASE_TOOL } as never, input as never);
      const res = await reserveChildLease(ctx, "k", { w: 6 });
      await ret("r1", { op: "return", lease: { w: 6 } }).catch(() => undefined); // a caller amount
      await ret("r2", { op: "return", child: CHILD }).catch(() => undefined); // before the child ran
      await ret("r3", { op: "return", child: "P::other" }).catch(() => undefined); // not its child
      await awaitChild(ctx, { key: "k", flowId: "child", input: { n: 6 }, ...res.spawn });
      await ret("r4", { op: "return", child: CHILD }).catch(() => undefined); // forged, child spent 6
      await res.settle();
      return { own: (await acts(ctx, "a", 10)).ran };
    };
    const { h } = await runParent(parent);
    await finished(h.runtime, PARENT);
    expect(h.ran.n).toBe(10); // 6 child + 4 parent
    expect((await custom(h.runtime, PARENT))["lease.w.returned"]).toBeUndefined();
  });

  it("(P8) the recorded return is taken once: a second take meters nothing", async () => {
    const parent: Parent = async (ctx) => {
      const res = await reserveChildLease(ctx, "k", { w: 6 });
      await awaitChild(ctx, { key: "k", flowId: "child", input: { n: 2 }, ...res.spawn });
      await res.settle();
      await ctx.run(
        { ...(task("again") as object), toolId: CHILD_LEASE_TOOL } as never,
        {
          op: "return",
          child: CHILD,
        } as never
      );
      return { own: (await acts(ctx, "a", 10)).ran };
    };
    const { h } = await runParent(parent);
    await finished(h.runtime, PARENT);
    expect((await custom(h.runtime, PARENT))["lease.w.returned"]).toBe(4);
    expect(h.ran.n).toBe(10); // 2 child + 8 parent
  });

  it("(P7) a child's renewal never rises above its minted ceiling", async () => {
    const broker = mk(() => ({ leases: { w: 10 } }));
    await root(broker);
    const m = childGrantMinter(broker, { ttlMs: 60_000, now: () => NOW });
    await broker.claim(PARENT, PARENT);
    const cg = await m.mintChildGrant(
      { executionId: PARENT, taskId: PARENT, resources: { "lease.w.reserved": 6 } },
      { childId: CHILD, lease: { w: 6 } }
    );
    const v = await broker.renew({
      taskId: CHILD,
      epoch: cg.taskGrant.epoch,
      spent: { w: 6 },
      renewals: 0,
    });
    expect(v).toMatchObject({ granted: false });
    expect((await broker.current(CHILD))?.leases.w?.ceiling).toBe(6);
  });

  it("(q) the minter never claims: an unheld task is refused, and the victim's claim still works", async () => {
    const broker = mk();
    await broker.mint({
      taskId: "victim",
      issuedTo: "victim-agent",
      effects: ["act"],
      leases: { w: { ceiling: 10, effects: ["act"] } },
      ttlMs: 60_000,
    });
    const m = childGrantMinter(broker, { ttlMs: 60_000, now: () => NOW });
    await expect(
      m.mintChildGrant(
        { executionId: "attacker", taskId: "victim", resources: { "lease.w.reserved": 10 } },
        { childId: "attacker::c", lease: { w: 10 } }
      )
    ).rejects.toBeInstanceOf(GrantBrokerError);
    expect(await broker.holder("victim")).toBeUndefined();
    expect(await broker.claim("victim", "victim-exec")).toBe(true);
  });

  it("(F1) a flow cannot forge lease.w.reserved to launder a raw spawn", async () => {
    const parent: Parent = async (ctx) => {
      let refused = false;
      try {
        ctx.emit("RESOURCE_METERED", { custom: { "lease.w.reserved": 10 } });
      } catch {
        refused = true;
      }
      const out = await raw(10)(ctx);
      return { refused, out };
    };
    const { h } = await runParent(parent);
    const done = (await finished(h.runtime, PARENT)).variables._output as { refused: boolean };
    expect(done.refused).toBe(true);
    expect(String(h.errors[0])).toMatch(/reserved in its fold/);
    expect(h.ran.n).toBeLessThanOrEqual(10);
    expect((await custom(h.runtime, PARENT))["lease.w.reserved"]).toBeUndefined();
  });

  it("(F2) a flow cannot forge lease.w.returned to buy back its own lease", async () => {
    const parent: Parent = async (ctx) => {
      let refused = false;
      try {
        ctx.emit("RESOURCE_METERED", { custom: { "lease.w.returned": 40 } });
      } catch {
        refused = true;
      }
      return { refused, own: (await acts(ctx, "a", 50)).ran };
    };
    const { h } = await runParent(parent);
    const done = (await finished(h.runtime, PARENT)).variables._output as { refused: boolean };
    expect(done.refused).toBe(true);
    expect(h.ran.n).toBe(10);
  });

  it("(F3) a child flow cannot forge returned either: its emit is refused and it fails", async () => {
    const parent: Parent = async (ctx) => {
      const res = await reserveChildLease(ctx, "k", { w: 6 });
      try {
        await awaitChild(ctx, {
          key: "k",
          flowId: "child",
          input: { n: 1, forge: true },
          ...res.spawn,
        });
      } catch (e) {
        if (e instanceof SuspendError) throw e;
        return { failed: true, own: (await acts(ctx, "a", 10)).ran };
      }
      return { failed: false };
    };
    const { h } = await runParent(parent);
    const done = (await finished(h.runtime, PARENT)).variables._output as { failed: boolean };
    expect(done.failed).toBe(true);
    expect(h.ran.n).toBeLessThanOrEqual(10);
    expect(await custom(h.runtime, CHILD)).toEqual({});
  });

  it("settleChild clamps what it records to [0, high]", async () => {
    const broker = mk();
    await root(broker);
    await broker.claim(PARENT, PARENT);
    const m = childGrantMinter(broker, { ttlMs: 60_000, now: () => NOW });
    for (const [id, spend, want] of [
      ["P::neg", -50, 4],
      ["P::big", 999, 0],
    ] as const) {
      await m.mintChildGrant(
        { executionId: PARENT, taskId: PARENT, resources: { "lease.w.reserved": 8 } },
        { childId: id, lease: { w: 4 } }
      );
      await m.settleChild(id, { "lease.w": spend });
      expect(await broker.takeReturn(id, PARENT)).toEqual({ w: want });
    }
  });

  it("installTaskAuthority refuses a host without reserveEffectDimensions, and reserves lease. otherwise", () => {
    const codecs: unknown[] = [];
    const bare = { composePrincipalCodec: (c: unknown) => codecs.push(c) };
    const opts = { source: mk(), secret: SECRET };
    expect(() => installTaskAuthority(bare, opts)).toThrow(/reserveEffectDimensions/);
    expect(codecs).toEqual([]);
    const reserved: string[] = [];
    installTaskAuthority(
      { ...bare, reserveEffectDimensions: (p: string) => reserved.push(p) },
      opts
    );
    expect(reserved).toEqual(["lease."]);
  });

  it("(e) a failed child returns nothing", async () => {
    const { h } = await runParent(std({ lease: 6, childActs: 2, childFails: true, after: 6 }));
    const out = await output(h.runtime, PARENT);
    expect(out.err).toBeDefined();
    expect(out.ownRan).toBe(4); // the child may have spent all 6: none comes back
    expect((await custom(h.runtime, PARENT))["lease.w.returned"]).toBeUndefined();
    expect(h.ran.n).toBeLessThanOrEqual(10);
  });

  it("(f) a spawn with a lease and no taskAuthority hook fails closed", async () => {
    const { h } = await runParent(raw(6, undefined, 0), { noMinter: true });
    await output(h.runtime, PARENT);
    expect(await h.runtime.loadState(CHILD)).toBeNull(); // the unbounded child never started
    expect(String(h.errors[0])).toMatch(/taskAuthority is not configured/);
  });

  it("(g) a parent short of lease gets a renewable LeaseExhaustedError; under withRenewal it parks", async () => {
    const plain = await runParent(std({ lease: 11, childActs: 1 }));
    const out = await output(plain.h.runtime, PARENT);
    expect(out.err).toBe("LeaseExhaustedError");
    expect(await custom(plain.h.runtime, PARENT)).toEqual({});
    expect(new LeaseExhaustedError("w", 10, 0, 0).renewable).toBe(true);

    const renew: Parent = async (ctx) => {
      await withRenewal(ctx, "rsv", (attempt) =>
        reserveChildLease(ctx, "k", { w: 11 }, { attempt })
      );
      return {};
    };
    const parked = await runParent(renew);
    await until(
      async () => (await parked.h.runtime.loadState(PARENT))?.suspendedOn?.on === RENEWAL_GATE,
      "the park"
    );
    expect(await custom(parked.h.runtime, PARENT)).toEqual({});
  });
});

// R33 (T15): a child that never starts returns its WHOLE reservation, exactly once.
describe("never-started child (R33)", () => {
  const refuseMint = (real: ChildGrantMinter): ChildGrantMinter => ({
    ...real,
    settleUnstarted: (c, p) => real.settleUnstarted?.(c, p) as Promise<void>,
    mintChildGrant: async () => {
      throw new GrantBrokerError("refused by the minter");
    },
  });
  const takesBack: Parent = async (ctx) => {
    const res = await reserveChildLease(ctx, "k", { w: 6 });
    let err: string | undefined;
    try {
      await awaitChild(ctx, { key: "k", flowId: "child", input: { n: 6 }, ...res.spawn });
    } catch (e) {
      if (e instanceof SuspendError) throw e;
      err = (e as Error).name;
    }
    await res.settle();
    return { err, ownRan: (await acts(ctx, "a", 10)).ran };
  };

  it("a mint refused after a fold-allowed reservation: the parent takes the whole 6 back once", async () => {
    const { h, broker } = await runParent(takesBack, { wrapMint: refuseMint });
    const out = await output(h.runtime, PARENT);
    expect(out.err).toBeDefined();
    expect(await h.runtime.loadState(CHILD)).toBeNull();
    expect(out.ownRan).toBe(10); // before R33: 4 (the 6 was lost for good)
    expect(h.ran.n).toBe(10); // the total stays at the ceiling
    expect((await custom(h.runtime, PARENT))["lease.w.returned"]).toBe(6);
    expect(await broker.takeReturn(CHILD, PARENT)).toEqual({}); // a second take pays nothing
  });

  it("a second return step for the same child meters nothing more", async () => {
    const twice: Parent = async (ctx) => {
      const res = await reserveChildLease(ctx, "k", { w: 6 });
      await awaitChild(ctx, { key: "k", flowId: "child", input: { n: 6 }, ...res.spawn }).catch(
        (e) => {
          if (e instanceof SuspendError) throw e;
        }
      );
      await res.settle();
      await ctx.run(
        { ...(task("again") as object), toolId: CHILD_LEASE_TOOL } as never,
        { op: "return", child: CHILD } as never
      );
      return { ownRan: (await acts(ctx, "a", 20)).ran };
    };
    const { h } = await runParent(twice, { wrapMint: refuseMint });
    expect((await output(h.runtime, PARENT)).ownRan).toBe(10);
    expect((await custom(h.runtime, PARENT))["lease.w.returned"]).toBe(6);
  });

  it("a crash around settleUnstarted: recovery returns the reservation once, never twice", async () => {
    for (const when of ["before", "after"] as const) {
      const w = world();
      const broker = mk();
      const g = await root(broker);
      const hang: BootOpts = {
        wrapMint: (real) => ({
          ...refuseMint(real),
          settleUnstarted: async (c, p) => {
            if (when === "after") await real.settleUnstarted?.(c, p);
            return new Promise<never>(() => {}); // "crash" before the parent is resumed
          },
        }),
      };
      const a = boot(w, broker, takesBack, hang);
      await a.runtime.start(a.parentFlow, {}, { executionId: PARENT, principal: chain(g) });
      await until(async () => (await a.runtime.loadState(PARENT))?.status === "suspended", "park");
      await new Promise((r) => setTimeout(r, 50));
      const b = boot(w, broker, takesBack, { wrapMint: refuseMint });
      await b.sup.recover();
      const out = await output(b.runtime, PARENT);
      expect(out.ownRan).toBe(10);
      expect(a.ran.n + b.ran.n).toBe(10);
      expect((await custom(b.runtime, PARENT))["lease.w.returned"]).toBe(6);
    }
  }, 30_000);

  it("I1 (R36): after the whole reservation is returned an UNRESERVED child cannot be carved on top of it", async () => {
    const refuseFirst = (real: ChildGrantMinter): ChildGrantMinter => ({
      ...real,
      mintChildGrant: (p, spec) =>
        spec.childId === CHILD
          ? Promise.reject(new GrantBrokerError("refused by the minter"))
          : real.mintChildGrant(p, spec),
    });
    const parent: Parent = async (ctx) => {
      const res = await reserveChildLease(ctx, "k", { w: 10 });
      await awaitChild(ctx, { key: "k", flowId: "child", input: { n: 10 }, ...res.spawn }).catch(
        (e) => {
          if (e instanceof SuspendError) throw e;
        }
      );
      await res.settle(); // returned 10: the parent's fold shows 10 available again
      // an UNRESERVED child: lease and leaseParent come from the flow, no reserve step, so no record
      const v = await awaitChild(ctx, {
        key: "v",
        flowId: "child",
        input: { n: 10 },
        lease: { w: 10 },
        leaseParent: PARENT,
      }).catch((e) => {
        if (e instanceof SuspendError) throw e;
        return (e as Error).name;
      });
      return { v, ownRan: (await acts(ctx, "a", 10)).ran };
    };
    const { h } = await runParent(parent, { wrapMint: refuseFirst });
    await output(h.runtime, PARENT);
    expect(await h.runtime.loadState("P::v")).toBeNull(); // never minted, never ran
    expect(h.ran.n).toBeLessThanOrEqual(10); // before R36 the child alone could spend 10 on top of the parent's 10
    expect(String(h.errors.at(-1))).toMatch(/reserved in its fold/);
  });

  it("I3: a flow cannot reserve under another execution's child id; nothing is metered", async () => {
    const parent: Parent = async (ctx) => {
      const err = await ctx
        .run(
          { ...(task("sq") as object), toolId: CHILD_LEASE_TOOL } as never,
          {
            op: "reserve",
            lease: { w: 3 },
            child: "Q::k",
          } as never
        )
        .then(
          () => undefined,
          (e) => (e as Error).message
        );
      return { ownRan: 0, err };
    };
    const { h } = await runParent(parent);
    const out = await output(h.runtime, PARENT);
    expect(out.err).toMatch(/child of this execution/);
    expect(await custom(h.runtime, PARENT)).toEqual({});
  });

  it("a child is EITHER started OR unstarted: the broker keeps the first, the other changes nothing", async () => {
    const m = (b: InMemoryGrantBroker, id: string, c: number) =>
      b.mint({
        taskId: id,
        issuedTo: id,
        effects: ["act"],
        leases: { w: { ceiling: c, effects: ["act"] } },
        ttlMs: 60_000,
        parent: { taskId: PARENT },
      });
    const b = mk();
    await root(b);
    // settleChild first (a started child): a later settleUnstarted adds nothing
    await b.reserve(PARENT, "s", { w: 6 });
    await m(b, "s", 6);
    await b.claim("s", "e");
    await b.settleChild("s", { w: 2 });
    await b.settleUnstarted("s", PARENT);
    expect(await b.takeReturn("s", PARENT)).toEqual({ w: 4 });
    expect(await b.takeReturn("s", PARENT)).toEqual({});
    // settleUnstarted first (minted, never claimed): revoked, whole take once, a later settleChild adds nothing
    await b.reserve(PARENT, "u", { w: 4 });
    await m(b, "u", 4);
    await b.settleUnstarted("u", PARENT);
    await b.settleChild("u", { w: 0 });
    expect(await b.current("u")).toBeUndefined(); // it can never start
    expect(await b.takeReturn("u", PARENT)).toEqual({ w: 4 });
    expect(await b.takeReturn("u", PARENT)).toEqual({});
    // the released high-water lets the parent carve again: 10 - 6 (s) = 4 is free
    await b.reserve(PARENT, "v", { w: 4 });
    await m(b, "v", 4);
    // reserve is idempotent and refuses a conflicting record
    await b.reserve(PARENT, "v", { w: 4 });
    await expect(b.reserve(PARENT, "v", { w: 3 })).rejects.toThrow(/different reservation/);
    await expect(b.reserve("nope", "x", { w: 1 })).rejects.toThrow(/unknown or revoked/);
  });
});

describe("spawn-time reads narrowing (ADR 0150 D8)", () => {
  const rootReads = (b: InMemoryGrantBroker, reads: string[]): Promise<TaskGrant> =>
    b.mint({
      taskId: PARENT,
      issuedTo: PARENT,
      effects: ["act", "rd", CHILD_LEASE_TOOL],
      leases: { w: { ceiling: 10, effects: ["act", "rd"] } },
      ttlMs: 60_000,
      reads,
    });
  const spawnReads =
    (reads?: string[]): Parent =>
    async (ctx) => {
      const res = await reserveChildLease(ctx, "k", { w: 2 });
      return awaitChild(ctx, {
        key: "k",
        flowId: "child",
        input: { n: 0, reads: ["a/x", "b/y"] },
        ...res.spawn,
        ...(reads !== undefined && { reads }),
      });
    };
  async function go(reads: string[] | undefined) {
    const w = world();
    const broker = mk();
    const g = await rootReads(broker, ["rd:a/*", "rd:b/*"]);
    const h = boot(w, broker, spawnReads(reads), { authorize: true });
    await h.runtime.start(h.parentFlow, {}, { executionId: PARENT, principal: chain(g) });
    return { out: (await finished(h.runtime, PARENT)).variables._output, broker, h };
  }

  // kills: a spawn that drops `reads` (the child inherits everything), or one that grants the child other namespaces
  it("a child narrowed at spawn reads its namespace and is refused the parent's other one", async () => {
    const { out, broker } = await go(["rd:a/*"]);
    expect(out).toEqual({ "a/x": true, "b/y": false });
    expect((await broker.current(CHILD))?.reads).toEqual(["rd:a/*"]);
  }, 20_000);

  // kills: narrowing that becomes the default (inheritance must stay the default)
  it("without `reads` on the spawn the child inherits the parent's reads", async () => {
    const { out, broker } = await go(undefined);
    expect(out).toEqual({ "a/x": true, "b/y": true });
    expect((await broker.current(CHILD))?.reads).toEqual(["rd:a/*", "rd:b/*"]);
  }, 20_000);

  // kills: a minter that trusts the spawn's `reads` without the broker's subset check
  it("a spawn that WIDENS the parent's reads is refused by the broker; no child runs", async () => {
    const w = world();
    const broker = mk();
    const g = await rootReads(broker, ["rd:a/*"]);
    const h = boot(w, broker, spawnReads(["rd:*"]), { authorize: true });
    await h.runtime.start(h.parentFlow, {}, { executionId: PARENT, principal: chain(g) });
    await finished(h.runtime, PARENT).catch(() => undefined);
    expect(await broker.current(CHILD)).toBeUndefined();
    expect(await h.runtime.loadState(CHILD)).toBeNull();
  }, 20_000);

  const GCHILD = "P::g#0";
  const groupSpawn =
    (member: { reads?: string[]; lease?: boolean }): Parent =>
    async (ctx) => {
      try {
        const res = await reserveChildLease(ctx, "g", { w: 2 });
        return await awaitChildren(ctx, {
          key: "g",
          children: [
            {
              flowId: "child",
              input: { n: 0, reads: ["a/x", "b/y"] },
              ...(member.lease !== false && res.spawn),
              ...(member.reads !== undefined && { reads: member.reads }),
            },
          ],
        });
      } catch (e) {
        if (e instanceof SuspendError) throw e;
        return { err: (e as Error).message };
      }
    };

  // kills: a group member whose `reads` is dropped between awaitChildren and the mint
  it("a group member narrowed at spawn reads its namespace only", async () => {
    const w = world();
    const broker = mk();
    const g = await rootReads(broker, ["rd:a/*", "rd:b/*"]);
    const h = boot(w, broker, groupSpawn({ reads: ["rd:a/*"] }), { authorize: true });
    await h.runtime.start(h.parentFlow, {}, { executionId: PARENT, principal: chain(g) });
    await finished(h.runtime, PARENT);
    expect((await broker.current(GCHILD))?.reads).toEqual(["rd:a/*"]);
    expect(JSON.stringify((await finished(h.runtime, GCHILD)).variables._output)).toBe(
      '{"a/x":true,"b/y":false}'
    );
  }, 20_000);

  // kills: `reads` without a lease being silently ignored (the child would run grantless with unbounded reads)
  for (const kind of ["single", "group member"] as const) {
    it(`reads without a lease is refused for a ${kind}; no child starts`, async () => {
      const w = world();
      const broker = mk();
      const g = await rootReads(broker, ["rd:a/*"]);
      const parent: Parent =
        kind === "single"
          ? async (ctx) => {
              try {
                return await awaitChild(ctx, {
                  key: "k",
                  flowId: "child",
                  input: { n: 0 },
                  reads: ["rd:a/*"],
                });
              } catch (e) {
                if (e instanceof SuspendError) throw e;
                return { err: (e as Error).message };
              }
            }
          : groupSpawn({ reads: ["rd:a/*"], lease: false });
      const h = boot(w, broker, parent, { authorize: true });
      await h.runtime.start(h.parentFlow, {}, { executionId: PARENT, principal: chain(g) });
      const out = (await finished(h.runtime, PARENT)).variables._output as { err?: string };
      expect(out.err).toMatch(/names `reads` but no `lease`/);
      expect(await h.runtime.loadState(kind === "single" ? CHILD : GCHILD)).toBeNull();
    }, 20_000);
  }
});
