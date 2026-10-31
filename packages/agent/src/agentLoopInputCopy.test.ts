import type { FlowDefinition, ToolDefinition } from "@loom/core";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentLoop$ } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";

// Issue #722: `agentLoop$` kept pushing to the array it had handed the kernel as a turn step's input, so a
// store that serializes a payload AFTER `append` returned (any await between the call and the write) recorded
// every turn's input as the transcript the run had grown into, not what the model was sent.

const tool: ToolDefinition = tool$({
  id: "look",
  name: "look",
  description: "look",
  inputSchema: z.object({}).passthrough(),
  outputSchema: z.object({}).passthrough(),
});
const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "copy",
  name: "copy",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({}).passthrough(),
  steps: [],
};
const TURNS = 5;

/**
 * An event store that serializes each payload one macrotask AFTER `append` is called (a hook, not a sleep:
 * `setImmediate` runs once the microtask queue has drained, i.e. after the loop has pushed more messages). A
 * durable store that clones asynchronously, or hands the object to a worker/driver, behaves this way.
 */
class LateSerializingStore extends InMemoryAsyncEventStore {
  override async append(e: Parameters<InMemoryAsyncEventStore["append"]>[0]) {
    await new Promise<void>((r) => setImmediate(r));
    return super.append(JSON.parse(JSON.stringify(e)));
  }
}

async function recordedTurnInputs(store: InMemoryAsyncEventStore) {
  const modelRequestLengths: number[] = [];
  const provider: LlmProvider = {
    async complete(r): Promise<LlmResponse> {
      modelRequestLengths.push(r.messages.length);
      const n = r.messages.filter((m) => m.role === "assistant").length;
      return n < TURNS
        ? {
            content: `t${n}`,
            toolCalls: [{ id: `c${n}`, name: "look", input: {} }],
            stopReason: "tool_use",
          }
        : { content: "done", stopReason: "end_turn" };
    },
  };
  const effects = new EffectRuntime([], {});
  effects.register("model", createAgentModelEffect(provider));
  effects.register("look", new ToolEffect(async () => ({ ok: true })));
  const runtime = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    divergence: "fail",
  });
  const runner: FlowRunner<unknown, unknown> = async (ctx) =>
    agentLoop$(
      ctx,
      {
        definition: agent$({ id: "a", name: "A", tools: [tool] }),
        modelToolId: "model",
        maxIterations: 20,
      },
      { prompt: "go" }
    );
  runtime.registerFlow(flowDef, runner);
  const done = await (await runtime.start(flowDef, {}, { executionId: "e1" })).waitForCompletion();
  expect(done.status).toBe("completed");
  const turnInputs = (await store.read("e1"))
    .filter(
      (e) =>
        e.eventType === "STEP_STARTED" &&
        /^a#turn:\d+$/.test((e.payload as { stepId: string }).stepId)
    )
    .map((e) => (e.payload as { input: { messages: unknown[] } }).input.messages.length);
  return { turnInputs, modelRequestLengths };
}

describe("agentLoop$ journals what each turn sent (issue #722)", () => {
  it("a store that serializes after append records the transcript as the model saw it, per turn", async () => {
    const { turnInputs, modelRequestLengths } = await recordedTurnInputs(
      new LateSerializingStore()
    );
    const sent = [1, 3, 5, 7, 9, 11];
    expect(modelRequestLengths).toEqual(sent);
    expect(turnInputs).toEqual(sent);
  });

  it("an aliasing in-memory store records the same per-turn lengths", async () => {
    const { turnInputs } = await recordedTurnInputs(new InMemoryAsyncEventStore());
    expect(turnInputs).toEqual([1, 3, 5, 7, 9, 11]);
  });
});
