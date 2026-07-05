import type { AgentCard } from "@loom/a2a";
import { agent$ } from "@loom/core";
import type { AgentDefinition } from "@loom/core";
import { MetricsTool, ReplicaStatusTool, RestartPoolTool, ScaleReplicasTool } from "./tools";

// ── The domain-specialist fleet ───────────────────────────────────────────────
//
// Three long-running, domain-specific agents. Each is a first-class agent$
// (its own tools) and advertises an A2A AgentCard, so it can be discovered and
// invoked over the A2A protocol exactly like any external agent. In this browser
// app they run behind an in-process A2A transport (src/a2a/InProcessA2ABus); the
// AgentCard is byte-for-byte what an A2AServer would serve at
// /.well-known/agent.json.

export const DiagnosticsAgent: AgentDefinition = agent$({
  id: "diagnostics-agent",
  name: "Diagnostics Agent",
  description: "Root-causes performance incidents from live metrics and replica status",
  tools: [MetricsTool, ReplicaStatusTool],
});

export const RemediationAgent: AgentDefinition = agent$({
  id: "remediation-agent",
  name: "Remediation Agent",
  description: "Assesses remediation risk and applies fixes under human-in-the-loop control",
  tools: [RestartPoolTool],
});

export const CapacityAgent: AgentDefinition = agent$({
  id: "capacity-agent",
  name: "Capacity Agent",
  description: "Plans and applies horizontal scaling for read-replica capacity",
  tools: [ScaleReplicasTool],
});

export const FLEET: AgentDefinition[] = [DiagnosticsAgent, RemediationAgent, CapacityAgent];

// A2A AgentCards — the public, discoverable descriptor for each agent.
export const AGENT_CARDS: Record<string, AgentCard> = {
  "diagnostics-agent": {
    name: DiagnosticsAgent.name,
    description: DiagnosticsAgent.description ?? "",
    url: "loom+inproc://diagnostics-agent",
    version: "1.0.0",
    capabilities: { streaming: true },
    skills: [
      { id: "diagnose-cpu", name: "Diagnose CPU saturation" },
      { id: "diagnose-replica-lag", name: "Diagnose replica lag" },
    ],
  },
  "remediation-agent": {
    name: RemediationAgent.name,
    description: RemediationAgent.description ?? "",
    url: "loom+inproc://remediation-agent",
    version: "1.0.0",
    capabilities: { streaming: true },
    skills: [
      { id: "assess-remediation", name: "Assess remediation risk" },
      { id: "apply-remediation", name: "Apply remediation" },
    ],
  },
  "capacity-agent": {
    name: CapacityAgent.name,
    description: CapacityAgent.description ?? "",
    url: "loom+inproc://capacity-agent",
    version: "1.0.0",
    capabilities: { streaming: true },
    skills: [{ id: "scale-read-replicas", name: "Scale read replicas" }],
  },
};

// Which agent owns each capability — the A2A routing table.
export const CAPABILITY_AGENT: Record<string, string> = {
  "diagnose-cpu": "diagnostics-agent",
  "diagnose-replica-lag": "diagnostics-agent",
  "assess-remediation": "remediation-agent",
  "apply-remediation": "remediation-agent",
  "scale-read-replicas": "capacity-agent",
};
