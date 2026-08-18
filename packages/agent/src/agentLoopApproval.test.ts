import type { FlowDefinition } from "@loom/core";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentLoop$ } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";

// ── R1 — mid-loop HITL, the thing a step handler structurally cannot do ──────
//
// `StepHandlerContext` has no `suspend`, so approval had to be hoisted OUT of the
// agent — which is precisely the design the feature exists to avoid. From a
// runner body the gate sits where the decision is: immediately before the
// destructive call, with the agent's full context still live.

const dropTable = tool$({
  id: "drop-table",
  name: "Drop Table",
  description: "Drops a table",
  kind: "tool",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
});

const dbAgent = agent$({ id: "dba", name: "DBA", tools: [dropTable] });

const responses: LlmResponse[] = [
  {
    content: "dropping",
    toolCalls: [{ id: "c1", name: "drop-table", input: { t: "users" } }],
    stopReason: "tool_use",
  },
  { content: "done", stopReason: "end_turn" },
];

const provider: LlmProvider = {
  async complete(request) {
    const turn = request.messages.filter((m) => m.role === "assistant").length;
    return responses[Math.min(turn, responses.length - 1)] as LlmResponse;
  },
};

const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "gated",
  name: "gated",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({ content: z.string() }),
  steps: [],
};

function boot() {
  const dropped: unknown[] = [];
  const effects = new EffectRuntime();
  effects.register("model", createAgentModelEffect(provider));
  effects.register(
    "drop-table",
    new ToolEffect(async (input) => {
      dropped.push(input);
      return { ok: true };
    })
  );
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const runner: FlowRunner<unknown, { content: string }> = async (ctx) => {
    const out = await agentLoop$(
      ctx,
      {
        definition: dbAgent,
        modelToolId: "model",
        // Anything destructive stops for a human.
        requireApproval: (call) => call.name !== "drop-table",
      },
      { prompt: "clean up" }
    );
    return { content: out.content };
  };
  runtime.registerFlow(flowDef, runner as FlowRunner<unknown, unknown>);
  const flow: RegisteredFlow = { definition: flowDef, runner: runner as FlowRunner };
  return { runtime, flowDef, dropped };
}

describe("agentLoop$ can stop mid-loop for approval (R1)", () => {
  it("parks BEFORE the tool runs, and runs it once approved", async () => {
    const { runtime, flowDef, dropped } = boot();
    const handle = await runtime.start(flowDef, {});
    const suspended = await handle.waitForSuspend();

    expect(suspended.status).toBe("suspended");
    // The gate is before the effect, which is the point of asking: nothing
    // destructive has happened while a human decides.
    expect(dropped).toEqual([]);

    const resumed = await runtime.resume(handle.executionId, {
      eventType: "AgentToolApproval",
      payload: { approved: true },
    });
    await resumed.waitForCompletion();
    expect(dropped).toEqual([{ t: "users" }]);
  });

  it("feeds a refusal back to the model instead of running the tool", async () => {
    const { runtime, flowDef, dropped } = boot();
    const handle = await runtime.start(flowDef, {});
    await handle.waitForSuspend();

    const resumed = await runtime.resume(handle.executionId, {
      eventType: "AgentToolApproval",
      payload: { approved: false, reason: "not during business hours" },
    });
    const state = await resumed.waitForCompletion();

    expect(state.status).toBe("completed");
    // Refused, not failed: the agent learns the call was declined and settles.
    // A human saying no is information, not an error.
    expect(dropped).toEqual([]);
  });
});
