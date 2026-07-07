import { A2APeerClient, createA2AClientEffect, createA2AServer, toAgentCard } from "@loom/a2a";
import { AgentRunner } from "@loom/agent";
import { defineConfig } from "@loom/app";
import { agent$, flow$, handler$, step$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import { AgentRegistry } from "@loom/registry";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { startMockExternalAgent } from "./mockExternalAgent";

/**
 * A2A Mesh — using external agent frameworks (Google ADK, LangGraph, CrewAI, …)
 * WITH Loom, as bidirectional peers over the open A2A protocol.
 *
 *   Outbound (Loom → external):  A2APeerClient discovers a remote agent's card
 *                                and registers it as a Loom tool. A Loom agent
 *                                then calls the external agent mid-reasoning.
 *   Inbound  (external → Loom):  createA2AServer exposes a Loom flow over A2A;
 *                                any A2A client (ADK, a LangGraph shim, another
 *                                Loom service) drives it. Here we loop back with
 *                                createA2AClientEffect to prove the contract.
 *
 * The external peer is a mock A2A server (see mockExternalAgent.ts) so the demo
 * runs fully offline; the README shows how to point it at a real ADK/LangGraph
 * endpoint — the Loom-side code does not change.
 *
 * Run with:  pnpm --filter @loom/a2a-mesh start
 */

function section(title: string): void {
  console.log(`\n${"─".repeat(64)}\n  ${title}\n${"─".repeat(64)}`);
}

// Deterministic provider so the ReAct loop is reproducible offline. In
// production this becomes `new AnthropicProvider({ model: "claude-opus-4-8" })`
// (or OpenAiProvider) — the model is pure configuration.
class ScriptedLlmProvider implements LlmProvider {
  private index = 0;
  constructor(private readonly responses: LlmResponse[]) {}
  async complete(_request: LlmRequest): Promise<LlmResponse> {
    const response = this.responses[this.index] ?? { content: "(done)", stopReason: "end_turn" };
    this.index = Math.min(this.index + 1, this.responses.length);
    return response;
  }
}

async function main(): Promise<void> {
  const effectRuntime = new EffectRuntime();
  const registry = new AgentRegistry();

  // ── The "external" peer (ADK/LangGraph stand-in) ────────────────────────────
  const external = await startMockExternalAgent();
  console.log(`External A2A agent listening at ${external.url}`);

  // ══ Outbound: Loom calls the external agent ═════════════════════════════════
  // Discover the remote agent's card and register it as a first-class Loom tool.
  // Passing the registry also exposes it to the planner/intent layer.
  section("Outbound — Loom agent calls the external peer as a tool");
  const peer = new A2APeerClient({
    url: external.url,
    toolId: "remote-diagnostics",
    pollIntervalMs: 50,
  });
  const remoteTool = await peer.registerInto(effectRuntime, registry);
  console.log(`Registered remote peer as tool "${remoteTool.id}" (kind: ${remoteTool.kind}).`);
  console.log(`Description advertised to the LLM: ${remoteTool.description}`);

  // A local Loom agent whose toolbox includes the remote agent. The scripted
  // provider makes it call the remote tool, then summarize the result.
  const opsAgent = agent$({
    id: "ops-agent",
    name: "Ops Orchestrator",
    description: "Coordinates remediation, delegating diagnosis to a remote agent",
    tools: [remoteTool],
  });

  const provider = new ScriptedLlmProvider([
    {
      content: "This looks like a database incident — I'll ask the diagnostics agent.",
      toolCalls: [
        {
          id: "call-1",
          name: "remote-diagnostics",
          input: { prompt: "prod-postgres at 92% CPU, connections exhausted" },
        },
      ],
      stopReason: "tool_use",
    },
    {
      content:
        "The remote agent diagnosed connection-pool exhaustion. Recycling the pool " +
        "and raising its ceiling; will scale replicas only if CPU stays high.",
      stopReason: "end_turn",
    },
  ]);

  const runner = new AgentRunner({
    definition: opsAgent,
    provider,
    effectRuntime,
    systemPrompt: "You are an SRE orchestrator. Delegate diagnosis to your tools.",
  });

  const agentOutput = await runner.run(
    { prompt: "prod-postgres is at 92% CPU and connections are exhausted. Remediate." },
    { executionId: "mesh-demo", stepId: "ops", workflowId: "mesh-demo", attempt: 1, emit: () => {} }
  );

  const remoteCall = agentOutput.toolCallLog.find((c) => c.toolName === "remote-diagnostics");
  console.log("\nRemote agent replied:");
  console.log(
    `  ${(remoteCall?.toolOutput as { content?: string } | undefined)?.content ?? "(none)"}`
  );
  console.log("\nLoom agent's final answer:");
  console.log(`  ${agentOutput.content}`);

  // ══ Inbound: the external world calls a Loom agent ══════════════════════════
  // Expose a Loom flow over A2A. Any A2A client — ADK, a LangGraph shim, or
  // another Loom service — can now drive it. We loop back with a client effect.
  section("Inbound — external client drives a Loom agent over A2A");

  const remediateStep = step$({
    id: "remediate",
    name: "Remediate",
    inputSchema: z.object({ prompt: z.string() }),
    outputSchema: z.object({ reply: z.string() }),
    handler: handler$(async (input: { prompt: string }) => ({
      reply: `Loom remediation for "${input.prompt}": pool recycled, ceiling raised, incident resolved.`,
    })),
  });
  const remediateRunner: FlowRunner<{ prompt: string }, { reply: string }> = (ctx, input) =>
    ctx.run(remediateStep, { prompt: input.prompt });
  const remediateFlow: RegisteredFlow = {
    definition: flow$({
      id: "remediate-flow",
      name: "Remediate Flow",
      version: "1.0.0",
      inputSchema: z.object({ prompt: z.string() }),
      outputSchema: z.object({ reply: z.string() }),
      steps: [remediateStep],
    }),
    runner: remediateRunner as FlowRunner<unknown, unknown>,
  };

  // Composition root for the inbound A2A server: defineConfig assembles the
  // in-memory stores, EffectRuntime, projection runtime, and WorkflowRuntime,
  // and registers the remediation flow. The outbound EffectRuntime above is a
  // separate concern (it backs the AgentRunner, not a WorkflowRuntime).
  const app = defineConfig({
    storage: { kind: "memory" },
    flows: [remediateFlow],
  });

  const remediateAgent = agent$({
    id: "remediation-agent",
    name: "Remediation Agent",
    description: "Exposes the Loom remediation flow over A2A",
    tools: [],
    version: "1.0.0",
    capabilities: { streaming: false },
    skills: [{ id: "remediate", name: "Remediate" }],
  });
  const server = createA2AServer(app.runtime, remediateFlow, toAgentCard(remediateAgent), {
    port: 0,
  });
  await server.start();
  console.log(`Loom agent card served at ${server.url}/.well-known/agent.json`);

  // The "external framework" calling in — here, a plain A2A client effect.
  const inbound = createA2AClientEffect(server.url, { pollIntervalMs: 50 });
  const result = await inbound.execute(
    {
      id: "task-in-1",
      message: { role: "user", parts: [{ type: "text", text: "connection-pool exhaustion" }] },
    },
    {
      executionId: "mesh-demo",
      stepId: "call-in",
      workflowId: "mesh-demo",
      attempt: 1,
      emit: () => {},
    }
  );
  console.log(`Inbound A2A task status: ${result.status}`);
  console.log(`Loom replied: ${result.artifacts?.[0]?.parts[0]?.text}`);

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  await server.stop();
  await external.close();
  await app.close();
  section("Done — bidirectional A2A mesh demonstrated offline.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
