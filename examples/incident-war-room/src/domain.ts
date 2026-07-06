// ── Shared domain vocabulary for the Incident War Room ────────────────────────
//
// A small, self-contained model of the database-operations domain the fleet of
// agents reasons about. Kept framework-agnostic so agents, capabilities, the
// orchestrator, and the widgets all speak the same language.

export type RiskLevel = "low" | "medium" | "high";

export type Severity = "info" | "warning" | "critical";

// A near-real-time unit of work the command center tracks. One AgentTask is
// created per plan step and dispatched to a domain agent over the A2A bus.
export type TaskStatus =
  | "queued"
  | "working"
  | "awaiting-approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentTask {
  id: string;
  agentId: string;
  agentName: string;
  capabilityId: string;
  title: string;
  status: TaskStatus;
  detail: string;
  // Streamed progress lines — the agent narrates its long-running work here.
  progress: string[];
  risk?: RiskLevel;
  startedAt: number;
  updatedAt: number;
  // Final structured result of the agent's work (diagnosis, assessment, …).
  artifact?: unknown;
}

// One entry of the dynamically-generated plan (the "workflow" the planner
// composed from the goal).
export interface PlanEntry {
  capabilityId: string;
  agentId: string;
  title: string;
  rationale?: string;
  status: TaskStatus;
}

// Output of a diagnosis capability.
export interface Diagnosis {
  target: string;
  rootCause: string;
  severity: Severity;
  metrics: Record<string, number>;
}

// Output of the remediation-assessment capability — the agent's risk call.
export interface RemediationAssessment {
  action: string;
  riskLevel: RiskLevel;
  rationale: string;
}

// A pending human decision surfaced to the operator (human-in-the-loop).
export interface PendingApproval {
  taskId: string;
  agentId: string;
  title: string;
  action: string;
  risk: RiskLevel;
  rationale: string;
}
