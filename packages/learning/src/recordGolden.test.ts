import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decideWithPolicy } from "./decideWithPolicy";
import { InMemoryPolicyKv, PolicyRegistry } from "./registry";
import { type PolicyResolver, decideWithRollout } from "./rollout";
import type { EvalReport, Policy } from "./types";
import { contentHash, promptVersion } from "./versions";

// The DECISION_RECORDED payload `decideWithPolicy` / `decideWithRollout` write is a CONTRACT: the
// off-policy evaluators, `sliceByVersion` and every old log depend on it. R18 follow-up moved
// every `select` (and the registry read) inside the decider; this golden was captured from the
// code BEFORE that move (`recordGolden.json`), so a green run proves the live records are
// byte-identical (compared as JSON strings, so key ORDER is covered too).
// Regenerate deliberately with LOOM_WRITE_GOLDEN=1 - and only for an intended record change.

const GOLDEN = join(__dirname, "recordGolden.json");
const ACTIONS = ["gemma", "opus"];
const FLOW: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "golden-flow",
  name: "Golden",
  version: "1.0.0",
  inputSchema: z.any(),
  outputSchema: z.any(),
  steps: [],
};

const pol = (version: string, pick: string, propensity?: number): Policy<string> => ({
  id: "router",
  version,
  select: () => ({ action: pick, ...(propensity !== undefined && { propensity }) }),
});
const throwing = (version: string): Policy<string> => ({
  id: "router",
  version,
  select: () => {
    throw new Error("candidate boom");
  },
});

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

async function registry(
  mode: "full" | "shadow" | "canary",
  canaryFraction?: number
): Promise<PolicyRegistry> {
  const reg = new PolicyRegistry({ kv: new InMemoryPolicyKv(), scope: "tenant-a" });
  for (const v of ["1", "2"]) {
    await reg.register({ id: "router", version: v, contentHash: contentHash({ v }), now: 1 });
  }
  await reg.bootstrap({ id: "router", version: "1", now: 2 });
  if (mode !== "full") {
    await reg.promote({
      id: "router",
      version: "2",
      report: okReport("2"),
      mode,
      ...(canaryFraction !== undefined && { canaryFraction }),
      now: 5,
    });
  }
  return reg;
}

async function payloadOf(
  body: (ctx: Parameters<typeof decideWithPolicy>[0]) => Promise<unknown>
): Promise<string> {
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });
  runtime.registerFlow(FLOW, async (ctx) => {
    await body(ctx);
    return {};
  });
  const h = await runtime.start(FLOW, {});
  await h.waitForCompletion();
  const rec = (await eventStore.read(h.executionId)).filter(
    (e) => e.eventType === "DECISION_RECORDED"
  );
  expect(rec).toHaveLength(1);
  return JSON.stringify(rec[0]?.payload);
}

const refs = { prompt: promptVersion("p", "v1") };
const IMPLS: Record<string, Policy<string>> = {
  "1": pol("1", "gemma", 1),
  "2": pol("2", "opus", 0.8),
};
const resolveAll: PolicyResolver<string> = (_i, v) => IMPLS[v];
const throwingCandidate: PolicyResolver<string> = (_i, v) => (v === "2" ? throwing("2") : IMPLS[v]);
const noCandidate: PolicyResolver<string> = (_i, v) => (v === "2" ? undefined : IMPLS[v]);

async function scenarios(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const roll = async (
    name: string,
    reg: PolicyRegistry,
    resolve: PolicyResolver<string>,
    opts?: Parameters<typeof decideWithRollout>[6]
  ) => {
    out[name] = await payloadOf((ctx) =>
      decideWithRollout(
        ctx,
        "d",
        { source: reg, policyId: "router", resolve },
        "user-1",
        { q: 1 },
        ACTIONS,
        opts
      )
    );
  };
  out["policy/propensity+refs+rationale+source"] = await payloadOf((ctx) =>
    decideWithPolicy(ctx, "d", pol("7", "opus", 0.7), { q: 1 }, ACTIONS, {
      refs,
      rationale: "why",
      source: "src",
    })
  );
  out["policy/no-propensity"] = await payloadOf((ctx) =>
    decideWithPolicy(ctx, "d", pol("7", "gemma"), { q: 1 }, ACTIONS)
  );
  await roll("rollout/full", await registry("full"), resolveAll, { refs });
  await roll("rollout/canary-candidate", await registry("canary", 0.999), resolveAll, {
    refs,
    rationale: "r",
    source: "s",
  });
  await roll("rollout/canary-incumbent", await registry("canary", 0.001), resolveAll);
  await roll("rollout/canary-fallback", await registry("canary", 0.999), noCandidate);
  await roll("rollout/canary-secret", await registry("canary", 0.5), resolveAll, {
    bucketSecret: "s3cret",
  });
  await roll("rollout/shadow", await registry("shadow"), resolveAll, { refs });
  await roll("rollout/shadow-throwing", await registry("shadow"), throwingCandidate);
  await roll("rollout/shadow-no-code", await registry("shadow"), noCandidate);
  return out;
}

describe("DECISION_RECORDED records are byte-identical to the pre-follow-up golden", () => {
  it("every scenario matches", async () => {
    const now = await scenarios();
    if (process.env.LOOM_WRITE_GOLDEN === "1") {
      writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, string>;
    expect(Object.keys(now).sort()).toEqual(Object.keys(golden).sort());
    for (const k of Object.keys(golden)) expect(now[k], k).toBe(golden[k]);
  });
});
