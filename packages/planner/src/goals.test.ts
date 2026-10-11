import { resolve } from "node:path";
import { createAgentModelEffect } from "@loom/agent";
import { CapabilityCatalog, capability$ } from "@loom/capability";
import { flow$, handler$, step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { CapabilityDeniedError, EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider } from "@loom/llm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { ExecutionContext, FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  goalEffects,
  goalsClient,
  ownerOfPrincipal,
  registerGoalEffects,
  runGoal,
} from "./goalEffects";
import {
  DurableGoalStore,
  GoalAccessDeniedError,
  GoalConflictError,
  GoalNotFoundError,
  GoalTransitionError,
  InMemoryGoalStore,
} from "./goals";
import type { GoalKvStore, GoalStore } from "./goals";
import { effectPlanModel } from "./planGoal";

class RevisionConflictError extends Error {
  override name = "RevisionConflictError";
}
/** A CAS kv with the DurableStateStore contract (and an injectable lost race). */
function kv(): GoalKvStore & {
  raceOnce: () => void;
  data: Map<string, { revision: number; payload: unknown }>;
} {
  const data = new Map<string, { revision: number; payload: unknown }>();
  let race = false;
  return {
    data,
    raceOnce: () => {
      race = true;
    },
    async load(key) {
      const r = data.get(key);
      return r === undefined ? null : structuredClone(r);
    },
    async save(key, value, expected) {
      const cur = data.get(key)?.revision ?? 0;
      if (race) {
        race = false;
        data.set(key, {
          revision: cur + 1,
          payload: data.get(key)?.payload ?? { seq: 0, goals: [] },
        });
        throw new RevisionConflictError("lost");
      }
      if (cur !== expected) throw new RevisionConflictError("stale");
      data.set(key, { revision: cur + 1, payload: structuredClone(value.payload) });
      return { revision: cur + 1 };
    },
  };
}

const stores: Array<[string, () => GoalStore]> = [
  ["InMemoryGoalStore", () => new InMemoryGoalStore()],
  ["DurableGoalStore", () => new DurableGoalStore(kv())],
];

describe.each(stores)("%s (R16)", (_n, make) => {
  it("creates, lists in creation order, and gets", async () => {
    const s = make();
    await s.create("alice", { id: "g1", title: "ship" });
    await s.create("alice", { id: "g2", title: "test", parentId: "g1" });
    expect((await s.list("alice")).map((g) => g.id)).toEqual(["g1", "g2"]);
    expect((await s.list("alice", { parentId: null })).map((g) => g.id)).toEqual(["g1"]);
    expect((await s.list("alice", { parentId: "g1" })).map((g) => g.id)).toEqual(["g2"]);
    expect((await s.get("alice", "g2")).parentId).toBe("g1");
  });

  it("another owner cannot see, read, change or parent onto a goal (and cannot tell it exists)", async () => {
    const s = make();
    await s.create("alice", { id: "g1", title: "secret plan" });
    await expect(s.get("bob", "g1")).rejects.toThrow(GoalNotFoundError);
    await expect(s.setStatus("bob", { id: "g1", status: "active" })).rejects.toThrow(
      GoalNotFoundError
    );
    await expect(s.create("bob", { id: "x", title: "t", parentId: "g1" })).rejects.toThrow(
      GoalNotFoundError
    );
    expect(await s.list("bob")).toEqual([]);
    expect((await s.get("alice", "g1")).status).toBe("open");
    // Bob may reuse the id in his own namespace.
    await s.create("bob", { id: "g1", title: "mine" });
    expect((await s.get("alice", "g1")).title).toBe("secret plan");
  });

  it("enforces the status machine and compare-and-set", async () => {
    const s = make();
    const g = await s.create("a", { id: "g", title: "t" });
    await expect(
      s.setStatus("a", { id: "g", status: "active", expectedRevision: 99 })
    ).rejects.toThrow(GoalConflictError);
    const act = await s.setStatus("a", { id: "g", status: "active", expectedRevision: g.revision });
    expect(act.revision).toBe(g.revision + 1);
    await s.setStatus("a", { id: "g", status: "done" });
    await expect(s.setStatus("a", { id: "g", status: "active" })).rejects.toThrow(
      GoalTransitionError
    );
    expect((await s.get("a", "g")).status).toBe("done");
  });

  it("refuses a bad id, a duplicate, an oversized title, an empty owner and a too-deep tree", async () => {
    const s = make();
    await expect(s.create("a", { id: "__proto__", title: "t" })).rejects.toThrow(GoalConflictError);
    await s.create("a", { id: "g", title: "t" });
    await expect(s.create("a", { id: "g", title: "t" })).rejects.toThrow(GoalConflictError);
    await expect(s.create("a", { id: "h", title: "x".repeat(501) })).rejects.toThrow();
    await expect(s.create("", { id: "h", title: "t" })).rejects.toThrow(GoalAccessDeniedError);
    let parent = "g";
    for (let i = 0; i < 7; i++) {
      await s.create("a", { id: `d${i}`, title: "t", parentId: parent });
      parent = `d${i}`;
    }
    await expect(s.create("a", { id: "deep", title: "t", parentId: parent })).rejects.toThrow(
      /deeply/
    );
  });

  it("rolls a parent up from its children, through ancestors", async () => {
    const s = make();
    await s.create("a", { id: "root", title: "r" });
    await s.create("a", { id: "mid", title: "m", parentId: "root" });
    await s.create("a", { id: "l1", title: "1", parentId: "mid" });
    await s.create("a", { id: "l2", title: "2", parentId: "mid" });
    await s.setStatus("a", { id: "l1", status: "active" });
    expect((await s.rollup("a", "l1")).status).toBe("active");
    expect((await s.get("a", "root")).status).toBe("active");
    await s.setStatus("a", { id: "l1", status: "done" });
    await s.setStatus("a", { id: "l2", status: "done" });
    await s.rollup("a", "l2");
    expect((await s.get("a", "mid")).status).toBe("done");
    expect((await s.get("a", "root")).status).toBe("done");
  });

  it("a child failure with no live siblings fails the parent; abandoned children are ignored", async () => {
    const s = make();
    await s.create("a", { id: "p", title: "p" });
    await s.create("a", { id: "c1", title: "1", parentId: "p" });
    await s.create("a", { id: "c2", title: "2", parentId: "p" });
    await s.setStatus("a", { id: "c2", status: "abandoned" });
    await s.setStatus("a", { id: "c1", status: "failed" });
    await s.rollup("a", "c1");
    expect((await s.get("a", "p")).status).toBe("failed");
  });
});

describe("DurableGoalStore specifics (R16)", () => {
  it("retries a lost compare-and-set race and keeps both writes", async () => {
    const k = kv();
    const s = new DurableGoalStore(k);
    await s.create("a", { id: "g1", title: "t" });
    k.raceOnce();
    await s.create("a", { id: "g2", title: "t" });
    expect((await s.list("a")).map((g) => g.id)).toEqual(["g1", "g2"]);
  });

  it("refuses a stored document that names a different owner (a tampered or mis-keyed record)", async () => {
    const k = kv();
    const s = new DurableGoalStore(k);
    await s.create("alice", { id: "g1", title: "t" });
    const key = [...k.data.keys()][0] as string;
    const rec = k.data.get(key) as { payload: { goals: Array<{ owner: string }> } };
    rec.payload.goals[0]!.owner = "mallory";
    await expect(s.get("alice", "g1")).rejects.toThrow(GoalAccessDeniedError);
  });

  it("never lets an owner string address another owner's key", async () => {
    const k = kv();
    const s = new DurableGoalStore(k);
    await s.create("a/../b", { id: "g1", title: "t" });
    await s.create("b", { id: "g1", title: "t2" });
    expect([...k.data.keys()].sort()).toEqual(["loom.goals/a%2F..%2Fb", "loom.goals/b"]);
  });
});

describe("ownerOfPrincipal", () => {
  it("fails closed without an actor or with an unresolved delegation", () => {
    expect(() => ownerOfPrincipal(undefined)).toThrow(GoalAccessDeniedError);
    expect(() => ownerOfPrincipal({ tenant: "t" })).toThrow(GoalAccessDeniedError);
    expect(() => ownerOfPrincipal({ actor: "a", delegationUnresolved: "d" })).toThrow(
      GoalAccessDeniedError
    );
    expect(ownerOfPrincipal({ actor: "a", tenant: "t" })).not.toBe(
      ownerOfPrincipal({ actor: "a" })
    );
  });
});

// ── through a runtime: the owner is the principal, nothing in any input can change it ─────────────

const noop = step$({
  id: "noop",
  name: "n",
  inputSchema: z.any(),
  outputSchema: z.any(),
  handler: handler$(async () => ({})),
});
const cat = new CapabilityCatalog().register(
  capability$({
    id: "work",
    intent: "do work",
    tags: [],
    inputSchema: z.object({ n: z.number().optional() }),
    flow: {
      definition: flow$({
        id: "work",
        name: "w",
        version: "1.0.0",
        inputSchema: z.any(),
        outputSchema: z.any(),
        steps: [noop],
      }),
      runner: ((c: ExecutionContext, i: unknown) => c.run(noop, i)) as FlowRunner<unknown, unknown>,
    },
  })
);
const FLOW: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "goal-flow",
  name: "g",
  version: "1.0.0",
  inputSchema: z.any(),
  outputSchema: z.any(),
  steps: [],
};

function boot(store: GoalStore, reply: string) {
  let modelCalls = 0;
  let work = 0;
  const provider: LlmProvider = {
    async complete() {
      modelCalls++;
      return { content: reply, stopReason: "end_turn" };
    },
  };
  const effects = new EffectRuntime();
  effects.register("plan-model", createAgentModelEffect(provider));
  effects.register("work", new ToolEffect(async () => ({ done: ++work })));
  registerGoalEffects(effects, store);
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  return { runtime, calls: () => ({ modelCalls, work }) };
}

describe("goal effects + runGoal (R16)", () => {
  it("creates and pursues a goal as the principal; status follows the outcome; a replay repeats nothing", async () => {
    const store = new InMemoryGoalStore();
    const b = boot(
      store,
      JSON.stringify({ nodes: [{ id: "w1", capabilityId: "work", args: { n: 1 } }] })
    );
    let result: unknown;
    const runner: FlowRunner<unknown, unknown> = async (ctx) => {
      const goals = goalsClient(ctx);
      await goals.create({ id: "g1", title: "get the work done" });
      result = await runGoal(ctx, goals, "g1", {
        catalog: cat,
        plan: { model: effectPlanModel("plan-model") },
      });
      await ctx.suspend({ on: "go" });
      return {};
    };
    b.runtime.registerFlow(FLOW, runner);
    const h = await b.runtime.start(FLOW, {}, { principal: { actor: "alice", tenant: "t1" } });
    await h.waitForSuspend();
    const first = JSON.stringify(result);
    expect((result as { goal: { status: string } }).goal.status).toBe("done");
    expect(b.calls()).toEqual({ modelCalls: 1, work: 1 });
    const owner = ownerOfPrincipal({ actor: "alice", tenant: "t1" });
    expect((await store.get(owner, "g1")).lastRun).toEqual({ status: "completed", replans: 0 });
    // Another principal has no such goal.
    await expect(store.get(ownerOfPrincipal({ actor: "bob", tenant: "t1" }), "g1")).rejects.toThrow(
      GoalNotFoundError
    );

    result = undefined;
    const r = await b.runtime.resume(h.executionId, { eventType: "go", payload: {} });
    await r.waitForCompletion();
    expect(JSON.stringify(result)).toBe(first);
    expect(b.calls()).toEqual({ modelCalls: 1, work: 1 });
    expect((await store.list(owner)).length).toBe(1);
  });

  it("an execution with no principal cannot touch the goal store", async () => {
    const store = new InMemoryGoalStore();
    const b = boot(store, "{}");
    let err: unknown;
    const runner: FlowRunner<unknown, unknown> = async (ctx) => {
      try {
        await goalsClient(ctx).create({ id: "g", title: "t" });
      } catch (e) {
        err = e;
      }
      return {};
    };
    b.runtime.registerFlow(FLOW, runner);
    const h = await b.runtime.start(FLOW, {});
    await h.waitForCompletion();
    expect(String(err)).toMatch(/principal/);
  });

  it("a planning failure marks the goal failed and re-throws", async () => {
    const store = new InMemoryGoalStore();
    const b = boot(store, "not a plan");
    let err: unknown;
    const runner: FlowRunner<unknown, unknown> = async (ctx) => {
      const goals = goalsClient(ctx);
      await goals.create({ id: "g1", title: "t" });
      try {
        await runGoal(ctx, goals, "g1", {
          catalog: cat,
          plan: { model: effectPlanModel("plan-model") },
        });
      } catch (e) {
        err = e;
      }
      return {};
    };
    b.runtime.registerFlow(FLOW, runner);
    const h = await b.runtime.start(FLOW, {}, { principal: { actor: "alice" } });
    await h.waitForCompletion();
    expect((err as Error).name).toBe("PlanFailedError");
    const g = await store.get(ownerOfPrincipal({ actor: "alice" }), "g1");
    expect(g.status).toBe("failed");
    expect(g.note).toContain("planning failed");
  });
});

describe("fix round 1 - goals (R16)", () => {
  it("P1: a delegate acting onBehalfOf u1 and one acting onBehalfOf u2 are different owners", () => {
    const a = ownerOfPrincipal({ actor: "assistant", onBehalfOf: "u1" });
    const b = ownerOfPrincipal({ actor: "assistant", onBehalfOf: "u2" });
    const none = ownerOfPrincipal({ actor: "assistant" });
    expect(new Set([a, b, none]).size).toBe(3);
  });

  it("P1: the goal owner key is the conversation identity key (one definition)", async () => {
    // A computed specifier: planner does not depend on @loom/conversation (and its source sits outside
    // this package's rootDir), but the two owner keys must stay ONE definition.
    const conversationAccess = resolve(__dirname, "../../conversation/src/access");
    const { identityKey } = (await import(conversationAccess)) as {
      identityKey: (i: { tenant?: string; actor?: string; onBehalfOf?: string }) => string;
    };
    const p = { tenant: "t", actor: "assistant", onBehalfOf: "u1" };
    expect(ownerOfPrincipal(p)).toBe(
      identityKey({ tenant: "t", actor: "assistant", onBehalfOf: "u1" })
    );
  });

  it("P1: shredded and unresolved principals have no owner", () => {
    expect(() => ownerOfPrincipal({ actor: "a", principalShredded: true })).toThrow(
      GoalAccessDeniedError
    );
    expect(() => ownerOfPrincipal({ actor: "a", principalUnresolved: "ref" })).toThrow(
      GoalAccessDeniedError
    );
  });

  it("P1 (through the effects): a goal made as onBehalfOf u1 is invisible to onBehalfOf u2", async () => {
    const store = new InMemoryGoalStore();
    const fx = goalEffects(store);
    const ctxFor = (onBehalfOf: string) =>
      ({
        principal: { actor: "assistant", onBehalfOf },
        executionId: "e",
        stepId: "s",
        workflowId: "w",
        attempt: 1,
        emit() {},
      }) as never;
    await fx["goals.create"]?.execute({ id: "g", title: "t" }, ctxFor("u1"));
    expect(await fx["goals.list"]?.execute({}, ctxFor("u1"))).toHaveLength(1);
    expect(await fx["goals.list"]?.execute({}, ctxFor("u2"))).toEqual([]);
    await expect(
      fx["goals.setStatus"]?.execute({ id: "g", status: "active" }, ctxFor("u2"))
    ).rejects.toThrow(GoalNotFoundError);
  });

  it("P3: reading never creates an owner document (InMemory)", async () => {
    const s = new InMemoryGoalStore();
    await s.list("ghost");
    await expect(s.get("ghost", "g")).rejects.toThrow(GoalNotFoundError);
    expect((s as unknown as { docs: Map<string, unknown> }).docs.size).toBe(0);
  });

  it("P3: setStatus.lastRun is validated (shape and size)", async () => {
    for (const s of [new InMemoryGoalStore(), new DurableGoalStore(kv())]) {
      await s.create("a", { id: "g", title: "t" });
      for (const bad of [
        { status: "nope", replans: 0 },
        { status: "failed", replans: -1 },
        { status: "failed", replans: 1.5 },
        { status: "failed", replans: 0, error: "x".repeat(400) },
        { status: "failed", replans: 0, extra: "x" },
        "string",
      ]) {
        await expect(
          s.setStatus("a", { id: "g", status: "active", lastRun: bad as never })
        ).rejects.toThrow(/lastRun/);
      }
      expect((await s.get("a", "g")).status).toBe("open");
      await s.setStatus("a", {
        id: "g",
        status: "active",
        lastRun: { status: "failed", replans: 2, error: "e" },
      });
    }
  });

  it("P3: a write re-driven with the same idempotencyKey is applied once", async () => {
    for (const s of [new InMemoryGoalStore(), new DurableGoalStore(kv())]) {
      const a = await s.create("a", { id: "g", title: "t" }, { idempotencyKey: "k1" });
      const again = await s.create("a", { id: "g", title: "t" }, { idempotencyKey: "k1" });
      expect(again).toEqual(a);
      const st = await s.setStatus("a", { id: "g", status: "active" }, { idempotencyKey: "k2" });
      const st2 = await s.setStatus("a", { id: "g", status: "active" }, { idempotencyKey: "k2" });
      expect(st2).toEqual(st);
      expect((await s.get("a", "g")).revision).toBe(2);
      // without a key the duplicate is still a conflict
      await expect(s.create("a", { id: "g", title: "t" })).rejects.toThrow(GoalConflictError);
    }
  });

  it("survivor: at most 1000 goals per owner", async () => {
    for (const s of [new InMemoryGoalStore(), new DurableGoalStore(kv())]) {
      for (let i = 0; i < 1000; i++) await s.create("a", { id: `g${i}`, title: "t" });
      await expect(s.create("a", { id: "one-more", title: "t" })).rejects.toThrow(/more than 1000/);
      await s.create("b", { id: "ok", title: "t" }); // another owner is unaffected
    }
  }, 60_000);

  it("the goal effects are declared idempotent (a crash mid-write is re-driven, not parked in-doubt)", () => {
    const fx = goalEffects(new InMemoryGoalStore());
    for (const id of ["goals.create", "goals.setStatus", "goals.rollup"] as const) {
      expect((fx[id] as { idempotent?: boolean }).idempotent).toBe(true);
    }
  });
});

describe("fix round 1 - runGoal / goalsClient through a runtime (R16)", () => {
  const sink = (id: string, v: number) => ({ id, capabilityId: "work", args: { n: v } });
  const run = async (
    store: GoalStore,
    replies: string[],
    body: (
      ctx: ExecutionContext,
      deps: { goals: ReturnType<typeof goalsClient> }
    ) => Promise<unknown>,
    opts: { work?: () => unknown; principal?: object } = {}
  ) => {
    let i = 0;
    let out: unknown;
    let err: unknown;
    const provider: LlmProvider = {
      async complete() {
        return {
          content: replies[Math.min(i++, replies.length - 1)] ?? "",
          stopReason: "end_turn",
        };
      },
    };
    const effects = new EffectRuntime();
    effects.register("plan-model", createAgentModelEffect(provider));
    effects.register("work", new ToolEffect(async () => (opts.work ?? (() => ({ ok: 1 })))()));
    registerGoalEffects(effects, store);
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
    });
    const runner: FlowRunner<unknown, unknown> = async (ctx) => {
      try {
        out = await body(ctx, { goals: goalsClient(ctx) });
      } catch (e) {
        err = e;
      }
      return {};
    };
    runtime.registerFlow(FLOW, runner);
    const h = await runtime.start(
      FLOW,
      {},
      { principal: (opts.principal ?? { actor: "alice" }) as never }
    );
    await h.waitForCompletion();
    return {
      out: out as never,
      err,
      owner: ownerOfPrincipal((opts.principal ?? { actor: "alice" }) as never),
    };
  };
  const cfg = { catalog: cat, plan: { model: effectPlanModel("plan-model") } };
  const plan1 = JSON.stringify({ nodes: [sink("w1", 1)] });

  it("P2-3: two goalsClient instances on one prefix are refused (no silently lost write)", async () => {
    const store = new InMemoryGoalStore();
    const r = await run(store, [plan1], async (ctx, { goals }) => {
      await goals.create({ id: "g1", title: "t" });
      goalsClient(ctx); // a second client on the default prefix
      return "unreachable";
    });
    expect((r.err as Error).name).toBe("IdReusedError");
    // A distinct prefix is fine and writes both.
    const r2 = await run(new InMemoryGoalStore(), [plan1], async (ctx, { goals }) => {
      const other = goalsClient(ctx, { prefix: "goals2" });
      await goals.create({ id: "a", title: "t" });
      await other.create({ id: "b", title: "t" });
      return (await goals.list()).map((g) => g.id) as never;
    });
    expect(r2.out).toEqual(["a", "b"]);
  });

  it("P2-2: two runGoal calls with replanning in one execution each adopt their own revision", async () => {
    const store = new InMemoryGoalStore();
    let n = 0;
    const flaky = JSON.stringify({
      nodes: [{ id: "bad", capabilityId: "flaky", args: { key: "k" } }],
    });
    const fix = (v: number) => JSON.stringify({ nodes: [sink(`fix${v}`, v)] });
    const c2 = new CapabilityCatalog();
    for (const c of cat.all()) c2.register(c);
    c2.register(
      capability$({
        id: "flaky",
        intent: "flaky",
        tags: [],
        inputSchema: z.any(),
        flow: cat.get("work")!.flow,
      })
    );
    const seen: unknown[] = [];
    let i = 0;
    const replies = [flaky, fix(1), flaky, fix(2)];
    const provider: LlmProvider = {
      async complete() {
        return { content: replies[i++] ?? "", stopReason: "end_turn" };
      },
    };
    const effects = new EffectRuntime();
    effects.register("plan-model", createAgentModelEffect(provider));
    effects.register(
      "work",
      new ToolEffect(async (x: unknown) => {
        seen.push(x);
        return {};
      })
    );
    effects.register(
      "flaky",
      new ToolEffect(async () => {
        n++;
        throw new Error("boom");
      })
    );
    registerGoalEffects(effects, store);
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
    });
    const { makeReviser } = await import("./executePlan");
    let res: unknown;
    const runner: FlowRunner<unknown, unknown> = async (ctx) => {
      const goals = goalsClient(ctx);
      await goals.create({ id: "g1", title: "one" });
      await goals.create({ id: "g2", title: "two" });
      const model = effectPlanModel("plan-model");
      const revise = makeReviser({ model });
      const exec = { replan: { max: 1, revise } };
      const a = await runGoal(ctx, goals, "g1", { catalog: c2, plan: { model }, execute: exec });
      const b = await runGoal(ctx, goals, "g2", { catalog: c2, plan: { model }, execute: exec });
      res = [a.goal.status, b.goal.status];
      return {};
    };
    runtime.registerFlow(FLOW, runner);
    const h = await runtime.start(FLOW, {}, { principal: { actor: "alice" } });
    await h.waitForCompletion();
    expect(res).toEqual(["done", "done"]);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    expect(n).toBe(2);
  });

  it("P3: a goal that is already active is refused (one pursuer), and an error never leaves it stuck active", async () => {
    const store = new InMemoryGoalStore();
    const r = await run(store, [plan1], async (ctx, { goals }) => {
      await goals.create({ id: "g1", title: "t" });
      await goals.setStatus({ id: "g1", status: "active" });
      return runGoal(ctx, goals, "g1", cfg);
    });
    expect((r.err as Error).name).toBe("GoalConflictError");
    expect((await store.get(r.owner, "g1")).status).toBe("active"); // untouched: it is someone else's pursuit

    const s2 = new InMemoryGoalStore();
    const denied = await run(
      s2,
      [plan1],
      async (ctx, { goals }) => {
        await goals.create({ id: "g1", title: "t" });
        return runGoal(ctx, goals, "g1", cfg);
      },
      {
        work: () => {
          throw new CapabilityDeniedError("work", "nope");
        },
      }
    );
    expect((denied.err as Error).name).toMatch(/Denied|StepError/);
    const g = await s2.get(denied.owner, "g1");
    expect(g.status).toBe("open");
    expect(g.lastRun?.error).toBeDefined();
  });

  it("P3: a pursued goal that has children is not recomputed from them (its own outcome is returned)", async () => {
    const store = new InMemoryGoalStore();
    const r = await run(store, [plan1], async (ctx, { goals }) => {
      await goals.create({ id: "p", title: "parent" });
      await goals.create({ id: "mid", title: "mid", parentId: "p" });
      await goals.create({ id: "kid", title: "kid", parentId: "mid" });
      await goals.setStatus({ id: "kid", status: "done" });
      const out = await runGoal(ctx, goals, "mid", {
        ...cfg,
        execute: { reflect: async () => "stop" },
      });
      return out.goal.status as never;
    });
    expect(r.out).toBe("open"); // stopped by reflection; the finished child does not turn it `done`
  });

  it("P3: runGoal's result is its own, not recomputed by a self-rollup", async () => {
    const store = new InMemoryGoalStore();
    const r = await run(store, [plan1], async (ctx, { goals }) => {
      await goals.create({ id: "p", title: "parent" });
      await goals.create({ id: "c", title: "child", parentId: "p" });
      await goals.create({ id: "c2", title: "sibling", parentId: "p" });
      const out = await runGoal(ctx, goals, "c", cfg);
      return { child: out.goal.status, parent: (await goals.get("p")).status } as never;
    });
    expect(r.out).toEqual({ child: "done", parent: "open" });
  });
});

describe.each(stores)("%s - idempotency ledger (R16 fix round 2)", (_n, make) => {
  it("P3-2: the ledger is bounded - an evicted key re-applies, a recent key is served", async () => {
    const s = make();
    await s.create("a", { id: "g", title: "t" });
    for (let i = 0; i < 70; i++) {
      await s.setStatus(
        "a",
        { id: "g", status: "open", note: `n${i}` },
        { idempotencyKey: `k${i}` }
      );
    }
    const before = (await s.get("a", "g")).revision; // 1 + 70
    expect(before).toBe(71);
    // A recent key returns the ORIGINAL result and changes nothing.
    const recent = await s.setStatus(
      "a",
      { id: "g", status: "open", note: "x" },
      { idempotencyKey: "k69" }
    );
    expect(recent.revision).toBe(71);
    expect((await s.get("a", "g")).revision).toBe(71);
    // The oldest key fell off the 64-entry ledger: replayed after >64 later writes, it applies again
    // (the documented residual: a set-to-value, so the worst case is a stale status, never a double create).
    await s.setStatus("a", { id: "g", status: "open", note: "again" }, { idempotencyKey: "k0" });
    expect((await s.get("a", "g")).revision).toBe(72);
  });
});

describe("DurableGoalStore - ledger size (R16 fix round 2)", () => {
  it("P3-2: the stored ledger never exceeds 64 entries", async () => {
    const k = kv();
    const s = new DurableGoalStore(k);
    await s.create("a", { id: "g", title: "t" });
    for (let i = 0; i < 100; i++) {
      await s.setStatus("a", { id: "g", status: "open" }, { idempotencyKey: `k${i}` });
    }
    const doc = [...k.data.values()][0]?.payload as { applied: unknown[] };
    expect(doc.applied.length).toBe(64);
  });
});

describe("fix round 2 - runGoal pursuit (R16)", () => {
  const sink = (id: string, v: number) => ({ id, capabilityId: "work", args: { n: v } });
  const plan1 = JSON.stringify({ nodes: [sink("w1", 1)] });
  const cfg0 = { catalog: cat, plan: { model: effectPlanModel("plan-model") } };
  const owner = ownerOfPrincipal({ actor: "alice" } as never);

  /** One flow run over `store`; `work` runs as the plan's capability. */
  const go = async (
    store: GoalStore,
    body: (ctx: ExecutionContext, goals: ReturnType<typeof goalsClient>) => Promise<unknown>,
    work: () => unknown = () => ({ ok: 1 })
  ) => {
    let out: unknown;
    let err: unknown;
    let executionId = "";
    const provider: LlmProvider = {
      async complete() {
        return { content: plan1, stopReason: "end_turn" };
      },
    };
    const effects = new EffectRuntime();
    effects.register("plan-model", createAgentModelEffect(provider));
    effects.register("work", new ToolEffect(async () => work()));
    registerGoalEffects(effects, store);
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
    });
    const runner: FlowRunner<unknown, unknown> = async (ctx) => {
      executionId = ctx.executionId;
      try {
        out = await body(ctx, goalsClient(ctx));
      } catch (e) {
        err = e;
      }
      return {};
    };
    runtime.registerFlow(FLOW, runner);
    const h = await runtime.start(FLOW, {}, { principal: { actor: "alice" } as never });
    await h.waitForCompletion();
    return { out: out as never, err, executionId };
  };

  it("P3-1: the active transition is a compare-and-set on the revision read", async () => {
    let armed = false;
    class Racing extends InMemoryGoalStore {
      override async get(o: string, id: string) {
        const g = await super.get(o, id);
        if (armed) {
          armed = false; // a concurrent writer lands between runGoal's get and its setStatus
          await super.setStatus(o, { id, status: "open", note: "raced" });
        }
        return g;
      }
    }
    const store = new Racing();
    const r = await go(store, async (ctx, goals) => {
      await goals.create({ id: "g1", title: "t" });
      armed = true;
      return runGoal(ctx, goals, "g1", cfg0);
    });
    expect((r.err as Error).name).toBe("GoalConflictError");
    const g = await store.get(owner, "g1");
    expect(g.status).toBe("open"); // never flipped to active by the loser
    expect(g.note).toBe("raced");
  });

  it("P3-5: the pursuing execution is recorded while active and cleared when the pursuit ends", async () => {
    const store = new InMemoryGoalStore();
    let during: string | undefined;
    const r = await go(
      store,
      async (ctx, goals) => {
        await goals.create({ id: "g1", title: "t" });
        return runGoal(ctx, goals, "g1", cfg0);
      },
      async () => {
        during = (await store.get(owner, "g1")).holder;
        return { ok: 1 };
      }
    );
    expect(r.err).toBeUndefined();
    expect(during).toBe(r.executionId);
    expect((await store.get(owner, "g1")).holder).toBeUndefined();
  });

  it("P3-5: a goal left active by a holder that is no longer live is taken over", async () => {
    const store = new InMemoryGoalStore();
    const asked: string[] = [];
    const r = await go(store, async (ctx, goals) => {
      await goals.create({ id: "g1", title: "t" });
      await goals.setStatus({ id: "g1", status: "active", holder: "dead-exec" });
      const out = await runGoal(ctx, goals, "g1", {
        ...cfg0,
        isExecutionLive: async (id) => {
          asked.push(id);
          return false;
        },
      });
      return out.goal.status as never;
    });
    expect(r.err).toBeUndefined();
    expect(r.out).toBe("done");
    expect(asked).toEqual(["dead-exec"]);
    expect((await store.get(owner, "g1")).holder).toBeUndefined();
  });

  it("P3-5: a live holder is refused, naming it, and the goal is untouched", async () => {
    const store = new InMemoryGoalStore();
    const r = await go(store, async (ctx, goals) => {
      await goals.create({ id: "g1", title: "t" });
      await goals.setStatus({ id: "g1", status: "active", holder: "live-exec" });
      return runGoal(ctx, goals, "g1", { ...cfg0, isExecutionLive: async () => true });
    });
    expect((r.err as Error).name).toBe("GoalConflictError");
    expect((r.err as Error).message).toContain("live-exec");
    const g = await store.get(owner, "g1");
    expect(g.status).toBe("active");
    expect(g.holder).toBe("live-exec");
  });

  it("P3-5: no liveness hook, or a hook that throws, never takes over", async () => {
    for (const hook of [
      undefined,
      async () => {
        throw new Error("lookup down");
      },
    ]) {
      const store = new InMemoryGoalStore();
      const r = await go(store, async (ctx, goals) => {
        await goals.create({ id: "g1", title: "t" });
        await goals.setStatus({ id: "g1", status: "active", holder: "x-exec" });
        return runGoal(ctx, goals, "g1", {
          ...cfg0,
          ...(hook !== undefined && { isExecutionLive: hook }),
        });
      });
      expect((r.err as Error).name).toBe("GoalConflictError");
      expect((await store.get(owner, "g1")).status).toBe("active");
    }
  });
});
