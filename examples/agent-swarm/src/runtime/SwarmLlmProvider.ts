import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";

// A single deterministic, offline LlmProvider so the whole swarm runs with no API
// key. It plays two model roles the runtimes ask for:
//
//   • Planner — returns an ordered JSON plan (goal → capability pipeline)
//   • Intent  — routes a goal to one capability id
//
// Going live is a one-line swap in src/runtime/services.ts:
//   export const llm = new AnthropicProvider({ model: "claude-opus-4-8" });
// Nothing downstream (Planner/Intent) changes.

// Keep in sync with the capability ids in src/capabilities/catalog.ts. This is the
// LINEAR plan the planner composes — the durable "decision". The conductor then
// runs the three audits in parallel (that scheduling is separate; see README).
const AUDIT_PLAN: Array<{ capabilityId: string; rationale: string }> = [
  { capabilityId: "scope-audit", rationale: "Establish what changed and the surfaces at risk" },
  { capabilityId: "security-audit", rationale: "Scan for vulnerabilities and misconfigurations" },
  { capabilityId: "perf-audit", rationale: "Check for performance regressions vs budget" },
  { capabilityId: "deps-audit", rationale: "Audit dependency freshness and advisories" },
  { capabilityId: "signoff-release", rationale: "Gate the release on the combined risk" },
];

function goalOf(request: LlmRequest): string {
  const raw = request.messages.map((m) => m.content).join("\n");
  // Classify off the actual goal line only — the prompt embeds a capability menu.
  const match = /(?:goal|request):\s*([^\n]*)/i.exec(raw);
  return (match?.[1] ?? raw).toLowerCase();
}

export class SwarmLlmProvider implements LlmProvider {
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const system = (request.system ?? "").toLowerCase();

    // Planner: emit an ordered JSON plan the PlannerRuntime will parse.
    if (system.includes("planner")) {
      return { content: JSON.stringify(AUDIT_PLAN), stopReason: "end_turn" };
    }
    // Intent routing: reply with exactly one capability id — the entry point.
    if (system.includes("route")) {
      return { content: "scope-audit", stopReason: "end_turn" };
    }
    // Fallback (unused by this example).
    void goalOf(request);
    return { content: "scope-audit", stopReason: "end_turn" };
  }
}
