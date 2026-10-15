import type { FlowDefinition } from "@loom/core";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, recoverAbandoned } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentLoop$ } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";

// ── K9.3 holds for agentLoop$ (the supported path for idempotent:false tools) ────────────────────
// Every tool call is its own frame, so a crash after the tool ran (and before its STEP_COMPLETED) leaves
// a durable STEP_STARTED; a fresh process parks EFFECT_INDOUBT instead of re-firing the tool.

const charge = tool$({
  id: "charge",
  name: "Charge",
  description: "Charges a card",
  kind: "tool",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
});
const agent = agent$({ id: "biller", name: "Biller", tools: [charge] });

const until = async (cond: () => Promise<boolean> | boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};

const provider: LlmProvider = {
  async complete(request) {
    const turn = request.messages.filter((m) => m.role === "assistant").length;
    const r: LlmResponse =
      turn === 0
        ? {
            content: "t0",
            toolCalls: [{ id: "a", name: "charge", input: {} }],
            stopReason: "tool_use",
          }
        : { content: "final", stopReason: "end_turn" };
    return r;
  },
};

const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "bill",
  name: "bill",
  version: "1.0.0",
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ content: z.string() }),
  steps: [],
};

function boot(store: InMemoryAsyncEventStore, hang: boolean) {
  const ran = { n: 0 };
  const effects = new EffectRuntime();
  effects.register("model", createAgentModelEffect(provider));
  effects.register(
    "charge",
    new ToolEffect(
      async () => {
        ran.n++;
        // The process dies while the external effect is in flight.
        if (hang) await new Promise<void>(() => {});
        return {};
      },
      { idempotent: false }
    )
  );
  const runtime = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    onWarn: () => {},
  });
  const runner: FlowRunner<{ prompt: string }, { content: string }> = async (ctx, input) => {
    const out = await agentLoop$(
      ctx,
      { definition: agent, modelToolId: "model" },
      { prompt: input.prompt }
    );
    return { content: out.content };
  };
  runtime.registerFlow(flowDef, runner as FlowRunner<unknown, unknown>);
  return { runtime, ran };
}

describe("agentLoop$ + idempotent:false tool: crash after the tool ran", () => {
  it("recovery in a fresh runtime parks EFFECT_INDOUBT and never re-fires the tool", async () => {
    const durable = new InMemoryAsyncEventStore();
    const a = boot(durable, true);
    void a.runtime.start(flowDef, { prompt: "go" }, { executionId: "bill-1" });
    await until(() => a.ran.n === 1, "the tool to run in process A");
    const types = async () => (await durable.read("bill-1")).map((e) => e.eventType);
    await until(async () => (await types()).includes("STEP_STARTED"), "a durable STEP_STARTED");
    expect(await types()).not.toContain("EXECUTION_COMPLETED");

    const b = boot(durable, false);
    await recoverAbandoned(b.runtime, { source: durable, isAbandoned: () => true });
    expect(await types()).toContain("EFFECT_INDOUBT");
    expect(b.ran.n).toBe(0);
    expect(a.ran.n).toBe(1);
  });
});
