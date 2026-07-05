import { AgentRunner } from "@loom/agent";
import type { EffectContext } from "@loom/effect-runtime";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import { DiagnosticsAgent } from "./definitions";
import { fetchMetrics } from "./tools";

// A scripted provider that drives a real two-turn ReAct loop: first the model
// asks to call the db-metrics tool, then it reasons over the result and answers.
// Isolated here so the loop is deterministic while still exercising the genuine
// AgentRunner code path (tool dispatch, AGENT_TOOL_CALL events, iteration count).
class DiagnosticsScript implements LlmProvider {
  private turn = 0;

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.turn++;
    if (this.turn === 1) {
      const target = readTarget(request);
      return {
        content: "Pulling live metrics before I commit to a root cause.",
        toolCalls: [{ id: "call-1", name: "db-metrics", input: { target } }],
        stopReason: "tool_use",
      };
    }
    return {
      content:
        "CPU is pinned at 91% with the connection pool fully saturated (200/200). Queued " +
        "queries are spinning on lock acquisition — classic connection-pool starvation. " +
        "Recommend recycling the pool and raising its ceiling.",
      stopReason: "end_turn",
    };
  }
}

function readTarget(request: LlmRequest): string {
  const match = /target[^a-z0-9]*([a-z0-9-]+)/i.exec(
    request.messages.map((m) => m.content).join(" ")
  );
  return match?.[1] ?? "prod-postgres";
}

// One AgentRunner + EffectRuntime, built once. The runner's tool calls resolve
// against this EffectRuntime, where the db-metrics tool is registered.
const agentEffects = new EffectRuntime();
agentEffects.register(
  "db-metrics",
  new ToolEffect(async (input: unknown) => fetchMetrics((input as { target: string }).target))
);

const runner = new AgentRunner({
  definition: DiagnosticsAgent,
  provider: new DiagnosticsScript(),
  effectRuntime: agentEffects,
  systemPrompt:
    "You are a senior database SRE. Use the metrics tool, then give a crisp root cause.",
});

export interface DiagnosticsResult {
  rootCause: string;
  metrics: { cpuPct: number; memPct: number; poolUsed: number; poolMax: number; qps: number };
  iterations: number;
  toolCalls: number;
}

// Runs the diagnostics agent's ReAct loop for a target. The passed EffectContext
// is the workflow step's context, so AGENT_TOOL_CALL / AGENT_COMPLETED events
// land in the same durable event stream as the rest of the step.
export async function runDiagnosticsAgent(
  target: string,
  ctx: EffectContext
): Promise<DiagnosticsResult> {
  const output = await runner.run(
    { prompt: `Diagnose the performance incident on target ${target}.` },
    ctx
  );
  const metricsCall = output.toolCallLog.find((t) => t.toolName === "db-metrics");
  const metrics =
    (metricsCall?.toolOutput as DiagnosticsResult["metrics"] | undefined) ?? fetchMetrics(target);
  return {
    rootCause: output.content,
    metrics,
    iterations: output.iterations,
    toolCalls: output.toolCallLog.length,
  };
}
