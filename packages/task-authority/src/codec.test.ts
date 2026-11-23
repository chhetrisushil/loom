import type { EventEnvelope, FlowDefinition } from "@loomwork/core";
import { EffectRuntime, type PrincipalChain, ToolEffect } from "@loomwork/effect-runtime";
import { signDelegation } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loomwork/event-runtime";
import { orchestrationPrincipalCodec } from "@loomwork/orchestration";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import {
  type FlowRunner,
  type PrincipalResolver,
  type RegisteredFlow,
  WorkflowRuntime,
} from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { GrantSource } from "./broker";
import { taskAuthorityPrincipalCodec } from "./codec";
import { TaskAuthorityPrincipalError } from "./errors";
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
interface BootOpts {
  shared?: Stores;
  resolver?: PrincipalResolver;
  orch?: "before" | "after";
  now?: () => number;
  source?: GrantSource;
}
function boot(broker: InMemoryGrantBroker, o: BootOpts = {}) {
  const { shared } = o;
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
  const runtime = new WorkflowRuntime({
    ...stores,
    effectRuntime: effects,
    ...(o.resolver && { principalResolver: o.resolver }),
  });
  runtime.registerFlow(definition, runner as FlowRunner<unknown, unknown>);
  if (o.orch === "before") runtime.composePrincipalCodec(orchestrationPrincipalCodec("orch"));
  installTaskAuthority(runtime, {
    source: o.source ?? broker,
    secret: SECRET,
    now: o.now ?? (() => NOW),
  });
  if (o.orch === "after") runtime.composePrincipalCodec(orchestrationPrincipalCodec("orch"));
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
      ref: expect.stringMatching(/^ta1:task-1\.[A-Za-z0-9_-]+$/),
    });
    let scanned = 0;
    for (const e of events) {
      scanned++;
      expect(JSON.stringify(e)).not.toContain(g.sig);
    }
    expect(scanned).toBe(events.length);
    const seqs = await h.snapshotStore.listSequences("e1");
    expect(seqs.length).toBeGreaterThan(0);
    for (const q of seqs)
      expect(JSON.stringify(await h.snapshotStore.loadAt("e1", q))).not.toContain(g.sig);
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
      /recorded principal could not be restored.*task grant task-1: revoked/s
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
    const h2 = boot(broker, { shared: h });
    const resumed = await h2.runtime.resume("e4", GO, { principal: chainOf(g) });
    await resumed.waitForCompletion();
    expect((h2.seen.at(-1)!.taskGrant as TaskGrant).epoch).toBe(1);
  });

  it("revoked while parked with a principalResolver that answers {actor:'svc'}: still denied", async () => {
    const broker = mkBroker();
    const g = await mint(broker);
    const h = boot(broker, { resolver: { resolve: () => ({ actor: "svc" }) } });
    const run = await h.runtime.start(flow, {}, { executionId: "e5", principal: chainOf(g) });
    await run.waitForSuspend();
    const askedBefore = h.asked.length;
    await broker.revoke("task-1", "stop");
    const resumed = await h.runtime.resume("e5", GO, { principal: chainOf(g) });
    await expect(resumed.waitForCompletion()).rejects.toThrow(/could not be restored/);
    expect((await h.eventStore.read("e5")).map((e) => e.eventType)).toContain("EFFECT_DENIED");
    expect(h.seen).toHaveLength(1);
    expect(h.asked.length).toBe(askedBefore);
  });

  it("a second execution with the same grant is denied at its first effect; the first is unaffected", async () => {
    const broker = mkBroker();
    const g = await mint(broker);
    const h = boot(broker);
    const a = await h.runtime.start(flow, {}, { executionId: "ea", principal: chainOf(g) });
    await a.waitForSuspend();
    const askedBefore = h.asked.length;
    const b = await h.runtime.start(flow, {}, { executionId: "eb", principal: chainOf(g) });
    await expect(b.waitForCompletion()).rejects.toThrow(/claimed by another execution/);
    expect((await h.eventStore.read("eb")).map((e) => e.eventType)).toContain("EFFECT_DENIED");
    expect(h.asked.length).toBe(askedBefore);
    const resumed = await h.runtime.resume("ea", GO, { principal: chainOf(g) });
    await expect(resumed.waitForCompletion()).resolves.toBeDefined();
    expect(h.seen).toHaveLength(2);
  });
});

describe("a chain the codec cannot encode is refused before anything is appended (R13)", () => {
  const refused = async (
    mk: (g: TaskGrant) => PrincipalChain,
    o: BootOpts = {},
    src?: (b: InMemoryGrantBroker) => TaskGrantMaker
  ) => {
    const broker = mkBroker();
    const g = await mint(broker);
    const h = boot(broker, o);
    const grant = src ? await src(broker)(g) : g;
    await expect(
      h.runtime.start(flow, {}, { executionId: "r1", principal: mk(grant) })
    ).rejects.toThrow(TaskAuthorityPrincipalError);
    expect(await h.eventStore.read("r1")).toHaveLength(0);
  };
  type TaskGrantMaker = (g: TaskGrant) => Promise<TaskGrant> | TaskGrant;
  it("tenant", () => refused((g) => chainOf(g, { tenant: "acme" })));
  it("onBehalfOf", () => refused((g) => chainOf(g, { onBehalfOf: "carol" })));
  it("a wrong-secret grant", () =>
    refused(
      (g) => chainOf(g),
      {},
      () => (g) => signTaskGrant("other", unsigned(g))
    ));
  it("a holder mismatch", () => refused((g) => chainOf(g, { actor: "mallory" })));
  it("an expired grant", () => refused((g) => chainOf(g), { now: () => NOW + 120_000 }));
  it("a null grant", () => refused(() => ({ actor: "agent-a", taskGrant: null as never })));
  for (const orch of ["before", "after"] as const) {
    it(`a delegation alongside the grant (orchestration codec installed ${orch})`, () =>
      refused(
        (g) => ({
          actor: g.issuedTo,
          delegation: signDelegation("orch", g.issuedTo, ["act"]),
          taskGrant: g,
        }),
        { orch }
      ));
  }
});

// ── codec units ───────────────────────────────────────────────────────────────

const ctx = { executionId: "x" };
const refOf = async (c: { toRef(ch: PrincipalChain): string | undefined }, g: TaskGrant) =>
  c.toRef(chainOf(g)) as string;
const unresolved = (r: PrincipalChain | undefined, re: RegExp) => {
  expect(r?.taskGrant).toBeUndefined();
  expect(r?.principalUnresolved).toMatch(re);
};
const mk = (src: GrantSource, o: { timeoutMs?: number; now?: () => number } = {}) =>
  taskAuthorityPrincipalCodec(src, { secret: SECRET, now: () => NOW, ...o });

describe("taskAuthorityPrincipalCodec.toRef", () => {
  it("encodes a verified, unexpired grant held by its actor as ta1:<taskId>.<mac>", async () => {
    const g = await mint(mkBroker());
    expect(mk(mkBroker()).toRef(chainOf(g))).toMatch(/^ta1:task-1\.[A-Za-z0-9_-]{43}$/);
  });
  it("gives undefined only for a chain with no taskGrant", () => {
    expect(mk(mkBroker()).toRef({ actor: "agent-a" })).toBeUndefined();
  });
  it("throws a typed error for every grant it cannot encode", async () => {
    const g = await mint(mkBroker());
    const c = mk(mkBroker());
    const bad: PrincipalChain[] = [
      chainOf({ ...g, effects: ["db.drop"] }),
      chainOf(signTaskGrant("other", unsigned(g))),
      chainOf(g, { actor: "mallory" }),
      chainOf(g, { tenant: "acme" }),
      chainOf(g, { onBehalfOf: "carol" }),
      chainOf(g, { delegation: {} as never }),
      chainOf(signTaskGrant(SECRET, { ...unsigned(g), taskId: "a\nb", rootId: "a\nb" })),
      { actor: "agent-a", taskGrant: null as never },
    ];
    for (const ch of bad) expect(() => c.toRef(ch)).toThrow(TaskAuthorityPrincipalError);
    expect(() => mk(mkBroker(), { now: () => NOW + 60_000 }).toRef(chainOf(g))).toThrow(/expired/);
  });
});

describe("taskAuthorityPrincipalCodec.fromRef", () => {
  it("ignores a ref that is not its own", async () => {
    expect(await mk(mkBroker()).fromRef("loom:orch:v2:abc", ctx)).toBeUndefined();
  });
  it("restores the current grant and answers a repeat claim by the same execution", async () => {
    const b = mkBroker();
    const g = await mint(b);
    const c = mk(b);
    const ref = await refOf(c, g);
    for (let i = 0; i < 2; i++)
      expect(await c.fromRef(ref, ctx)).toMatchObject({
        actor: "agent-a",
        taskGrant: { taskId: "task-1" },
      });
  });
  it("answers unresolved (never undefined) for every failure of its own ref", async () => {
    let asked = 0;
    const src: GrantSource = {
      current: async () => {
        asked++;
        return undefined;
      },
      claim: async () => true,
    };
    const c = mk(src);
    for (const ref of [
      `ta1:${"x".repeat(257)}.mac`,
      "ta1:a\nb.mac",
      "ta1:.mac",
      "ta1:nodot",
      "ta1:",
    ])
      unresolved(await c.fromRef(ref, ctx), /bad ref format/);
    expect(asked).toBe(0);
    unresolved(await c.fromRef("ta1:nope.AAAA", ctx), /nope: revoked or unknown/);
  });
  it("unresolved after a revoke, and when source.revoked(digest) says so", async () => {
    const b = mkBroker();
    const g = await mint(b);
    const ref = await refOf(mk(b), g);
    const viaDigest: GrantSource = {
      current: async () => g,
      revoked: async () => true,
      claim: async () => true,
    };
    unresolved(await mk(viaDigest).fromRef(ref, ctx), /revoked/);
    await b.revoke("task-1", "r");
    unresolved(await mk(b).fromRef(ref, ctx), /task-1: revoked or unknown/);
  });
  it("unresolved when the source throws, or returns a foreign-secret or other-task grant", async () => {
    const b = mkBroker();
    const g = await mint(b);
    const ref = await refOf(mk(b), g);
    const boom: GrantSource = {
      current: async () => {
        throw new Error("down");
      },
      claim: async () => true,
    };
    unresolved(await mk(boom).fromRef(ref, ctx), /source failed/);
    const forged = signTaskGrant("other", unsigned(g));
    unresolved(
      await mk({ current: async () => forged, claim: async () => true }).fromRef(ref, ctx),
      /does not verify/
    );
    unresolved(
      await mk({ current: async () => g, claim: async () => true }).fromRef(
        `ta1:other.${ref.split(".")[1]}`,
        ctx
      ),
      /task id mismatch/
    );
  });
  it("a forged MAC, and a task id reissued to another holder, are unresolved", async () => {
    const b = mkBroker();
    const g = await mint(b);
    const ref = await refOf(mk(b), g);
    unresolved(await mk(b).fromRef(`ta1:task-1.${"A".repeat(43)}`, ctx), /holder/);
    const reissued = signTaskGrant(SECRET, { ...unsigned(g), issuedTo: "agent-b" });
    const src: GrantSource = { current: async () => reissued, claim: async () => true };
    unresolved(await mk(src).fromRef(ref, ctx), /holder/);
  });
  it("another execution's claim is refused", async () => {
    const b = mkBroker();
    const g = await mint(b);
    const c = mk(b);
    const ref = await refOf(c, g);
    expect(await c.fromRef(ref, { executionId: "one" })).toMatchObject({ actor: "agent-a" });
    unresolved(await c.fromRef(ref, { executionId: "two" }), /claimed by another execution/);
    expect(await c.fromRef(ref, { executionId: "one" })).toMatchObject({ actor: "agent-a" });
  });
  it("a source that never resolves is unresolved within timeoutMs", async () => {
    const g = await mint(mkBroker());
    const hang = new Promise<never>(() => {});
    const ref = await refOf(mk(mkBroker()), g);
    for (const src of [
      { current: () => hang, claim: async () => true },
      { current: async () => g, revoked: () => hang, claim: async () => true },
      { current: async () => g, claim: () => hang },
    ] as GrantSource[])
      unresolved(await mk(src, { timeoutMs: 50 }).fromRef(ref, ctx), /timed out/);
  });
  it("a task id containing a dot round-trips", async () => {
    const b = mkBroker();
    const g = await b.mint({
      taskId: "a.b.c",
      issuedTo: "agent-a",
      effects: ["act"],
      leases: { w: { ceiling: 1, effects: ["act"] } },
      ttlMs: 60_000,
    });
    const c = mk(b);
    const ref = await refOf(c, g);
    expect(ref.startsWith("ta1:a.b.c.")).toBe(true);
    expect(await c.fromRef(ref, ctx)).toMatchObject({ taskGrant: { taskId: "a.b.c" } });
  });
});

describe("composition with orchestrationPrincipalCodec", () => {
  it("each codec ignores the other's refs", async () => {
    const b = mkBroker();
    const g = await mint(b);
    const ta = mk(b);
    const orch = orchestrationPrincipalCodec("orch-secret");
    const ref = ta.toRef(chainOf(g))!;
    expect(orch.toRef(chainOf(g))).toBeUndefined();
    expect(await orch.fromRef(ref, { executionId: "x" })).toBeUndefined();
    expect(await ta.fromRef("loom:orch:v2:abc.def", { executionId: "x" })).toBeUndefined();
  });
});
