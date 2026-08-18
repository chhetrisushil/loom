import type { FlowDefinition } from "@loom/core";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import { ReasoningRuntime } from "@loom/reasoning";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentLoop$ } from "./agentLoop$";

// ── Routing choices are RECORDED decisions, not hand-emitted facts ───────────
//
// `AgentRunner` fakes the seam: it builds a local `decide` that runs the decider
// and hand-emits DECISION_RECORDED through `emit`. That is a fact in the log —
// and it is NOT served on replay, so a re-run re-routes. If routing improves
// run-to-run (which is the whole point of a Reasoning Runtime), the replayed run
// can take a DIFFERENT route than the one whose answer is recorded.
//
// This is the exact failure the `learning-router` example exists to demonstrate:
// a bare log that LOOKS scored while being unevaluable.
//
// From a runner body the real seam is in reach. `reason()` already accepts a
// `decide`; passing `ctx.decide` makes the route and every elevation a durable,
// replay-served decision.

const lookup = tool$({
  id: "lookup",
  name: "Lookup",
  description: "Looks up",
  kind: "tool",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
});

const answer: LlmResponse = { content: "answered", stopReason: "end_turn" };

/** Records which model answered, so a re-route is visible. */
function routeProvider(id: string, used: string[]): LlmProvider {
  return {
    async complete() {
      used.push(id);
      return answer;
    },
  };
}

function boot(opts: { flip?: { value: boolean }; eventStore?: InMemoryAsyncEventStore }) {
  const used: string[] = [];
  const reasoning = new ReasoningRuntime({
    routes: [
      { id: "cheap", provider: routeProvider("cheap", used), tier: 0 },
      { id: "strong", provider: routeProvider("strong", used), tier: 2 },
    ],
    // A router whose answer CHANGES between runs — a stand-in for one that
    // learns. Without the seam, a replay re-runs it and can pick differently.
    router: {
      select(_req, routes) {
        const pick = opts.flip?.value === true ? "strong" : "cheap";
        if (opts.flip !== undefined) {
          opts.flip.value = !opts.flip.value;
        }
        return routes.find((r) => r.id === pick) ?? (routes[0] as (typeof routes)[number]);
      },
    },
  });

  const runtime = new WorkflowRuntime({
    eventStore: opts.eventStore ?? new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });
  const flowDef: FlowDefinition = {
    _tag: "FlowDefinition",
    id: "ask",
    name: "ask",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.object({ content: z.string() }),
    steps: [],
  };
  const runner: FlowRunner<unknown, { content: string }> = async (ctx) => {
    const out = await agentLoop$(
      ctx,
      { definition: agent$({ id: "dba", name: "DBA", tools: [lookup] }), reasoning },
      { prompt: "go" }
    );
    return { content: out.content };
  };
  runtime.registerFlow(flowDef, runner as FlowRunner<unknown, unknown>);
  return { runtime, flowDef, used };
}

describe("the loop routes through the decision seam", () => {
  it("records the route as a served decision", async () => {
    const store = new InMemoryAsyncEventStore();
    const { runtime, flowDef, used } = boot({ eventStore: store });
    const handle = await runtime.start(flowDef, {}, { executionId: "r1" });
    await handle.waitForCompletion();

    expect(used).toEqual(["cheap"]);
    const decisions = (await store.read("r1")).filter((e) => e.eventType === "DECISION_RECORDED");
    // The route is a real decision — not a hand-emitted fact that replay ignores.
    expect(JSON.stringify(decisions)).toContain("cheap");
    expect(JSON.stringify(decisions)).toContain("route");
  });

  it("a replay takes the route that ran, not the route the router would pick now", async () => {
    const store = new InMemoryAsyncEventStore();
    const flip = { value: false };
    const first = boot({ flip, eventStore: store });
    const handle = await first.runtime.start(first.flowDef, {}, { executionId: "r1" });
    await handle.waitForCompletion();
    expect(first.used).toEqual(["cheap"]);

    // Recover from the prefix. The router would now answer "strong"; the seam
    // must override it with the recorded choice.
    const events = await store.read("r1");
    const replayStore = new InMemoryAsyncEventStore();
    for (const e of events.slice(0, 2)) await replayStore.append(e);

    const second = boot({ flip, eventStore: replayStore });
    const folded = await second.runtime.loadState("r1");
    if (folded === null) throw new Error("no state");
    const resumed = await second.runtime.restoreFromState(folded);
    await resumed.waitForCompletion();

    expect(second.used).toEqual(["cheap"]);
  });

  it("requires one of `reasoning` or `modelToolId`", async () => {
    // An absent model access is a configuration error, refused up front — not a
    // loop that runs zero turns and returns an empty answer.
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
    });
    const flowDef: FlowDefinition = {
      _tag: "FlowDefinition",
      id: "bad",
      name: "bad",
      version: "1.0.0",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      steps: [],
    };
    const runner: FlowRunner<unknown, unknown> = async (ctx) =>
      agentLoop$(ctx, { definition: agent$({ id: "a", name: "A", tools: [] }) }, { prompt: "x" });
    runtime.registerFlow(flowDef, runner);
    const handle = await runtime.start(
      { definition: flowDef, runner } as RegisteredFlow,
      {},
      { executionId: "bad-1" }
    );
    const state = await handle.waitForCompletion().catch(() => runtime.loadState("bad-1"));
    expect(state?.status).toBe("failed");
  });
});
