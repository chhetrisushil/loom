import type { EventEnvelope, FlowDefinition } from "@loomwork/core";
import { EffectRuntime, type PrincipalChain, ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loomwork/event-runtime";
import { orchestrationPrincipalCodec } from "@loomwork/orchestration";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { GrantSource } from "./broker";
import { taskAuthorityPrincipalCodec } from "./codec";
import { type TaskGrant, signTaskGrant } from "./grant";
import { installTaskAuthority } from "./install";
import { InMemoryGrantBroker } from "./renew";

const SECRET = "ta-secret";
const NOW = 1_000_000;
const mkBroker = () =>
  new InMemoryGrantBroker({
    secret: SECRET,
    now: () => NOW,
    policy: () => ({ leases: { w: 20 } }),
  });
const mint = (b: InMemoryGrantBroker, taskId = "task-1") =>
  b.mint({
    taskId,
    issuedTo: "agent-a",
    effects: ["act"],
    leases: { w: { ceiling: 10, effects: ["act"] } },
    ttlMs: 60_000,
  });
const unsigned = (g: TaskGrant) => {
  const { sig: _s, ...rest } = g;
  return rest;
};
const chainOf = (g: TaskGrant, over: Partial<PrincipalChain> = {}): PrincipalChain => ({
  actor: g.issuedTo,
  taskGrant: g,
  ...over,
});

// ── real runtime ──────────────────────────────────────────────────────────────

const EMPTY = z.object({});
const task = (id: string) => ({ _tag: "TaskDefinition", kind: "tool", id, toolId: "act" }) as never;
const runner: FlowRunner<unknown, { ok: boolean }> = async (ctx) => {
  await ctx.execute(task("first"), {});
  await ctx.suspend({ on: "GO" });
  await ctx.execute(task("second"), {});
  return { ok: true };
};
const definition: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "ta-flow",
  name: "ta-flow",
  version: "1.0.0",
  inputSchema: EMPTY,
  outputSchema: z.object({ ok: z.boolean() }),
  steps: [],
};
const flow = { definition, runner } as unknown as RegisteredFlow;

interface Stores {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
  timerStore: InMemoryTimerStore;
}
function boot(broker: InMemoryGrantBroker, shared?: Stores) {
  const seen: (PrincipalChain | undefined)[] = [];
  const asked: unknown[] = [];
  const effects = new EffectRuntime([], {
    authorizer: {
      authorize: (req) => {
        asked.push(req.principal);
        return { allowed: true };
      },
    },
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
  const runtime = new WorkflowRuntime({ ...stores, effectRuntime: effects });
  runtime.registerFlow(definition, runner as FlowRunner<unknown, unknown>);
  installTaskAuthority(runtime, { source: broker, secret: SECRET });
  return { runtime, seen, asked, ...stores };
}
const GO = { eventType: "GO", payload: {} };

describe("principal record", () => {
  it("records { v: 1, ref } and never the grant signature", async () => {
    const broker = mkBroker();
    const g = await mint(broker);
    const h = boot(broker);
    const run = await h.runtime.start(flow, {}, { executionId: "e1", principal: chainOf(g) });
    await run.waitForSuspend();
    const events: EventEnvelope[] = await h.eventStore.read("e1");
    expect(events.length).toBeGreaterThan(0);
    expect((events[0]!.payload as { principal: unknown }).principal).toEqual({
      v: 1,
      ref: "ta1:task-1",
    });
    let scanned = 0;
    for (const e of events) {
      scanned++;
      expect(JSON.stringify(e)).not.toContain(g.sig);
    }
    expect(scanned).toBe(events.length);
    expect(h.seen[0]?.taskGrant).toMatchObject({ taskId: "task-1", epoch: 0 });
  });

  it("a renewal while parked is what the effect after the resume sees", async () => {
    const broker = mkBroker();
    const g = await mint(broker);
    const h = boot(broker);
    const run = await h.runtime.start(flow, {}, { executionId: "e2", principal: chainOf(g) });
    await run.waitForSuspend();
    const v = await broker.renew({ taskId: "task-1", epoch: 0, spent: { w: 1 }, renewals: 0 });
    expect(v).toMatchObject({ granted: true, epoch: 1 });
    const resumed = await h.runtime.resume("e2", GO, { principal: chainOf(g) });
    await resumed.waitForCompletion();
    expect(h.seen).toHaveLength(2);
    expect((h.seen[1]!.taskGrant as TaskGrant).epoch).toBe(1);
  });

  it("revoked while parked: the kernel refuses the next effect before any authorizer", async () => {
    const broker = mkBroker();
    const g = await mint(broker);
    const h = boot(broker);
    const run = await h.runtime.start(flow, {}, { executionId: "e3", principal: chainOf(g) });
    await run.waitForSuspend();
    const askedBefore = h.asked.length;
    await broker.revoke("task-1", "stop");
    const resumed = await h.runtime.resume("e3", GO, { principal: chainOf(g) });
    await expect(resumed.waitForCompletion()).rejects.toThrow(
      /recorded principal could not be restored.*ta1:task-1/s
    );
    const types = (await h.eventStore.read("e3")).map((e) => e.eventType);
    expect(types).toContain("EFFECT_DENIED");
    expect(h.seen).toHaveLength(1); // the second effect never ran
    expect(h.asked.length).toBe(askedBefore); // no authorizer was consulted
  });

  it("a fresh runtime over the same stores and broker recovers the parked run", async () => {
    const broker = mkBroker();
    const g = await mint(broker);
    const h = boot(broker);
    const run = await h.runtime.start(flow, {}, { executionId: "e4", principal: chainOf(g) });
    await run.waitForSuspend();
    await broker.renew({ taskId: "task-1", epoch: 0, spent: {}, renewals: 0 });
    const h2 = boot(broker, h);
    const resumed = await h2.runtime.resume("e4", GO, { principal: chainOf(g) });
    await resumed.waitForCompletion();
    expect((h2.seen.at(-1)!.taskGrant as TaskGrant).epoch).toBe(1);
  });
});

// ── codec units ───────────────────────────────────────────────────────────────

describe("taskAuthorityPrincipalCodec.toRef", () => {
  const codec = (src: GrantSource = mkBroker()) =>
    taskAuthorityPrincipalCodec(src, { secret: SECRET });
  it("takes a verified grant held by its actor", async () => {
    const g = await mint(mkBroker());
    expect(codec().toRef(chainOf(g))).toBe("ta1:task-1");
  });
  it("refuses a forged grant, a holder mismatch, tenant, onBehalfOf, delegation, a bad taskId", async () => {
    const g = await mint(mkBroker());
    const c = codec();
    expect(c.toRef(chainOf({ ...g, effects: ["db.drop"] }))).toBeUndefined();
    expect(c.toRef(chainOf(signTaskGrant("other", unsigned(g))))).toBeUndefined();
    expect(c.toRef(chainOf(g, { actor: "mallory" }))).toBeUndefined();
    expect(c.toRef(chainOf(g, { tenant: "acme" }))).toBeUndefined();
    expect(c.toRef(chainOf(g, { onBehalfOf: "carol" }))).toBeUndefined();
    expect(c.toRef(chainOf(g, { delegation: {} as never }))).toBeUndefined();
    expect(c.toRef({ actor: "agent-a" })).toBeUndefined();
    const ctl = signTaskGrant(SECRET, { ...unsigned(g), taskId: "a\nb", rootId: "a\nb" });
    expect(c.toRef(chainOf(ctl))).toBeUndefined();
  });
});

describe("taskAuthorityPrincipalCodec.fromRef", () => {
  const ctx = { executionId: "x" };
  it("ignores a ref that is not its own", async () => {
    const c = taskAuthorityPrincipalCodec(mkBroker(), { secret: SECRET });
    expect(await c.fromRef("loom:orch:v2:abc", ctx)).toBeUndefined();
  });
  it("refuses an over-long or control-character task id without asking the source", async () => {
    let asked = 0;
    const src: GrantSource = {
      current: async () => {
        asked++;
        return undefined;
      },
    };
    const c = taskAuthorityPrincipalCodec(src, { secret: SECRET });
    expect(await c.fromRef(`ta1:${"x".repeat(257)}`, ctx)).toBeUndefined();
    expect(await c.fromRef("ta1:a\nb", ctx)).toBeUndefined();
    expect(await c.fromRef("ta1:", ctx)).toBeUndefined();
    expect(asked).toBe(0);
  });
  it("restores the current grant, and nothing for a missing or revoked task", async () => {
    const b = mkBroker();
    await mint(b);
    const c = taskAuthorityPrincipalCodec(b, { secret: SECRET });
    expect(await c.fromRef("ta1:task-1", ctx)).toMatchObject({
      actor: "agent-a",
      taskGrant: { taskId: "task-1" },
    });
    expect(await c.fromRef("ta1:nope", ctx)).toBeUndefined();
    await b.revoke("task-1", "r");
    expect(await c.fromRef("ta1:task-1", ctx)).toBeUndefined();
  });
  it("honours source.revoked(digest) even when current still answers", async () => {
    const b = mkBroker();
    const g = await mint(b);
    const src: GrantSource = { current: async () => g, revoked: async () => true };
    expect(
      await taskAuthorityPrincipalCodec(src, { secret: SECRET }).fromRef("ta1:task-1", ctx)
    ).toBeUndefined();
  });
  it("is undefined when the source throws or returns a grant signed under another secret", async () => {
    const g = await mint(mkBroker());
    const boom: GrantSource = {
      current: async () => {
        throw new Error("down");
      },
    };
    expect(
      await taskAuthorityPrincipalCodec(boom, { secret: SECRET }).fromRef("ta1:task-1", ctx)
    ).toBeUndefined();
    const forged = signTaskGrant("other", unsigned(g));
    const bad: GrantSource = { current: async () => forged };
    expect(
      await taskAuthorityPrincipalCodec(bad, { secret: SECRET }).fromRef("ta1:task-1", ctx)
    ).toBeUndefined();
    const wrongTask: GrantSource = { current: async () => g };
    expect(
      await taskAuthorityPrincipalCodec(wrongTask, { secret: SECRET }).fromRef("ta1:other", ctx)
    ).toBeUndefined();
  });
});

describe("composition with orchestrationPrincipalCodec", () => {
  it("each codec ignores the other's refs", async () => {
    const b = mkBroker();
    const g = await mint(b);
    const ta = taskAuthorityPrincipalCodec(b, { secret: SECRET });
    const orch = orchestrationPrincipalCodec("orch-secret");
    const ref = ta.toRef(chainOf(g))!;
    expect(orch.toRef(chainOf(g))).toBeUndefined();
    expect(await orch.fromRef(ref, { executionId: "x" })).toBeUndefined();
    expect(await ta.fromRef("loom:orch:v2:abc.def", { executionId: "x" })).toBeUndefined();
  });
});
