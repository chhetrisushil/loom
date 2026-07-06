import { AgentRunner } from "@loom/agent";
import type { EffectContext } from "@loom/effect-runtime";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import { SchemaInspectorAgent } from "./definitions";
import { inspectTable } from "./tools";

// A scripted provider that drives a real two-turn ReAct loop: first the model
// asks to call the inspect-table tool, then it reasons over the result and
// answers. Isolated here so the loop is deterministic while still exercising the
// genuine AgentRunner code path (tool dispatch, AGENT_TOOL_CALL events, iteration
// count).
class SchemaInspectorScript implements LlmProvider {
  private turn = 0;

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.turn++;
    if (this.turn === 1) {
      const target = readTarget(request);
      return {
        content: "Inspecting the table before I recommend a migration approach.",
        toolCalls: [{ id: "call-1", name: "inspect-table", input: { target } }],
        stopReason: "tool_use",
      };
    }
    return {
      content:
        "The orders table holds ~40M rows (48 GB) with 3 indexes and 2 FK constraints, under " +
        "~1200 writes/sec. A blocking ALTER would hold a write lock for the full rewrite (~7 min) " +
        "— unacceptable on a hot table. This needs an online, chunked, or dual-write strategy.",
      stopReason: "end_turn",
    };
  }
}

function readTarget(request: LlmRequest): string {
  const match = /target[^a-z0-9]*([a-z0-9-]+)/i.exec(
    request.messages.map((m) => m.content).join(" ")
  );
  return match?.[1] ?? "orders";
}

// One AgentRunner + EffectRuntime, built once. The runner's tool calls resolve
// against this EffectRuntime, where the inspect-table tool is registered.
const agentEffects = new EffectRuntime();
agentEffects.register(
  "inspect-table",
  new ToolEffect(async (input: unknown) => inspectTable((input as { target: string }).target))
);

const runner = new AgentRunner({
  definition: SchemaInspectorAgent,
  provider: new SchemaInspectorScript(),
  effectRuntime: agentEffects,
  systemPrompt:
    "You are a senior database engineer. Inspect the table, then give a crisp migration analysis.",
});

export interface SchemaAnalysis {
  summary: string;
  stats: {
    rowCount: number;
    sizeGb: number;
    indexes: number;
    fkConstraints: number;
    writeQps: number;
  };
  iterations: number;
  toolCalls: number;
}

// Runs the schema-inspector agent's ReAct loop for a target table. The passed
// EffectContext is the workflow step's context, so AGENT_TOOL_CALL /
// AGENT_COMPLETED events land in the same durable event stream as the rest of the
// step.
export async function runSchemaInspectorAgent(
  target: string,
  ctx: EffectContext
): Promise<SchemaAnalysis> {
  const output = await runner.run(
    { prompt: `Analyze the schema-migration target table ${target}.` },
    ctx
  );
  const call = output.toolCallLog.find((t) => t.toolName === "inspect-table");
  const stats = (call?.toolOutput as SchemaAnalysis["stats"] | undefined) ?? inspectTable(target);
  return {
    summary: output.content,
    stats,
    iterations: output.iterations,
    toolCalls: output.toolCallLog.length,
  };
}
