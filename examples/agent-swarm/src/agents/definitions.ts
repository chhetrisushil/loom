import { agent$, policy$ } from "@loom/core";
import type { AgentDefinition, PolicyDefinition } from "@loom/core";
import { DepsTool, PerfTool, ScopeTool, SecurityTool, SignoffTool } from "./tools";

// Least-privilege per agent: each audit agent may invoke ONLY its own audit effect (the step
// id its capability flow runs). Attached to the agent$; `defineConfig` binds it to the flow the
// agent runs (via `capabilityAgents`) and the K2 ring enforces it — so a misbehaving plan or model
// can't make the security agent run the deps tool, etc. Enforcement is deny-wins under the
// `authorizer`; the happy path (each flow calls only its own step) is unaffected.
const onlyEffect = (stepId: string): PolicyDefinition =>
  policy$({
    id: `${stepId}-only`,
    name: `Least privilege: ${stepId}`,
    rules: { allow: [stepId] },
  });

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
  policies: [onlyEffect("scope-step")],
});

export const SecurityAgent: AgentDefinition = agent$({
  id: "security-agent",
  name: "Security Agent",
  description: "Scans the release for vulnerabilities and misconfigurations",
  tools: [SecurityTool],
  version: "1.0.0",
  skills: [{ id: "security-audit", name: "Security audit" }],
  policies: [onlyEffect("security-step")],
});

export const PerfAgent: AgentDefinition = agent$({
  id: "perf-agent",
  name: "Performance Agent",
  description: "Checks the release for performance regressions against budget",
  tools: [PerfTool],
  version: "1.0.0",
  skills: [{ id: "perf-audit", name: "Performance audit" }],
  policies: [onlyEffect("perf-step")],
});

export const DepsAgent: AgentDefinition = agent$({
  id: "deps-agent",
  name: "Dependencies Agent",
  description: "Audits dependency freshness and security advisories",
  tools: [DepsTool],
  version: "1.0.0",
  skills: [{ id: "deps-audit", name: "Dependency audit" }],
  policies: [onlyEffect("deps-step")],
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

// A fleet-wide guardrail: the audit swarm is READ-ONLY. Even if a composed plan or a model tried
// to invoke a deployment / rollback / promotion effect, the K2 ring denies it (`EFFECT_DENIED`) and
// the step fails. App-global (passed to `defineConfig({ policies })`), so it applies to every
// execution regardless of which agent ran it. Deny-wins; composes under any `authorizer`.
export const FLEET_GUARDRAIL: PolicyDefinition = policy$({
  id: "fleet-read-only",
  name: "Read-only audit fleet",
  rules: { deny: ["deploy-*", "rollback-*", "promote-*", "delete-*"] },
});

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
