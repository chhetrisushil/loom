import type { EventEnvelope, ExecutionState, FlowDefinition, ToolDefinition } from "@loom/core";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentLoop$ } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";

// ADR 0138 D8 - folded state / snapshot bytes of an uncompacted agentLoop$ at 50 and 200 turns, with
// payloads JSON-CLONED the way a durable store clones them, and the resume read (parse the latest
// snapshot) before/after. "Before" is the old fold reconstructed from the log: the same state with every
// settled frame's STEP_STARTED input put back. Wall-clock numbers are printed, not asserted on (this is a
// *.perf.test.ts: `pnpm test:perf`); the asserted facts are byte counts, which are deterministic.

const tool: ToolDefinition = tool$({
  id: "big",
  name: "big",
  description: "returns a lot",
  inputSchema: z.object({}).passthrough(),
  outputSchema: z.object({}).passthrough(),
});
const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "grow",
  name: "grow",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({}).passthrough(),
  steps: [],
};

/** An in-memory log that JSON-clones on the way in and out, as a durable store does. */
class CloningEventStore extends InMemoryAsyncEventStore {
  override async append(e: EventEnvelope): Promise<void> {
    return super.append(JSON.parse(JSON.stringify(e)) as EventEnvelope);
  }
  override async read(id: string): Promise<EventEnvelope[]> {
    return JSON.parse(JSON.stringify(await super.read(id))) as EventEnvelope[];
  }
}

async function runTurns(turns: number) {
  const provider: LlmProvider = {
    async complete(r): Promise<LlmResponse> {
      const n = r.messages.filter((m) => m.role === "assistant").length;
      return n < turns
        ? {
            content: `t${n}`,
            toolCalls: [{ id: `c${n}`, name: "big", input: {} }],
            stopReason: "tool_use",
          }
        : { content: "done", stopReason: "end_turn" };
    },
  };
  const effects = new EffectRuntime([], {});
  effects.register("model", createAgentModelEffect(provider));
  effects.register("big", new ToolEffect(async () => ({ data: "x".repeat(1000) })));
  const store = new CloningEventStore();
  const runtime = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    scopes: true,
  });
  const runner: FlowRunner<unknown, unknown> = async (ctx) =>
    agentLoop$(
      ctx,
      {
        definition: agent$({ id: "a", name: "A", tools: [tool] }),
        modelToolId: "model",
        maxIterations: turns + 5,
        onWarn: () => {},
      },
      { prompt: "go" }
    );
  runtime.registerFlow(flowDef, runner);
  await (await runtime.start(flowDef, {}, { executionId: "e" })).waitForCompletion();
  return store.read("e");
}

/** The pre-1.26 fold: today's state with each settled frame's STEP_STARTED input put back. */
function legacyState(events: EventEnvelope[], state: ExecutionState): ExecutionState {
  const inputs = new Map<string, unknown>();
  for (const e of events) {
    if (e.eventType !== "STEP_STARTED") continue;
    const p = e.payload as { stepId: string; input?: unknown };
    if (p.input !== undefined) inputs.set(p.stepId, p.input);
  }
  const frames = Object.fromEntries(
    Object.entries(state.frames).map(([id, f]) => [
      id,
      inputs.has(id) ? { ...f, input: inputs.get(id) } : f,
    ])
  );
  return { ...state, frames };
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

describe("ADR 0138 D8 - folded state size and resume read, 50 vs 200 turns", () => {
  it("state is linear in turns; the old fold was quadratic", async () => {
    const rows: Array<Record<string, string | number>> = [];
    const bytes: Record<number, { now: number; before: number }> = {};
    for (const turns of [50, 200]) {
      const events = await runTurns(turns);
      const state = new ReplayVM(events).getState();
      const old = legacyState(events, state);
      const nowJson = JSON.stringify(state);
      const oldJson = JSON.stringify(old);
      const time = (json: string) => {
        const samples: number[] = [];
        for (let i = 0; i < 9; i++) {
          const t0 = performance.now();
          JSON.parse(json);
          samples.push(performance.now() - t0);
        }
        return median(samples);
      };
      bytes[turns] = { now: nowJson.length, before: oldJson.length };
      rows.push({
        turns,
        "state before": kb(oldJson.length),
        "state after": kb(nowJson.length),
        "log (cloned)": kb(JSON.stringify(events).length),
        "resume parse before ms": Number(time(oldJson).toFixed(2)),
        "resume parse after ms": Number(time(nowJson).toFixed(2)),
      });
    }
    console.table(rows);
    // the fold change: after is far smaller, and grows ~linearly (x4 turns => about x4, not x16)
    expect(bytes[200]!.now).toBeLessThan(bytes[200]!.before / 10);
    expect(bytes[200]!.now / bytes[50]!.now).toBeLessThan(6);
    expect(bytes[200]!.before / bytes[50]!.before).toBeGreaterThan(10);
  }, 120_000);
});
