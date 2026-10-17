import { createAgentModelEffect } from "@loom/agent";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { CassetteMissError } from "@loom/eval";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { IntentRuntime } from "@loom/intent";
import type { LlmProvider } from "@loom/llm";
import { PlanFailedError, PlannerRuntime, effectPlanModel } from "@loom/planner";
import type { PlanGraph } from "@loom/planner";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { z } from "zod";
import type { ExpectedGraph, GraphNode } from "./cases";
import { makeCatalog } from "./catalog";

// ── Running one planner case ──────────────────────────────────────────────────
//
// The same model (a cassette) is asked twice, by the two REAL runtimes:
//   1. `IntentRuntime.route(intent)` with the model as its provider → which capability handles the intent. The
//      router falls back to its offline keyword matcher whenever the model's answer names no capability, which would
//      score a model failure as if the model had routed: the route is therefore only counted when `rationale` says
//      "model routed" (or the model said NONE and the keyword matcher found nothing either).
//   2. `PlannerRuntime.planGraph(ctx, …)` inside a real `WorkflowRuntime`, with the model behind the ring as a
//      registered `createAgentModelEffect` (`effectPlanModel`), journaled through `ctx.decide`. There is no silent
//      fallback here: an unusable plan is a typed `PlanFailedError`, reported as `refused:<reason>`.

export interface PlannerOutcome {
  /** The routed capability id, or null. */
  readonly route: string | null;
  /** How it was decided: the model, the offline keyword fallback, or no route at all. */
  readonly routedBy: "model" | "keyword" | "none";
  /** The planned graph in canonical form, or `refused:<reason>`. */
  readonly graph: ExpectedGraph;
  /** Model calls the whole case made (route + plan attempts). */
  readonly modelCalls: number;
  readonly error?: string;
}

const FLOW: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "plan-intent",
  name: "plan-intent",
  version: "1.0.0",
  inputSchema: z.any(),
  outputSchema: z.any(),
  steps: [],
};

const sortedKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortedKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, sortedKeys(x)])
    );
  }
  return v;
};

/** The canonical, comparable form of a plan: ids, capability, args (keys sorted), sorted dependsOn. No rationale. */
export function canonicalGraph(plan: PlanGraph): GraphNode[] {
  return plan.nodes.map((n) => ({
    id: n.id,
    capabilityId: n.capabilityId,
    args: sortedKeys(n.args ?? {}) as Record<string, unknown>,
    dependsOn: [...(n.dependsOn ?? [])].sort(),
  }));
}

/** Exact structural equality of two graphs (node order included), key order irrelevant. */
export function sameGraph(a: ExpectedGraph, b: ExpectedGraph): boolean {
  return JSON.stringify(sortedKeys(a)) === JSON.stringify(sortedKeys(b));
}

export async function runPlannerCase(
  intent: string,
  provider: LlmProvider & { misses?: readonly string[] }
): Promise<PlannerOutcome> {
  const catalog = makeCatalog();
  let modelCalls = 0;
  const counted: LlmProvider = {
    async complete(req) {
      modelCalls++;
      return provider.complete(req);
    },
  };

  // 1. routing
  const route = await new IntentRuntime({ catalog, provider: counted }).route(intent);
  const routedBy =
    route === null ? "none" : route.rationale === "model routed" ? "model" : "keyword";

  // 2. planning
  const effects = new EffectRuntime();
  effects.register("plan-model", createAgentModelEffect(counted));
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const planner = new PlannerRuntime({ catalog });
  let graph: ExpectedGraph = "refused:unknown";
  let error: string | undefined;
  const runner: FlowRunner<unknown, unknown> = async (ctx) => {
    try {
      graph = canonicalGraph(
        await planner.planGraph(ctx, { goal: intent, model: effectPlanModel("plan-model") })
      );
    } catch (e) {
      if (e instanceof PlanFailedError) graph = `refused:${e.reason}`;
      else error = String((e as Error)?.message ?? e).slice(0, 300);
    }
    return {};
  };
  runtime.registerFlow(FLOW, runner);
  const handle = await runtime.start(FLOW, {});
  await handle.waitForCompletion();

  // A cassette MISS never reads as a planning failure (the model effect swallows it into a failed run): rethrow.
  const miss = provider.misses?.[0];
  if (miss !== undefined) throw new CassetteMissError(miss);
  return {
    route: route?.capability.id ?? null,
    routedBy,
    graph,
    modelCalls,
    ...(error !== undefined && { error }),
  };
}
