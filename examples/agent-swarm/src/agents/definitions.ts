import type { AgentCard } from "@loom/a2a";
import { toAgentCard } from "@loom/a2a/cards";
import { agent$ } from "@loom/core";
import type { AgentDefinition } from "@loom/core";
import { DepsTool, PerfTool, ScopeTool, SecurityTool, SignoffTool } from "./tools";

// ── The release-audit fleet ───────────────────────────────────────────────────
//
// Each agent is a first-class agent$ with ONE well-defined responsibility and its
// own tools, and advertises an A2A AgentCard (derived from the definition), so it
// is discoverable/invocable over the A2A protocol like any external agent.

export const ScopeAgent: AgentDefinition = agent$({
  id: "scope-agent",
  name: "Scope Agent",
  description: "Establishes the audit scope — what changed and which surfaces are at risk",
  tools: [ScopeTool],
  version: "1.0.0",
  skills: [{ id: "scope-audit", name: "Scope a release audit" }],
});

export const SecurityAgent: AgentDefinition = agent$({
  id: "security-agent",
  name: "Security Agent",
  description: "Scans the release for vulnerabilities and misconfigurations",
  tools: [SecurityTool],
  version: "1.0.0",
  skills: [{ id: "security-audit", name: "Security audit" }],
});

export const PerfAgent: AgentDefinition = agent$({
  id: "perf-agent",
  name: "Performance Agent",
  description: "Checks the release for performance regressions against budget",
  tools: [PerfTool],
  version: "1.0.0",
  skills: [{ id: "perf-audit", name: "Performance audit" }],
});

export const DepsAgent: AgentDefinition = agent$({
  id: "deps-agent",
  name: "Dependencies Agent",
  description: "Audits dependency freshness and security advisories",
  tools: [DepsTool],
  version: "1.0.0",
  skills: [{ id: "deps-audit", name: "Dependency audit" }],
});

export const SignoffAgent: AgentDefinition = agent$({
  id: "signoff-agent",
  name: "Sign-off Agent",
  description: "Gates the release on combined risk, under human-in-the-loop control",
  tools: [SignoffTool],
  version: "1.0.0",
  skills: [{ id: "signoff-release", name: "Sign off a release" }],
});

export const FLEET: AgentDefinition[] = [
  ScopeAgent,
  SecurityAgent,
  PerfAgent,
  DepsAgent,
  SignoffAgent,
];

// The public, discoverable A2A card per agent, derived from its agent$ definition.
export const AGENT_CARDS: Record<string, AgentCard> = Object.fromEntries(
  FLEET.map((agent) => [agent.id, toAgentCard(agent)])
);

// Which agent owns each capability — the A2A routing table (static ⇒ replay-safe).
// `record-plan` is a conductor-internal capability owned by the Scope agent.
export const CAPABILITY_AGENT: Record<string, string> = {
  "record-plan": "scope-agent",
  "scope-audit": "scope-agent",
  "security-audit": "security-agent",
  "perf-audit": "perf-agent",
  "deps-audit": "deps-agent",
  "signoff-release": "signoff-agent",
};
