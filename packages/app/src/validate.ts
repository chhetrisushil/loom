/** Minimal view of a flow needed for graph validation. */
export interface FlowGraphFlow {
  id: string;
  steps: Array<{ id: string; toolId?: string; handler?: unknown }>;
}

export interface FlowGraphInput {
  flows: FlowGraphFlow[];
  /** Whether an effect is registered for a toolId (e.g. `effectRuntime.has`). */
  hasEffect: (toolId: string) => boolean;
  /** capabilityId → agentId routing to validate. */
  capabilityAgents?: Record<string, string>;
  /** Whether a capability is registered (e.g. `catalog.get(id) !== undefined`). */
  hasCapability?: (capabilityId: string) => boolean;
}

export interface FlowGraphIssue {
  severity: "error" | "warning";
  kind: "missing-effect" | "dangling-capability-agent";
  detail: string;
  flowId?: string;
}

/**
 * Structural "typecheck for flows" — catches wiring bugs at boot instead of as a
 * runtime error mid-dispatch. Deliberately scoped to tractable static checks
 * (schema dataflow across `ctx.run` calls needs analysis of arbitrary runner code
 * and is out of scope):
 *
 *  - `missing-effect`: a step whose `toolId` has no registered effect ⇒ it would
 *    throw "No effect registered" when reached.
 *  - `dangling-capability-agent`: a `capabilityAgents` entry pointing at a
 *    capability the catalog doesn't know ⇒ dispatch would find no flow.
 */
export function validateFlowGraph(input: FlowGraphInput): FlowGraphIssue[] {
  const issues: FlowGraphIssue[] = [];

  for (const flow of input.flows) {
    for (const step of flow.steps) {
      const toolId = step.toolId ?? step.id;
      if (!input.hasEffect(toolId)) {
        issues.push({
          severity: "error",
          kind: "missing-effect",
          flowId: flow.id,
          detail: `step "${step.id}" in flow "${flow.id}" has no registered effect for toolId "${toolId}"`,
        });
      }
    }
  }

  if (input.capabilityAgents && input.hasCapability) {
    for (const [capabilityId, agentId] of Object.entries(input.capabilityAgents)) {
      if (!input.hasCapability(capabilityId)) {
        issues.push({
          severity: "error",
          kind: "dangling-capability-agent",
          detail: `capabilityAgents maps "${capabilityId}" → "${agentId}" but no such capability is registered`,
        });
      }
    }
  }

  return issues;
}
