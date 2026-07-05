import { createA2AClientEffect, createA2AServer, toAgentCard } from "@loom/a2a";
import { a2uiSurfaceProjection } from "@loom/a2ui";
import { AgentRunner } from "@loom/agent";
import { CapabilityCatalog } from "@loom/capability";
import { agent$, flow$, handler$, memory$, step$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { IntentRuntime } from "@loom/intent";
import { McpClient } from "@loom/mcp";
import { MemoryRuntime } from "@loom/memory";
import { PlannerRuntime } from "@loom/planner";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { AgentRegistry } from "@loom/registry";
import { TerminalRenderer } from "@loom/renderer-terminal";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
/**
 * Agent Network — a server-side showcase of Loom's agentic capabilities.
 *
 * Demonstrates, end to end and fully offline:
 *   1. Configurable LLM      — swap ScriptedLlmProvider for AnthropicProvider/OpenAiProvider
 *   2. Bring-your-own agent  — agent$() + AgentRunner ReAct loop over your tools
 *   3. MCP servers/tools     — McpClient discovers tools and registers them as effects
 *   4. A2A out of the box    — expose a flow as an A2A agent, then call it as a client
 *   5. Capabilities + Intent — a catalog of capabilities, routed to by intent (not routes)
 *   6. Planner               — turn a goal into an ordered capability plan
 *   7. Agent memory          — an agent that recalls prior turns
 *   8. Multi-surface         — render one blueprint to the terminal surface
 *
 * Run with:  pnpm --filter @loom/agent-network start
 */
import { z } from "zod";
import { ScriptedLlmProvider } from "./ScriptedLlmProvider";
import { incidentBlueprint, investigateCapability, scaleCapability } from "./capabilities";
import { startFakeMcpServer } from "./fakeMcpServer";
import { InMemoryEventStore, InMemorySnapshotStore } from "./stores";

function section(title: string): void {
  console.log(`\n${"─".repeat(64)}\n  ${title}\n${"─".repeat(64)}`);
}

async function main(): Promise<void> {
  const effectRuntime = new EffectRuntime();

  // ══ 1. Configurable LLM ═════════════════════════════════════════════════════
  // The provider is the only place the model is chosen. Everything else is
  // provider-agnostic. Here we script it so the demo is deterministic; in
  // production this line becomes `new AnthropicProvider({ model: "claude-opus-4-8" })`.
  section("1. Configurable LLM provider");
  const provider = new ScriptedLlmProvider([
    {
      content: "I'll consult the runbook for the CPU spike.",
      toolCalls: [{ id: "c1", name: "kb-lookup", input: { topic: "database CPU spike" } }],
      stopReason: "tool_use",
    },
    {
      content:
        "Per runbook RB-204, restart the pod and scale the connection pool. " +
        "Root cause is connection-pool starvation.",
      stopReason: "end_turn",
    },
  ]);
  console.log("Provider ready (ScriptedLlmProvider — swap for AnthropicProvider to go live).");

  // ══ 3. MCP servers/tools ════════════════════════════════════════════════════
  // Connect to an MCP server, discover its tools, and register them as effects.
  // The agent can then call them by name like any other tool.
  section("3. MCP tool discovery");
  const mcp = await startFakeMcpServer();
  const mcpClient = new McpClient({ transport: "http", url: mcp.url });
  await mcpClient.connect();
  const mcpDefs = await mcpClient.registerInto(effectRuntime);
  console.log(`Discovered ${mcpDefs.length} MCP tool(s):`, mcpDefs.map((d) => d.id).join(", "));

  // ══ 2. Bring-your-own agent ═════════════════════════════════════════════════
  // Define an agent over the discovered tools and run the ReAct loop. The agent
  // reasons, calls the MCP tool, then produces a final answer.
  section("2. Agent ReAct loop (LLM + MCP tools)");
  // Card metadata (version/capabilities/skills) lives on the agent$ definition,
  // so the AgentCard is derived — not hand-authored — via toAgentCard below.
  const opsAgent = agent$({
    id: "ops-agent",
    name: "Ops Triage Agent",
    description: "Triages infrastructure incidents using runbooks",
    tools: mcpDefs,
    version: "1.0.0",
    capabilities: { streaming: false },
    skills: [{ id: "triage", name: "Incident Triage" }],
  });

  const registry = new AgentRegistry();
  registry.register(opsAgent, toAgentCard(opsAgent));

  const runner = new AgentRunner({
    definition: opsAgent,
    provider,
    effectRuntime,
    systemPrompt: "You are an SRE. Use the runbook tools to resolve incidents.",
  });

  const agentOutput = await runner.run(
    { prompt: "The primary database is at 87% CPU and connections are exhausted. What do I do?" },
    { executionId: "demo", stepId: "agent", workflowId: "demo", attempt: 1, emit: () => {} }
  );
  console.log(
    `Agent used ${agentOutput.toolCallLog.length} tool call(s) over ${agentOutput.iterations} iteration(s).`
  );
  console.log("Agent answer:", agentOutput.content);

  // ══ 4. A2A out of the box ═══════════════════════════════════════════════════
  // Expose a Loom flow as an A2A agent, then call it from a client effect. This
  // is how two Loom services (or a Loom service and any A2A-compatible agent)
  // talk to each other over the wire.
  section("4. A2A server + client");

  const triageStep = step$({
    id: "triage",
    name: "Triage",
    inputSchema: z.object({ prompt: z.string() }),
    outputSchema: z.object({ reply: z.string() }),
    handler: handler$(async (input: { prompt: string }) => ({
      reply: `Triage complete for: "${input.prompt}". Recommended: restart pod, scale pool.`,
    })),
  });
  const triageRunner: FlowRunner<{ prompt: string }, { reply: string }> = (ctx, input) =>
    ctx.run(triageStep, { prompt: input.prompt });
  const triageFlow: RegisteredFlow = {
    definition: flow$({
      id: "triage-flow",
      name: "Triage Flow",
      version: "1.0.0",
      inputSchema: z.object({ prompt: z.string() }),
      outputSchema: z.object({ reply: z.string() }),
      steps: [triageStep],
    }),
    runner: triageRunner as FlowRunner<unknown, unknown>,
  };

  const serverRuntime = new WorkflowRuntime({
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });
  serverRuntime.registerFlow(triageFlow.definition, triageFlow.runner);

  // The A2A-fronted agent is a first-class agent$ too; toAgentCard derives its
  // card and createA2AServer overwrites url with the bound address.
  const triageAgent = agent$({
    id: "triage-agent",
    name: "Triage Agent",
    description: "Exposes the triage flow over A2A",
    tools: [],
    version: "1.0.0",
    capabilities: { streaming: false },
    skills: [{ id: "triage", name: "Incident Triage" }],
  });
  const server = createA2AServer(serverRuntime, triageFlow, toAgentCard(triageAgent), { port: 0 });
  await server.start();
  console.log(`A2A agent card: ${server.url}/.well-known/agent.json`);

  // The client is just another effect — call the remote agent by URL.
  const a2aEffect = createA2AClientEffect(server.url, { pollIntervalMs: 50 });
  const result = await a2aEffect.execute(
    { id: "task-1", message: { role: "user", parts: [{ type: "text", text: "DB at 87% CPU" }] } },
    { executionId: "demo", stepId: "call", workflowId: "demo", attempt: 1, emit: () => {} }
  );
  console.log(`A2A task status: ${result.status}`);
  console.log("A2A reply:", result.artifacts?.[0]?.parts[0]?.text);

  // ══ 5. Capabilities + Intent (Intent Over Routes) ═══════════════════════════
  // Build a catalog of capabilities, then let the Intent Runtime route a plain
  // English request to the right one — no routes, no switch statements.
  section("5. Capability catalog + Intent routing");
  const catalog = new CapabilityCatalog().register(investigateCapability).register(scaleCapability);

  const projectionRuntime = new InMemoryProjectionRuntime();
  projectionRuntime.register(a2uiSurfaceProjection("ui"));
  const appRuntime = new WorkflowRuntime({
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
    effectRuntime: new EffectRuntime(),
    onEvent: (e) => projectionRuntime.handleEvent(e),
  });
  catalog.registerInto(appRuntime);

  // No provider passed → deterministic keyword routing (works fully offline).
  const intent = new IntentRuntime({ catalog, workflowRuntime: appRuntime });
  const request = "the prod-postgres database has high CPU, please investigate";
  const route = await intent.route(request);
  console.log(`Request: "${request}"`);
  console.log(`Routed to capability: ${route?.capability.id} (${route?.rationale})`);

  const handle = await intent.run(request, { target: "prod-postgres" });
  await handle.waitForCompletion();
  console.log("Capability executed via IntentRuntime.run().");

  // ══ 6. Planner (goal → ordered capability plan) ═════════════════════════════
  section("6. Planner");
  const planner = new PlannerRuntime({ catalog });
  const plan = await planner.plan("investigate the incident then scale the cluster");
  console.log("Goal:", plan.goal);
  for (const [i, planStep] of plan.steps.entries()) {
    console.log(`  ${i + 1}. ${planStep.capabilityId} — ${planStep.rationale}`);
  }

  // ══ 7. Agent memory (recall across turns) ═══════════════════════════════════
  section("7. Agent memory");
  const memory = new MemoryRuntime().register(
    memory$({ id: "chat", name: "Chat", maxEntries: 20 })
  );
  const chatAgent = agent$({ id: "chat-agent", name: "Chat Agent", tools: [], memoryId: "chat" });
  const chatProvider = new ScriptedLlmProvider([
    { content: "Noted — your cluster is prod-postgres.", stopReason: "end_turn" },
    { content: "Your cluster is prod-postgres.", stopReason: "end_turn" },
  ]);
  const chatRunner = new AgentRunner({
    definition: chatAgent,
    provider: chatProvider,
    effectRuntime,
    memory,
  });
  const chatCtx = { executionId: "c", stepId: "s", workflowId: "w", attempt: 1, emit: () => {} };
  await chatRunner.run({ prompt: "My cluster is prod-postgres", memoryScope: "user-1" }, chatCtx);
  const recalled = await chatRunner.run(
    { prompt: "Which cluster did I mention?", memoryScope: "user-1" },
    chatCtx
  );
  console.log("Second-turn answer (with recall):", recalled.content);
  console.log("Remembered turns:", memory.read("chat", "user-1").length);

  // ══ 8. Multi-surface (render the same blueprint to the terminal) ════════════
  section("8. Terminal surface");
  const terminal = new TerminalRenderer(projectionRuntime);
  console.log(terminal.render(incidentBlueprint, handle.executionId));

  // ══ Cleanup ═════════════════════════════════════════════════════════════════
  await server.stop();
  await mcpClient.disconnect();
  await mcp.close();
  section("Done — full agentic pipeline demonstrated offline.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
