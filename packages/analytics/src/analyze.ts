import type { EventEnvelope } from "@loom/core";

// ── Event intelligence (Loom 2.0 M9) ─────────────────────────────────────────
//
// Pure, read-only analyzers over the durable event log — "lenses on the log" (D11).
// They never write and never affect the fold; they just fold events into summaries.
// Because M1–M8 enriched the log (RESOURCE_METERED cost, DECISION_RECORDED routes,
// EFFECT_DENIED / QUOTA_EXCEEDED failures), these summaries come for free.

export interface ExecutionAnalytics {
  steps: number;
  completed: number;
  failed: number;
  cancelledSteps: number;
  suspended: boolean;
  resumes: number;
  status?: "completed" | "failed" | "cancelled";
}

export interface CostAnalytics {
  tokens: number;
  costUsd: number;
  ms: number;
  meteredCalls: number;
  quotaExceeded: boolean;
}

export interface ReasoningAnalytics {
  decisions: number;
  /** modelId (or other choice) → number of times chosen. */
  routes: Record<string, number>;
  elevations: number;
  /** decision source (e.g. "reasoning" | "agent") → count. */
  bySource: Record<string, number>;
}

export interface FailureAnalytics {
  failures: number;
  denials: number;
  quotaExceeded: number;
  failedSteps: string[];
  deniedTools: string[];
}

export interface Analytics {
  execution: ExecutionAnalytics;
  cost: CostAnalytics;
  reasoning: ReasoningAnalytics;
  failure: FailureAnalytics;
}

export function executionAnalytics(events: EventEnvelope[]): ExecutionAnalytics {
  const a: ExecutionAnalytics = {
    steps: 0,
    completed: 0,
    failed: 0,
    cancelledSteps: 0,
    suspended: false,
    resumes: 0,
  };
  for (const e of events) {
    switch (e.eventType) {
      case "STEP_STARTED":
        a.steps++;
        break;
      case "STEP_COMPLETED":
        a.completed++;
        break;
      case "STEP_FAILED":
        a.failed++;
        break;
      case "STEP_CANCELLED":
        a.cancelledSteps++;
        break;
      case "EXECUTION_SUSPENDED":
        a.suspended = true;
        break;
      case "EXECUTION_RESUMED":
        a.resumes++;
        break;
      case "EXECUTION_COMPLETED":
        a.status = "completed";
        break;
      case "EXECUTION_FAILED":
        a.status = "failed";
        break;
      case "EXECUTION_CANCELLED":
        a.status = "cancelled";
        break;
    }
  }
  return a;
}

export function costAnalytics(events: EventEnvelope[]): CostAnalytics {
  const a: CostAnalytics = { tokens: 0, costUsd: 0, ms: 0, meteredCalls: 0, quotaExceeded: false };
  for (const e of events) {
    if (e.eventType === "RESOURCE_METERED") {
      const p = e.payload as { tokens?: number; costUsd?: number; ms?: number };
      a.tokens += p.tokens ?? 0;
      a.costUsd += p.costUsd ?? 0;
      a.ms += p.ms ?? 0;
      a.meteredCalls++;
    } else if (e.eventType === "QUOTA_EXCEEDED") {
      a.quotaExceeded = true;
    }
  }
  return a;
}

export function reasoningAnalytics(events: EventEnvelope[]): ReasoningAnalytics {
  const a: ReasoningAnalytics = { decisions: 0, routes: {}, elevations: 0, bySource: {} };
  for (const e of events) {
    if (e.eventType !== "DECISION_RECORDED") continue;
    const p = e.payload as { decisionId?: string; choice?: unknown; source?: string };
    a.decisions++;
    if (typeof p.choice === "string") a.routes[p.choice] = (a.routes[p.choice] ?? 0) + 1;
    if (typeof p.decisionId === "string" && p.decisionId.includes("elevate")) a.elevations++;
    if (typeof p.source === "string") a.bySource[p.source] = (a.bySource[p.source] ?? 0) + 1;
  }
  return a;
}

export function failureAnalytics(events: EventEnvelope[]): FailureAnalytics {
  const failedSteps: string[] = [];
  const deniedTools: string[] = [];
  let quotaExceeded = 0;
  for (const e of events) {
    if (e.eventType === "STEP_FAILED") {
      const p = e.payload as { stepId?: string };
      if (p.stepId !== undefined) failedSteps.push(p.stepId);
    } else if (e.eventType === "EFFECT_DENIED") {
      const p = e.payload as { toolId?: string };
      if (p.toolId !== undefined) deniedTools.push(p.toolId);
    } else if (e.eventType === "QUOTA_EXCEEDED") {
      quotaExceeded++;
    }
  }
  return {
    failures: failedSteps.length,
    denials: deniedTools.length,
    quotaExceeded,
    failedSteps,
    deniedTools,
  };
}

export function analyze(events: EventEnvelope[]): Analytics {
  return {
    execution: executionAnalytics(events),
    cost: costAnalytics(events),
    reasoning: reasoningAnalytics(events),
    failure: failureAnalytics(events),
  };
}
