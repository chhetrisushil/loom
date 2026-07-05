import type { AgentCard } from "@loom/a2a";
import { toAgentCard } from "@loom/a2a";
import { agent$ } from "@loom/core";
import type { AgentDefinition } from "@loom/core";
import { MetricsTool, ReplicaStatusTool, RestartPoolTool, ScaleReplicasTool } from "./tools";

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

export const DiagnosticsAgent: AgentDefinition = agent$({
  id: "diagnostics-agent",
  name: "Diagnostics Agent",
  description: "Root-causes performance incidents from live metrics and replica status",
  tools: [MetricsTool, ReplicaStatusTool],
  version: "1.0.0",
  capabilities: { streaming: true },
  skills: [
    { id: "diagnose-cpu", name: "Diagnose CPU saturation" },
    { id: "diagnose-replica-lag", name: "Diagnose replica lag" },
  ],
});

export const RemediationAgent: AgentDefinition = agent$({
  id: "remediation-agent",
  name: "Remediation Agent",
  description: "Assesses remediation risk and applies fixes under human-in-the-loop control",
  tools: [RestartPoolTool],
  version: "1.0.0",
  capabilities: { streaming: true },
  skills: [
    { id: "assess-remediation", name: "Assess remediation risk" },
    { id: "apply-remediation", name: "Apply remediation" },
  ],
});

export const CapacityAgent: AgentDefinition = agent$({
  id: "capacity-agent",
  name: "Capacity Agent",
  description: "Plans and applies horizontal scaling for read-replica capacity",
  tools: [ScaleReplicasTool],
  version: "1.0.0",
  capabilities: { streaming: true },
  skills: [{ id: "scale-read-replicas", name: "Scale read replicas" }],
});

export const FLEET: AgentDefinition[] = [DiagnosticsAgent, RemediationAgent, CapacityAgent];

// A2A AgentCards — the public, discoverable descriptor for each agent, derived
// from its agent$ definition. Single source of truth: edit the agent, not a
// parallel card object.
export const AGENT_CARDS: Record<string, AgentCard> = Object.fromEntries(
  FLEET.map((agent) => [agent.id, toAgentCard(agent)])
);

// Which agent owns each capability — the A2A routing table.
export const CAPABILITY_AGENT: Record<string, string> = {
  "diagnose-cpu": "diagnostics-agent",
  "diagnose-replica-lag": "diagnostics-agent",
  "assess-remediation": "remediation-agent",
  "apply-remediation": "remediation-agent",
  "scale-read-replicas": "capacity-agent",
};
