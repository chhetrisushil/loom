import type { EventEnvelope } from "@loom/core";
import {
  CustomDimensionTracker,
  type CustomDimensionsReport,
  type CustomTotals,
  type DimensionUnits,
  newCustomTotals,
} from "./customDimensions";

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
  status?: "completed" | "failed" | "cancelled" | "continued";
}

/**
 * Cost over the metered dimensions. `tokens`/`costUsd`/`ms` are the built-ins; open dimensions
 * (`RESOURCE_METERED.custom`, ADR 0115) are summed in `custom`, absent when none was metered.
 */
export interface CostAnalytics {
  tokens: number;
  costUsd: number;
  ms: number;
  meteredCalls: number;
  quotaExceeded: boolean;
  /** Custom dimension → total; names past the per-report cap sum under `"(other)"`. */
  custom?: CustomTotals;
  /** Units, overflow count and warnings for `custom` (present with it). */
  customReport?: CustomDimensionsReport;
}

export interface AnalyzeOptions {
  /** Unit labels by custom dimension name (`{ gpu_seconds: "s" }`); carried into `customReport.units`. */
  dimensionUnits?: DimensionUnits | undefined;
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
      case "EXECUTION_CONTINUED":
        if (e.metadata?.kernel === true) a.status = "continued";
        break;
    }
  }
  return a;
}

export function costAnalytics(events: EventEnvelope[], options?: AnalyzeOptions): CostAnalytics {
  const a: CostAnalytics = { tokens: 0, costUsd: 0, ms: 0, meteredCalls: 0, quotaExceeded: false };
  const dims = new CustomDimensionTracker(options?.dimensionUnits);
  let custom: CustomTotals | undefined;
  for (const e of events) {
    if (e.eventType === "RESOURCE_METERED") {
      const p = e.payload as { tokens?: number; costUsd?: number; ms?: number; custom?: unknown };
      if (p.custom !== undefined) {
        custom ??= newCustomTotals();
        dims.addPayload(p.custom, custom);
      }
      a.tokens += p.tokens ?? 0;
      a.costUsd += p.costUsd ?? 0;
      a.ms += p.ms ?? 0;
      a.meteredCalls++;
    } else if (e.eventType === "QUOTA_EXCEEDED") {
      a.quotaExceeded = true;
    }
  }
  attachCustom(a, custom, dims);
  return a;
}

function attachCustom(
  a: CostAnalytics,
  custom: CustomTotals | undefined,
  dims: CustomDimensionTracker
): void {
  const report = dims.report();
  if (custom === undefined || report === undefined) return;
  a.custom = custom;
  a.customReport = report;
}

export function reasoningAnalytics(events: EventEnvelope[]): ReasoningAnalytics {
  const a: ReasoningAnalytics = {
    decisions: 0,
    routes: Object.create(null),
    elevations: 0,
    bySource: Object.create(null),
  };
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

/**
 * Analytics over a log. Decision and outcome counts come from the events it is given, so a
 * compacted execution (its decisions and outcomes live in the checkpoint, ADR 0106/0116) is
 * under-counted unless the events are rebuilt first: `evidenceEvents(state, log)` from `@loom/learning`.
 */
export function analyze(events: EventEnvelope[], options?: AnalyzeOptions): Analytics {
  // Single pass over the log building all four lenses at once. The standalone
  // `executionAnalytics`/`costAnalytics`/… helpers above are kept for callers that
  // want one lens; `analyze` deliberately does NOT call them (that would be four
  // passes) but folds the same accumulation logic in one loop.
  const execution: ExecutionAnalytics = {
    steps: 0,
    completed: 0,
    failed: 0,
    cancelledSteps: 0,
    suspended: false,
    resumes: 0,
  };
  const cost: CostAnalytics = {
    tokens: 0,
    costUsd: 0,
    ms: 0,
    meteredCalls: 0,
    quotaExceeded: false,
  };
  const reasoning: ReasoningAnalytics = {
    decisions: 0,
    routes: Object.create(null),
    elevations: 0,
    bySource: Object.create(null),
  };
  const failedSteps: string[] = [];
  const deniedTools: string[] = [];
  let quotaExceeded = 0;
  const dims = new CustomDimensionTracker(options?.dimensionUnits);
  let custom: CustomTotals | undefined;

  for (const e of events) {
    switch (e.eventType) {
      case "STEP_STARTED":
        execution.steps++;
        break;
      case "STEP_COMPLETED":
        execution.completed++;
        break;
      case "STEP_FAILED": {
        execution.failed++;
        const p = e.payload as { stepId?: string };
        if (p.stepId !== undefined) failedSteps.push(p.stepId);
        break;
      }
      case "STEP_CANCELLED":
        execution.cancelledSteps++;
        break;
      case "EXECUTION_SUSPENDED":
        execution.suspended = true;
        break;
      case "EXECUTION_RESUMED":
        execution.resumes++;
        break;
      case "EXECUTION_COMPLETED":
        execution.status = "completed";
        break;
      case "EXECUTION_FAILED":
        execution.status = "failed";
        break;
      case "EXECUTION_CANCELLED":
        execution.status = "cancelled";
        break;
      case "EXECUTION_CONTINUED":
        if (e.metadata?.kernel === true) execution.status = "continued";
        break;
      case "RESOURCE_METERED": {
        const p = e.payload as { tokens?: number; costUsd?: number; ms?: number; custom?: unknown };
        if (p.custom !== undefined) {
          custom ??= newCustomTotals();
          dims.addPayload(p.custom, custom);
        }
        cost.tokens += p.tokens ?? 0;
        cost.costUsd += p.costUsd ?? 0;
        cost.ms += p.ms ?? 0;
        cost.meteredCalls++;
        break;
      }
      case "QUOTA_EXCEEDED":
        cost.quotaExceeded = true;
        quotaExceeded++;
        break;
      case "DECISION_RECORDED": {
        const p = e.payload as { decisionId?: string; choice?: unknown; source?: string };
        reasoning.decisions++;
        if (typeof p.choice === "string")
          reasoning.routes[p.choice] = (reasoning.routes[p.choice] ?? 0) + 1;
        if (typeof p.decisionId === "string" && p.decisionId.includes("elevate"))
          reasoning.elevations++;
        if (typeof p.source === "string")
          reasoning.bySource[p.source] = (reasoning.bySource[p.source] ?? 0) + 1;
        break;
      }
      case "EFFECT_DENIED": {
        const p = e.payload as { toolId?: string };
        if (p.toolId !== undefined) deniedTools.push(p.toolId);
        break;
      }
    }
  }

  attachCustom(cost, custom, dims);
  return {
    execution,
    cost,
    reasoning,
    failure: {
      failures: failedSteps.length,
      denials: deniedTools.length,
      quotaExceeded,
      failedSteps,
      deniedTools,
    },
  };
}

// Rank step ids by failure frequency, most-frequent first. Shared by
// `hotFailures` (which mines the raw log) and `runtimeIntelligence` (which reuses
// the `failedSteps` already collected by `analyze`, avoiding a second pass).
export function rankFailedSteps(failedSteps: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const stepId of failedSteps) counts.set(stepId, (counts.get(stepId) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([stepId]) => stepId);
}
