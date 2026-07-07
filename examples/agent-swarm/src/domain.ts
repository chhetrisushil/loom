// Shared domain types for the release-audit swarm. Everything here is plain data
// that flows through the durable event log, so it stays JSON-serializable.

export type RiskLevel = "low" | "medium" | "high";

/** One entry of the composed plan — a capability + which agent owns it. */
export interface PlanEntry {
  capabilityId: string;
  agentId: string;
  rationale?: string;
}

/** The durably-recorded "which agents were wired to solve this goal" decision. */
export interface AuditPlan {
  goal: string;
  service: string;
  release: string;
  steps: PlanEntry[];
}

export interface ScopeResult {
  service: string;
  release: string;
  changedFiles: number;
  surfaces: string[];
  summary: string;
}
export interface SecurityResult {
  findings: number;
  severity: "none" | "low" | "medium" | "high";
  detail: string;
}
export interface PerfResult {
  regressionPct: number;
  verdict: string;
}
export interface DepsResult {
  outdated: number;
  vulnerabilities: number;
}
export interface SignoffResult {
  signedOff: boolean;
  risk: RiskLevel;
  approvedBy: string;
  summary: string;
}

/** What the conductor returns after a full swarm run (also surfaced to tests). */
export interface AuditRunResult {
  runId: string;
  goal: string;
  service: string;
  release: string;
  phase: "resolved" | "rejected";
  plan: PlanEntry[];
  scope: ScopeResult;
  audits: { security: SecurityResult; perf: PerfResult; deps: DepsResult };
  risk: RiskLevel;
  signoff: SignoffResult;
  pending: PendingApproval | null;
}

export interface PendingApproval {
  taskId: string;
  agentId: string;
  service: string;
  release: string;
  risk: RiskLevel;
  rationale: string;
}
