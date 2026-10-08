import type { FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decideWithPolicy } from "./decideWithPolicy";
import { evaluatePolicy } from "./evaluate";
import { InMemoryPolicyKv, PolicyRegistry } from "./registry";
import { type PolicyResolver, decideWithRollout, rolloutBucket } from "./rollout";
import { trajectories } from "./trajectories";
import type { EvalReport, Policy } from "./types";
import { contentHash, promptVersion, sliceByVersion } from "./versions";

const ACTIONS = ["gemma", "opus"];

function policy(version: string, pick: string, propensity = 1): Policy<string> {
  return { id: "router", version, select: () => ({ action: pick, propensity }) };
}
const IMPLS: Record<string, Policy<string>> = {
  "1": policy("1", "gemma"),
  "2": policy("2", "opus", 0.8),
};
const resolve: PolicyResolver<string> = (_id, v) => IMPLS[v];

const okReport = (version: string): EvalReport => ({
  policy: { id: "router", version },
  evaluated: 9999,
  skipped: { noContext: 0, noActions: 0, noReward: 0 },
  agreement: 0.2,
  loggedValue: 0.4,
  estimatedValue: 0.6,
  estimator: "snips",
  lift: 0.2,
  effectiveSampleSize: 5000,
  warnings: [],
});

async function liveRegistry() {
  const reg = new PolicyRegistry({ kv: new InMemoryPolicyKv(), scope: "tenant-a" });
  for (const v of ["1", "2"]) {
    await reg.register({ id: "router", version: v, contentHash: contentHash({ v }), now: 1 });
  }
  await reg.bootstrap({ id: "router", version: "1", now: 2 });
  return reg;
}

/** A ctx whose `decide` serves a recorded decision and otherwise records - the kernel's rule. */
function fakeCtx() {
  const recorded = new Map<string, { choice: unknown; opts: unknown }>();
  return {
    recorded,
    ctx: {
      async decide<T>(id: string, decider: () => T | Promise<T>, opts?: unknown): Promise<T> {
        const hit = recorded.get(id);
        if (hit !== undefined) return hit.choice as T;
        const choice = await decider();
        recorded.set(id, { choice, opts });
        return choice;
      },
    },
  };
}

type Stamp = {
  id: string;
  version: string;
  propensity?: number;
  rollout?: Record<string, unknown>;
};
const stampOf = (r: Map<string, { opts: unknown }>, id: string): Stamp =>
  (r.get(id)?.opts as { policy: Stamp }).policy;

describe("rolloutBucket", () => {
  it("is a pure, stable function of (salt, unit), uniform enough to split traffic", () => {
    expect(rolloutBucket("s", "u1")).toBe(rolloutBucket("s", "u1"));
    expect(rolloutBucket("s", "u1")).not.toBe(rolloutBucket("s2", "u1"));
    let below = 0;
    for (let i = 0; i < 4000; i++) {
      const b = rolloutBucket("salt", `user-${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(1);
      if (b < 0.25) below += 1;
    }
    expect(below).toBeGreaterThan(850);
    expect(below).toBeLessThan(1150);
  });

  it("a ramp keeps earlier candidate units on the candidate (monotone slice)", () => {
    const small = new Set<string>();
    const big = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const b = rolloutBucket("salt", `u${i}`);
      if (b < 0.1) small.add(`u${i}`);
      if (b < 0.3) big.add(`u${i}`);
    }
    for (const u of small) expect(big.has(u)).toBe(true);
  });
});

describe("decideWithRollout (R18)", () => {
  const src = (reg: PolicyRegistry) => ({ source: reg, policyId: "router", resolve });

  it("full: the incumbent acts and the stamp names it", async () => {
    const reg = await liveRegistry();
    const { ctx, recorded } = fakeCtx();
    const a = await decideWithRollout(ctx, "d", src(reg), "u1", { x: 1 }, ACTIONS);
    expect(a).toBe("gemma");
    expect(stampOf(recorded, "d")).toMatchObject({
      id: "router",
      version: "1",
      propensity: 1,
      rollout: { mode: "full", acted: { version: "1" } },
    });
    expect(stampOf(recorded, "d").rollout).not.toHaveProperty("shadow");
  });

  it("shadow NEVER acts: every unit gets the incumbent's choice; the candidate's is only recorded", async () => {
    const reg = await liveRegistry();
    await reg.promote({
      id: "router",
      version: "2",
      report: okReport("2"),
      mode: "shadow",
      now: 5,
    });
    const { ctx, recorded } = fakeCtx();
    for (let i = 0; i < 200; i++) {
      expect(await decideWithRollout(ctx, `d${i}`, src(reg), `u${i}`, {}, ACTIONS)).toBe("gemma");
    }
    const s = stampOf(recorded, "d7");
    expect(s).toMatchObject({ version: "1", rollout: { mode: "shadow", acted: { version: "1" } } });
    expect(s.rollout?.shadow).toEqual({
      id: "router",
      version: "2",
      action: "opus",
      propensity: 0.8,
    });
  });

  it("a throwing shadow policy is recorded as an error and changes nothing", async () => {
    const reg = await liveRegistry();
    await reg.promote({
      id: "router",
      version: "2",
      report: okReport("2"),
      mode: "shadow",
      now: 5,
    });
    const boom: PolicyResolver<string> = (id, v) =>
      v === "2"
        ? {
            id,
            version: "2",
            select: () => {
              throw new Error("candidate bug");
            },
          }
        : IMPLS[v];
    const { ctx, recorded } = fakeCtx();
    expect(
      await decideWithRollout(
        ctx,
        "d",
        { source: reg, policyId: "router", resolve: boom },
        "u",
        {},
        ACTIONS
      )
    ).toBe("gemma");
    expect((stampOf(recorded, "d").rollout?.shadow as { error: string }).error).toMatch(
      /candidate bug/
    );
  });

  it("canary splits deterministically by unit: same unit, same arm, every time and in every process", async () => {
    const reg = await liveRegistry();
    await reg.promote({
      id: "router",
      version: "2",
      report: okReport("2"),
      mode: "canary",
      canaryFraction: 0.3,
      now: 5,
    });
    const arms = new Map<string, string>();
    let candidate = 0;
    for (let i = 0; i < 1000; i++) {
      const { ctx, recorded } = fakeCtx();
      const action = await decideWithRollout(ctx, "d", src(reg), `user-${i}`, {}, ACTIONS);
      const s = stampOf(recorded, "d");
      expect(action).toBe(s.version === "2" ? "opus" : "gemma");
      expect(s.rollout?.bucket).toBe(rolloutBucket("router:2", `user-${i}`));
      expect(s.rollout?.armProbability).toBeCloseTo(s.version === "2" ? 0.3 : 0.7);
      // the non-acting arm is recorded too
      expect((s.rollout?.shadow as { version: string }).version).toBe(
        s.version === "2" ? "1" : "2"
      );
      arms.set(`user-${i}`, s.version);
      if (s.version === "2") candidate += 1;
    }
    expect(candidate).toBeGreaterThan(240);
    expect(candidate).toBeLessThan(360);
    // a fresh registry instance over the same state gives the same assignment
    const again = new PolicyRegistry({ kv: new InMemoryPolicyKv(), scope: "tenant-a" });
    expect(again).not.toBe(reg);
    for (const [unit, version] of [...arms].slice(0, 50)) {
      const { ctx, recorded } = fakeCtx();
      await decideWithRollout(ctx, "d", src(reg), unit, {}, ACTIONS);
      expect(stampOf(recorded, "d").version).toBe(version);
    }
  });

  it("an unavailable candidate falls back to the incumbent and says why; an unavailable incumbent throws", async () => {
    const reg = await liveRegistry();
    await reg.promote({
      id: "router",
      version: "2",
      report: okReport("2"),
      mode: "canary",
      canaryFraction: 0.999,
      now: 5,
    });
    const onlyOne: PolicyResolver<string> = (_id, v) => (v === "1" ? IMPLS["1"] : undefined);
    const { ctx, recorded } = fakeCtx();
    expect(
      await decideWithRollout(
        ctx,
        "d",
        { source: reg, policyId: "router", resolve: onlyOne },
        "u",
        {},
        ACTIONS
      )
    ).toBe("gemma");
    const s = stampOf(recorded, "d");
    expect(s.version).toBe("1");
    expect((s.rollout?.shadow as { error: string }).error).toMatch(/no code for/);

    const none: PolicyResolver<string> = () => undefined;
    const f = fakeCtx();
    await expect(
      decideWithRollout(
        f.ctx,
        "e",
        { source: reg, policyId: "router", resolve: none },
        "u",
        {},
        ACTIONS
      )
    ).rejects.toThrow(/no code for incumbent/);
    expect(f.recorded.size).toBe(0);
  });

  it("a policy with no live version, no actions, or no unit key is refused", async () => {
    const reg = new PolicyRegistry({ kv: new InMemoryPolicyKv(), scope: "t" });
    const { ctx } = fakeCtx();
    await expect(
      decideWithRollout(ctx, "d", { source: reg, policyId: "router", resolve }, "u", {}, ACTIONS)
    ).rejects.toThrow(/no live version/);
    const live = await liveRegistry();
    await expect(decideWithRollout(ctx, "d", src(live), "u", {}, [])).rejects.toThrow(/no actions/);
    await expect(decideWithRollout(ctx, "d", src(live), "", {}, ACTIONS)).rejects.toThrow(
      /unitKey/
    );
  });

  it("rollback restores the incumbent for the next decision", async () => {
    const reg = await liveRegistry();
    await reg.promote({
      id: "router",
      version: "2",
      report: okReport("2"),
      mode: "full",
      now: 5,
    });
    const { ctx } = fakeCtx();
    expect(await decideWithRollout(ctx, "a", src(reg), "u", {}, ACTIONS)).toBe("opus");
    await reg.rollback({ id: "router", now: 6 });
    expect(await decideWithRollout(ctx, "b", src(reg), "u", {}, ACTIONS)).toBe("gemma");
  });

  it("records prompt/model refs in the stamp (additive), and decideWithPolicy does too", async () => {
    const reg = await liveRegistry();
    const refs = { prompt: promptVersion("triage", "You are a router.") };
    const { ctx, recorded } = fakeCtx();
    await decideWithRollout(ctx, "d", src(reg), "u", {}, ACTIONS, { refs });
    expect((recorded.get("d")?.opts as { policy: Stamp }).policy).toMatchObject({ refs });
    await decideWithPolicy(ctx, "e", IMPLS["1"] as Policy<string>, {}, ACTIONS, { refs });
    expect((recorded.get("e")?.opts as { policy: Stamp }).policy).toMatchObject({ refs });
    await decideWithPolicy(ctx, "f", IMPLS["1"] as Policy<string>, {}, ACTIONS);
    expect(stampOf(recorded, "f")).not.toHaveProperty("refs");
  });
});

// ── Through the real kernel: replay is identical whatever the registry says now ──────────────

const FLOW: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "rollout-flow",
  name: "Rollout Flow",
  version: "1.0.0",
  inputSchema: z.any(),
  outputSchema: z.any(),
  steps: [],
};

describe("rollout through the kernel", () => {
  it("replay serves the recorded choice and stamp even after the registry rolled somewhere else", async () => {
    const reg = await liveRegistry();
    await reg.promote({
      id: "router",
      version: "2",
      report: okReport("2"),
      mode: "canary",
      canaryFraction: 0.999,
      now: 5,
    });
    const eventStore = new InMemoryAsyncEventStore();
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
    });
    const seen: string[] = [];
    const runner: FlowRunner<unknown, unknown> = async (ctx) => {
      const a = await decideWithRollout(
        ctx,
        "route",
        { source: reg, policyId: "router", resolve },
        "user-1",
        { q: 1 },
        ACTIONS,
        { refs: { prompt: promptVersion("p", "v1") } }
      );
      seen.push(a);
      await ctx.suspend({ on: "go" });
      return {};
    };
    runtime.registerFlow(FLOW, runner);
    const h = await runtime.start(FLOW, {});
    await h.waitForSuspend();
    expect(seen).toEqual(["opus"]);

    await reg.rollback({ id: "router", now: 9 }); // registry now says "1 for everyone"
    const r = await runtime.resume(h.executionId, { eventType: "go", payload: {} });
    await r.waitForCompletion();
    expect(seen).toEqual(["opus", "opus"]);

    const log = await eventStore.read(h.executionId);
    const decisions = log.filter((e) => e.eventType === "DECISION_RECORDED");
    expect(decisions).toHaveLength(1);
    const p = (decisions[0]?.payload as { policy: Stamp }).policy;
    expect(p).toMatchObject({
      id: "router",
      version: "2",
      rollout: { mode: "canary", acted: { version: "2" } },
    });
    expect(p).toHaveProperty("refs.prompt.id", "p");
    expect(trajectories(log)[0]?.steps[0]?.policy).toMatchObject({ version: "2" });
  });

  it("off-policy evaluation can slice a canary log by acting version and by prompt version", () => {
    const mk = (n: number, version: string, prompt: string) => ({
      executionId: `x${n}${version}${prompt}`,
      steps: [
        {
          decisionId: "d",
          executionId: "x",
          sequence: 1,
          timestamp: 1,
          action: "opus",
          actions: ACTIONS,
          reward: 1,
          rewardSource: "direct" as const,
          policy: {
            id: "router",
            version,
            propensity: 0.5,
            refs: { prompt: promptVersion("p", prompt) },
          },
        },
      ],
      outcome: "completed" as const,
    });
    const ts = [mk(1, "1", "a"), mk(2, "2", "a"), mk(3, "2", "b")];
    const byPolicy = sliceByVersion(ts, "policy");
    expect([...byPolicy.keys()].sort()).toEqual(["router\u00001", "router\u00002"]);
    expect(byPolicy.get("router\u00002")).toHaveLength(2);
    const byPrompt = sliceByVersion(ts, "prompt");
    expect(byPrompt.size).toBe(2);
    expect(
      sliceByVersion(
        [
          {
            ...mk(1, "1", "a"),
            steps: [{ ...mk(1, "1", "a").steps[0]!, policy: undefined as never }],
          },
        ],
        "model"
      ).has("(unversioned)")
    ).toBe(true);
    expect(evaluatePolicy(byPolicy.get("router\u00002") ?? [], policy("3", "opus")).evaluated).toBe(
      0
    ); // no context
  });
});

describe("rollout hardening (R18 fix round 1)", () => {
  const src = (reg: PolicyRegistry, resolveFn: PolicyResolver<string> = resolve) => ({
    source: reg,
    policyId: "router",
    resolve: resolveFn,
  });
  const canaryAt = async (f: number) => {
    const reg = await liveRegistry();
    await reg.promote({
      id: "router",
      version: "2",
      report: okReport("2"),
      mode: "canary",
      canaryFraction: f,
      now: 5,
    });
    return reg;
  };

  it("a canary whose candidate has no code records the INCUMBENT arm's probability and flags the fallback", async () => {
    const reg = await canaryAt(0.99);
    const { ctx, recorded } = fakeCtx();
    const onlyOne: PolicyResolver<string> = (_i, v) => (v === "1" ? IMPLS["1"] : undefined);
    await decideWithRollout(ctx, "d", src(reg, onlyOne), "unit-1", {}, ACTIONS);
    const s = stampOf(recorded, "d");
    expect(s.version).toBe("1");
    expect(s.rollout?.armProbability).toBeCloseTo(0.01);
    expect(s.rollout?.fellBack).toBe(true);
  });

  it("refuses a resolver that returns other code than the registry named", async () => {
    const reg = await liveRegistry();
    await reg.promote({ id: "router", version: "2", report: okReport("2"), mode: "full", now: 5 });
    const stale: PolicyResolver<string> = () => IMPLS["1"]; // says v1 while the registry says v2
    const { ctx, recorded } = fakeCtx();
    await expect(decideWithRollout(ctx, "d", src(reg, stale), "u", {}, ACTIONS)).rejects.toThrow(
      /resolver returned router@1 for incumbent router@2/
    );
    expect(recorded.size).toBe(0);
  });

  it("a mismatched CANDIDATE is treated as unavailable (incumbent acts, reason recorded)", async () => {
    const reg = await canaryAt(0.999);
    const wrongCandidate: PolicyResolver<string> = () => IMPLS["1"];
    const { ctx, recorded } = fakeCtx();
    await decideWithRollout(ctx, "d", src(reg, wrongCandidate), "u", {}, ACTIONS);
    const s = stampOf(recorded, "d");
    expect(s.version).toBe("1");
    expect((s.rollout?.shadow as { error: string }).error).toMatch(/resolver returned/);
  });

  it("a server-held bucketSecret makes the split unpredictable from the public salt", () => {
    const open = rolloutBucket("router:2", "alice");
    const keyed = rolloutBucket("router:2", "alice", "s3cret");
    expect(keyed).not.toBe(open);
    expect(rolloutBucket("router:2", "alice", "s3cret")).toBe(keyed);
    expect(rolloutBucket("router:2", "alice", "other")).not.toBe(keyed);
  });

  it("the secret reaches the recorded bucket", async () => {
    const reg = await canaryAt(0.5);
    const { ctx, recorded } = fakeCtx();
    await decideWithRollout(ctx, "d", src(reg), "alice", {}, ACTIONS, { bucketSecret: "k" });
    expect(stampOf(recorded, "d").rollout?.bucket).toBe(rolloutBucket("router:2", "alice", "k"));
  });

  it("sliceByVersion keys cannot collide across ids containing '@'", () => {
    const step = (id: string, version: string) => ({
      decisionId: "d",
      executionId: "e",
      sequence: 1,
      timestamp: 1,
      action: "a",
      actions: ["a"],
      rewardSource: "none" as const,
      policy: { id, version },
    });
    const m = sliceByVersion(
      [{ executionId: "e", outcome: "completed", steps: [step("x@1", "2"), step("x", "1@2")] }],
      "policy"
    );
    expect(m.size).toBe(2);
  });
});
