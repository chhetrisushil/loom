import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentLoop$ } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";

// ── R1 — the claim under test: a crash at turn N costs turn N ────────────────
//
// `agentStep$` makes forty model calls and N tool calls ONE frame, so a crash at
// turn 39 re-runs all 39 — the cost this construct exists to remove. The proof is
// the ADR 0061 crash matrix `interpreterLoop.test.ts` applies to the interpreter
// pattern: kill the process after k durable turns, recover, and assert that only
// the UNFINISHED work re-invokes an effect.
//
// Crash simulation is prefix construction: a death after k turns leaves
// EXECUTION_STARTED + the events of those turns durable, with no terminal event.
// Recovery folds that prefix and re-dispatches; the identity rule guarantees the
// re-run re-derives the same `#turn:<i>` sequence from logged inputs, so every
// completed task is served from the log.

const lookup = tool$({
  id: "lookup",
  name: "Lookup",
  description: "Looks up",
  kind: "tool",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
});

const dbAgent = agent$({ id: "dba", name: "DBA", tools: [lookup] });

/** Three turns: two tool-calling, then an answer. */
function scriptedProvider(calls: { n: number }): LlmProvider {
  const responses: LlmResponse[] = [
    {
      content: "t0",
      toolCalls: [{ id: "a", name: "lookup", input: { i: 0 } }],
      stopReason: "tool_use",
    },
    {
      content: "t1",
      toolCalls: [{ id: "b", name: "lookup", input: { i: 1 } }],
      stopReason: "tool_use",
    },
    { content: "final", stopReason: "end_turn" },
  ];
  return {
    async complete(request) {
      // Which turn this is, derived from how many assistant messages the loop has
      // fed back — so a REPLAYED call would return the same thing it did before.
      const turn = request.messages.filter((m) => m.role === "assistant").length;
      calls.n++;
      return responses[Math.min(turn, responses.length - 1)] as LlmResponse;
    },
  };
}

const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "ask",
  name: "ask",
  version: "1.0.0",
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ content: z.string() }),
  // The loop's tasks are dynamic — deliberately outside the static list, exactly
  // like the interpreter pattern.
  steps: [],
};

function boot(eventStore = new InMemoryAsyncEventStore()) {
  const modelCalls = { n: 0 };
  const toolCalls: unknown[] = [];
  const effects = new EffectRuntime();
  effects.register("model", createAgentModelEffect(scriptedProvider(modelCalls)));
  effects.register(
    "lookup",
    new ToolEffect(async (input) => {
      toolCalls.push(input);
      return { ok: true };
    })
  );

  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });

  const runner: FlowRunner<{ prompt: string }, { content: string }> = async (ctx, input) => {
    const out = await agentLoop$(
      ctx,
      { definition: dbAgent, modelToolId: "model", systemPrompt: "be terse" },
      { prompt: input.prompt }
    );
    return { content: out.content };
  };
  runtime.registerFlow(flowDef, runner as FlowRunner<unknown, unknown>);

  return { runtime, modelCalls, toolCalls, eventStore, flowDef };
}

describe("agentLoop$ is durable per turn (R1)", () => {
  it("runs the loop to an answer, one frame per turn", async () => {
    const { runtime, modelCalls, toolCalls, flowDef } = boot();
    const handle = await runtime.start(flowDef, { prompt: "go" }, { executionId: "ask-1" });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe("completed");
    expect(modelCalls.n).toBe(3);
    expect(toolCalls).toHaveLength(2);
  });

  it("journals each turn as its own task, with identity-rule ids", async () => {
    const { runtime, eventStore, flowDef } = boot();
    const handle = await runtime.start(flowDef, { prompt: "go" }, { executionId: "ask-1" });
    await handle.waitForCompletion();

    const started = (await eventStore.read(handle.executionId))
      .filter((e: EventEnvelope) => e.eventType === "STEP_STARTED")
      .map((e: EventEnvelope) => (e.payload as { stepId: string }).stepId);

    // 3 model turns + 2 tool calls, each its own durable frame — not one opaque
    // step, which is the whole difference from `agentStep$`.
    expect(started).toEqual([
      "dba#turn:0",
      "dba#turn:0:tool:0",
      "dba#turn:1",
      "dba#turn:1:tool:0",
      "dba#turn:2",
    ]);
  });

  it("re-runs ONLY the unfinished turn after a crash", async () => {
    // Build the durable prefix of a run that died partway, then recover onto a
    // fresh process (new effect instances, so the counters start at zero).
    const first = boot();
    const handle = await first.runtime.start(
      first.flowDef,
      { prompt: "go" },
      { executionId: "ask-1" }
    );
    await handle.waitForCompletion();
    const full = await first.eventStore.read(handle.executionId);

    // Kill after turn 0's model call + tool call are durable: keep
    // EXECUTION_STARTED and the first four step events, drop the rest and any
    // terminal event.
    const cutoff = full.findIndex(
      (e: EventEnvelope) => (e.payload as { stepId?: string }).stepId === "dba#turn:1"
    );
    const prefix = full.slice(0, cutoff);

    const crashedStore = new InMemoryAsyncEventStore();
    for (const e of prefix) await crashedStore.append(e);

    const folded = new ReplayVM(prefix, {
      executionId: "ask-1",
      workflowId: "ask",
      workflowVersion: "1.0.0",
    }).getState();
    expect(folded.status).toBe("running"); // a crash, not a failure

    const second = boot(crashedStore);
    const recovered = await second.runtime.restoreFromState(folded);
    const state = await recovered.waitForCompletion();

    expect(state.status).toBe("completed");
    // Turn 0's model call and tool call were served from the log: the recovered
    // process made only the REMAINING two model calls and one tool call.
    expect(second.modelCalls.n).toBe(2);
    expect(second.toolCalls).toHaveLength(1);
  });
});
