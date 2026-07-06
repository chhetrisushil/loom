import type { AgentCard } from "@loom/a2a";
import { toAgentCard } from "@loom/a2a";
import { agent$ } from "@loom/core";
import type { AgentDefinition } from "@loom/core";
import { EstimateMigrationTool, InspectTableTool, RunMigrationTool } from "./tools";

// ── The domain-specialist fleet ───────────────────────────────────────────────
//
// Three long-running, domain-specific agents. Each is a first-class agent$
// (its own tools) and advertises an A2A AgentCard, so it can be discovered and
// invoked over the A2A protocol exactly like any external agent. The card is
// derived from the agent$ definition via toAgentCard (below) — version,
// capabilities, and the skill catalog live right here on the agent. In this
// browser app the agents run behind an in-process A2A transport
// (src/a2a/InProcessA2ABus); the derived card is byte-for-byte what an A2AServer
// would serve at /.well-known/agent.json.

export const SchemaInspectorAgent: AgentDefinition = agent$({
  id: "schema-inspector-agent",
  name: "Schema Inspector Agent",
  description: "Analyzes a target table's size, indexes, constraints and write load",
  tools: [InspectTableTool],
  version: "1.0.0",
  capabilities: { streaming: true },
  skills: [{ id: "diagnose-schema", name: "Analyze migration target" }],
});

export const RiskAssessorAgent: AgentDefinition = agent$({
  id: "risk-assessor-agent",
  name: "Risk Assessor Agent",
  description: "Weighs migration risk and applies low-risk changes under human-in-the-loop control",
  tools: [EstimateMigrationTool],
  version: "1.0.0",
  capabilities: { streaming: true },
  skills: [
    { id: "assess-migration", name: "Assess migration risk" },
    { id: "apply-migration", name: "Apply a low-risk migration" },
  ],
});

export const MigrationExecutorAgent: AgentDefinition = agent$({
  id: "migration-executor-agent",
  name: "Migration Executor Agent",
  description:
    "Plans and executes large-table migration strategies under branch-and-promote control",
  tools: [RunMigrationTool],
  version: "1.0.0",
  capabilities: { streaming: true },
  skills: [{ id: "plan-migration", name: "Plan a large-table migration" }],
});

export const FLEET: AgentDefinition[] = [
  SchemaInspectorAgent,
  RiskAssessorAgent,
  MigrationExecutorAgent,
];

// A2A AgentCards — the public, discoverable descriptor for each agent, derived
// from its agent$ definition. Single source of truth: edit the agent, not a
// parallel card object.
export const AGENT_CARDS: Record<string, AgentCard> = Object.fromEntries(
  FLEET.map((agent) => [agent.id, toAgentCard(agent)])
);

// Which agent owns each capability — the A2A routing table.
export const CAPABILITY_AGENT: Record<string, string> = {
  "diagnose-schema": "schema-inspector-agent",
  "assess-migration": "risk-assessor-agent",
  "apply-migration": "risk-assessor-agent",
  "plan-migration": "migration-executor-agent",
};
