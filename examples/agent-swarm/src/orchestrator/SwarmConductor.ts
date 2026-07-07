import type { InProcessA2ABus } from "@loom/app";
import type { CapabilityCatalog } from "@loom/capability";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import { type GraphExecution, executeGraph } from "@loom/graph-executor";
import { IntentRuntime } from "@loom/intent";
import { decideApproval } from "@loom/orchestrator";
import { PlannerRuntime } from "@loom/planner";
import { CAPABILITY_AGENT } from "../agents/definitions";
import type {
  AuditRunResult,
  DepsResult,
  PendingApproval,
  PerfResult,
  PlanEntry,
  RiskLevel,
  ScopeResult,
  SecurityResult,
} from "../domain";
import { llm } from "../runtime/services";

export interface ConductorDeps {
  catalog: CapabilityCatalog;
  bus: InProcessA2ABus;
  dispatcher: ExecutionDispatcher;
}

export type ConductorResult = AuditRunResult & { graph: GraphExecution };

/**
 * Drives the swarm: routes the goal, composes a plan, RECORDS it durably, dispatches
 * the fleet (a sequential scope step, then a parallel executeGraph fan-out of the
 * three specialists), and gates the release on a durable human-in-the-loop sign-off.
 * App-level "conductor" logic — the durable spine lives in the flows it dispatches.
 */
export class SwarmConductor {
  private readonly intent: IntentRuntime;
  private readonly planner: PlannerRuntime;
  private seq = 0;

  private pending: PendingApproval | null = null;
  private approvalResolver: ((d: { approved: boolean; approvedBy: string }) => void) | null = null;
  private lastState: { runId: string; phase: string; pending: PendingApproval | null } = {
    runId: "",
    phase: "idle",
    pending: null,
  };

  constructor(private readonly deps: ConductorDeps) {
    this.intent = new IntentRuntime({ catalog: deps.catalog, provider: llm });
    this.planner = new PlannerRuntime({ catalog: deps.catalog, provider: llm });
  }

  getState(): { runId: string; phase: string; pending: PendingApproval | null } {
    return this.lastState;
  }

  /** Operator answers a pending sign-off request (drives the durable resume). */
  resolveApproval(approved: boolean, approvedBy = "operator"): void {
    this.approvalResolver?.({ approved, approvedBy });
    this.approvalResolver = null;
    this.pending = null;
  }

  private narrate(line: string): void {
    console.log(`  · ${line}`);
  }

  async run(goal: string): Promise<ConductorResult> {
    const runId = `${(this.seq++).toString(36)}-${goal.length}`;
    const { service, release } = parseGoal(goal);
    this.pending = null;
    this.lastState = { runId, phase: "planning", pending: null };
    this.narrate(`Goal: "${goal}"`);

    // 1) Intent routing (which capability the goal enters at).
    const route = await this.intent.route(goal);
    this.narrate(`Intent routed → ${route?.capability.id ?? "(none)"}.`);

    // 2) Planner composes the ordered capability pipeline (the linear "decision").
    const plan = await this.planner.plan(goal);
    const steps: PlanEntry[] = plan.steps.map((s) => ({
      capabilityId: s.capabilityId,
      agentId: CAPABILITY_AGENT[s.capabilityId] ?? "unknown",
      ...(s.rationale !== undefined && { rationale: s.rationale }),
    }));
    this.narrate(
      `Planner composed ${steps.length} steps: ${steps.map((s) => s.capabilityId).join(" → ")}.`
    );

    // 3) GAP-CLOSER #1 — record the plan durably (before any audit runs).
    await this.deps.bus.dispatch(
      "record-plan",
      { goal, service, release, steps },
      "record the composed audit plan",
      { executionId: `plan-${runId}`, onProgress: (l) => this.narrate(l) }
    );

    // 4) Sequential scope step (dispatched to the Scope agent over the bus).
    const scope = (await this.dispatch(
      "scope-audit",
      { service, release },
      `scope-${runId}`
    )) as ScopeResult;

    // 5) GAP-CLOSER #2 — parallel fan-out of the three specialists via executeGraph.
    //    Each is its own execution (one writer); the join is the returned barrier.
    this.lastState = { runId, phase: "auditing", pending: null };
    const graph = await executeGraph(
      this.deps.dispatcher,
      [
        { id: "security", flowId: "security-audit", input: { service, release, scope } },
        { id: "perf", flowId: "perf-audit", input: { service, release, scope } },
        { id: "deps", flowId: "deps-audit", input: { service, release, scope } },
      ],
      { parentExecutionId: `audit-${runId}` }
    );
    const security = graph.byId.security?.output as SecurityResult;
    const perf = graph.byId.perf?.output as PerfResult;
    const deps = graph.byId.deps?.output as DepsResult;
    this.narrate(
      `Audits joined (completed=${graph.completed}): security=${security.severity}, perf=${perf.regressionPct}%, deps.outdated=${deps.outdated}.`
    );

    // 6) Combined risk from the joined results (deterministic).
    const risk = deriveRisk(security, perf, deps);
    const rationale = `security ${security.severity} (${security.findings} finding[s]), perf ${perf.regressionPct}%, ${deps.outdated} outdated dep[s]`;
    this.narrate(`Combined risk: ${risk.toUpperCase()} — ${rationale}.`);

    // 7) Durable human-in-the-loop sign-off (auto for low risk, else await a human).
    this.lastState = { runId, phase: "awaiting-approval", pending: null };
    const signoff = (await this.dispatch(
      "signoff-release",
      { service, release, risk, rationale },
      `signoff-${runId}`,
      () =>
        decideApproval(
          { goal, riskLevel: risk },
          {
            onAutoApprove: () =>
              this.narrate("Risk is LOW — auto-signing off under the release policy."),
            onManualRequired: () => {
              this.pending = {
                taskId: `signoff-${runId}`,
                agentId: "signoff-agent",
                service,
                release,
                risk,
                rationale,
              };
              this.lastState = { runId, phase: "awaiting-approval", pending: this.pending };
              this.narrate(`Risk is ${risk.toUpperCase()} — pausing for human sign-off.`);
            },
            waitForManual: () =>
              new Promise((resolve) => {
                this.approvalResolver = resolve;
              }),
          }
        )
    )) as import("../domain").SignoffResult;

    this.pending = null;
    this.lastState = { runId, phase: signoff.signedOff ? "resolved" : "rejected", pending: null };
    return {
      runId,
      goal,
      service,
      release,
      phase: signoff.signedOff ? "resolved" : "rejected",
      plan: steps,
      scope,
      audits: { security, perf, deps },
      risk,
      signoff,
      pending: null,
      graph,
    };
  }

  private async dispatch(
    capabilityId: string,
    input: unknown,
    executionId: string,
    onApproval?: () => Promise<{ approved: boolean; approvedBy: string }>
  ): Promise<unknown> {
    const result = await this.deps.bus.dispatch(capabilityId, input, capabilityId, {
      executionId,
      onProgress: (line) => this.narrate(line),
      ...(onApproval !== undefined && { onApproval }),
    });
    return result.artifact;
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────
export function parseGoal(goal: string): { service: string; release: string } {
  const svc = /([a-z0-9]+)-service/i.exec(goal);
  const rel = /\b(\d+\.\d+(?:\.\d+)?)\b/.exec(goal);
  return { service: (svc?.[1] ?? "unknown").toLowerCase(), release: rel?.[1] ?? "0.0" };
}

export function deriveRisk(
  security: SecurityResult,
  perf: PerfResult,
  deps: DepsResult
): RiskLevel {
  if (security.severity === "high" || deps.vulnerabilities > 0 || perf.regressionPct > 10)
    return "high";
  if (security.findings > 0 || perf.regressionPct > 5 || deps.outdated > 0) return "medium";
  return "low";
}
