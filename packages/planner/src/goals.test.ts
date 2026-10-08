import { createAgentModelEffect } from "@loom/agent";
import { CapabilityCatalog, capability$ } from "@loom/capability";
import { flow$, handler$, step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider } from "@loom/llm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { ExecutionContext, FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { goalsClient, ownerOfPrincipal, registerGoalEffects, runGoal } from "./goalEffects";
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
