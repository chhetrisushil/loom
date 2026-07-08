import type { EventEnvelope } from "@loom/core";
import {
  type Analytics,
  analyze,
  failureAnalytics,
  rankFailedSteps,
  reasoningAnalytics,
} from "./analyze";

// ── Self-optimization (M10) ──────────────────────────────────────────────────
//
// Derive a model ranking from historical logs (how often each model was the chosen
// route). Feed it to `rankedRouter` (@loom/reasoning) to prefer proven models — an
// EXPLICIT, opt-in optimizer whose choices are logged via the decision seam (P9), so
// it is auditable and override-able, never silently autonomous (P10).
export function rankModels(events: EventEnvelope[]): Record<string, number> {
  return reasoningAnalytics(events).routes;
}

// Most-failing steps, most-frequent first — the "what's-flaky" mining lens.
export function hotFailures(events: EventEnvelope[], limit = 5): string[] {
  return rankFailedSteps(failureAnalytics(events).failedSteps, limit);
}

// ── Runtime intelligence (M11) ───────────────────────────────────────────────
//
// Compose the analytics (M9) and optimizers (M10) into a single ADVISORY report.
// Pure and read-only: it never mutates the fold. To act on it, feed
// `recommendations.modelRankings` into `rankedRouter` — the choice is then logged
// (P9). This is the advisory plane (P10): it shapes future runs, it doesn't rewrite
// the past.
export interface RuntimeRecommendations {
  modelRankings: Record<string, number>;
  hotFailures: string[];
  /** Suggested budget with headroom over observed spend (undefined if nothing metered). */
  suggestedBudgetUsd?: number;
}

export interface RuntimeIntelligenceReport {
  analytics: Analytics;
  recommendations: RuntimeRecommendations;
}

export interface RuntimeIntelligenceOptions {
  /** Headroom multiplier applied to observed cost for the budget suggestion. Default 1.5. */
  budgetHeadroom?: number;
  /** Cap on hotFailures returned. Default 5. */
  failureLimit?: number;
}

export function runtimeIntelligence(
  events: EventEnvelope[],
  options: RuntimeIntelligenceOptions = {}
): RuntimeIntelligenceReport {
  const analytics = analyze(events);
  const headroom = options.budgetHeadroom ?? 1.5;
  const recommendations: RuntimeRecommendations = {
    modelRankings: analytics.reasoning.routes,
    // Reuse the failedSteps already collected by `analyze` — no extra log pass.
    hotFailures: rankFailedSteps(analytics.failure.failedSteps, options.failureLimit ?? 5),
    ...(analytics.cost.costUsd > 0 && {
      suggestedBudgetUsd: Math.round(analytics.cost.costUsd * headroom * 100) / 100,
    }),
  };
  return { analytics, recommendations };
}
