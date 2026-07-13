import type { EventEnvelope } from "@loom/core";
import { costAnalytics } from "./analyze";
import {
  type DecisionRecord,
  type OutcomeRecord,
  decisionRecords,
  outcomeRecords,
} from "./decisions";
import { runtimeIntelligence } from "./intelligence";
import { latencyBreakdown } from "./profile";

// ── Advisory Optimization Pipeline (ADR 0034) ────────────────────────────────
//
// Requirement 8: compose the existing advisory components into ONE lifecycle —
// observe → analyze → recommend → evaluate → learn — as a pure read-model over the
// durable log. It NEVER feeds the fold and NEVER auto-adopts: it emits recommendations
// and correlates them to the outcomes they later produced (from OUTCOME_RECORDED, which
// is already durable — so no new event type). Adoption is always an explicit ctx.decide
// in application code. Same events → same report (reproducible); uncalled → zero cost.

export type RecommendationKind = "model-ranking" | "budget" | "hot-failure";

export interface Recommendation {
  /** Deterministic, content-derived id — stable across runs for identical content. */
  id: string;
  kind: RecommendationKind;
  /** What the recommendation concerns: a model id, a step id, or "budget". */
  subject: string;
  action: string;
  rationale: string;
  evidence: Record<string, number | string>;
}

export interface RecommendationOutcome {
  recommendationId: string;
  subject: string;
  /** Decisions that actually chose this subject (adoption, from DECISION_RECORDED). */
  adopted: number;
  /** Of those, how many have a recorded outcome (OUTCOME_RECORDED). */
  outcomes: number;
  successes: number;
  /** successes / outcomes; null when no outcome has been recorded yet (not fabricated). */
  successRate: number | null;
}

export interface AdvisoryObserve {
  costUsd: number;
  tokens: number;
  wallMs: number;
  busyMs: number;
  suspendedMs: number;
}

export interface AdvisoryReport {
  observe: AdvisoryObserve;
  recommendations: Recommendation[];
  evaluations: RecommendationOutcome[];
  /** Refreshed outcome-driven rankings to feed the next rankedRouter (the "learn" step). */
  rankings: Record<string, number>;
}

export interface AdvisoryOptions {
  /** Max number of model-ranking recommendations (default 3). */
  topModels?: number;
}

/** FNV-1a over the recommendation's content — stable, dependency-free. */
function recId(kind: string, subject: string, action: string): string {
  const s = `${kind}|${subject}|${action}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `rec:${(h >>> 0).toString(16).padStart(8, "0")}`;
}

function evaluateSubject(
  rec: Recommendation,
  decisions: DecisionRecord[],
  outcomes: OutcomeRecord[]
): RecommendationOutcome {
  // Correlate by execution + decision id so cross-execution id reuse can't cross-link.
  const chosen = new Set(
    decisions.filter((d) => d.choice === rec.subject).map((d) => `${d.executionId}:${d.decisionId}`)
  );
  const linked = outcomes.filter(
    (o) => o.decisionId !== undefined && chosen.has(`${o.executionId}:${o.decisionId}`)
  );
  const successes = linked.filter((o) => o.success === true).length;
  return {
    recommendationId: rec.id,
    subject: rec.subject,
    adopted: chosen.size,
    outcomes: linked.length,
    successes,
    successRate: linked.length > 0 ? successes / linked.length : null,
  };
}

/**
 * The composed advisory lifecycle (ADR 0034). Pure, read-only, deterministic: it
 * observes telemetry, analyzes history, recommends, evaluates prior recommendations
 * against realized outcomes, and surfaces refreshed rankings to feed forward — all
 * without touching the fold or auto-adopting anything.
 */
export function advisoryPipeline(events: EventEnvelope[], opts?: AdvisoryOptions): AdvisoryReport {
  const topModels = opts?.topModels ?? 3;

  // observe
  const cost = costAnalytics(events);
  const lat = latencyBreakdown(events);
  const observe: AdvisoryObserve = {
    costUsd: cost.costUsd,
    tokens: cost.tokens,
    wallMs: lat.wallMs,
    busyMs: lat.busyMs,
    suspendedMs: lat.suspendedMs,
  };

  // analyze
  const intel = runtimeIntelligence(events);
  const rec = intel.recommendations;
  // learn — the feed-forward signal for the next rankedRouter. `runtimeIntelligence`
  // already computed this exact value (rankFromOutcomes(events)) into outcomeRankings;
  // reuse it instead of a second full-log pass + sort.
  const rankings = rec.outcomeRankings;

  // recommend — prefer the outcome-driven ranking; fall back to frequency ranking.
  const modelRanks =
    Object.keys(rec.outcomeRankings).length > 0 ? rec.outcomeRankings : rec.modelRankings;
  const recommendations: Recommendation[] = [];

  for (const [model, score] of Object.entries(modelRanks)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topModels)) {
    const action = `Prefer model "${model}" for future routing`;
    recommendations.push({
      id: recId("model-ranking", model, action),
      kind: "model-ranking",
      subject: model,
      action,
      rationale: "Ranked highest by observed routing/outcome signal.",
      evidence: { score },
    });
  }

  if (rec.suggestedBudgetUsd !== undefined) {
    const action = `Set a cost budget near $${rec.suggestedBudgetUsd}`;
    recommendations.push({
      id: recId("budget", "budget", action),
      kind: "budget",
      subject: "budget",
      action,
      rationale: "Derived from observed spend plus headroom.",
      evidence: { suggestedBudgetUsd: rec.suggestedBudgetUsd, observedCostUsd: cost.costUsd },
    });
  }

  for (const step of rec.hotFailures) {
    const action = `Investigate hot-failing step "${step}"`;
    recommendations.push({
      id: recId("hot-failure", step, action),
      kind: "hot-failure",
      subject: step,
      action,
      rationale: "Fails frequently relative to other steps.",
      evidence: { step },
    });
  }

  // evaluate — only model-ranking recs have a decision subject to correlate against.
  const decisions = decisionRecords(events);
  const outcomes = outcomeRecords(events);
  const evaluations = recommendations
    .filter((r) => r.kind === "model-ranking")
    .map((r) => evaluateSubject(r, decisions, outcomes));

  return { observe, recommendations, evaluations, rankings };
}

/** Human-readable rendering for `loom optimize`. */
export function formatAdvisory(report: AdvisoryReport): string {
  const o = report.observe;
  const lines: string[] = [
    "advisory optimization report",
    "",
    "observe:",
    `  cost $${o.costUsd} · ${o.tokens} tok · wall ${o.wallMs}ms (busy ${o.busyMs}ms, suspended ${o.suspendedMs}ms)`,
    "",
    "recommendations:",
  ];
  if (report.recommendations.length === 0) {
    lines.push("  (none)");
  }
  for (const r of report.recommendations) {
    lines.push(`  [${r.kind}] ${r.action}  (${r.id})`);
  }
  if (report.evaluations.length > 0) {
    lines.push("", "evaluation (recommendation → realized outcomes):");
    for (const e of report.evaluations) {
      const rate = e.successRate === null ? "—" : `${Math.round(e.successRate * 100)}%`;
      lines.push(`  ${e.subject}: adopted ${e.adopted}, outcomes ${e.outcomes}, success ${rate}`);
    }
  }
  return lines.join("\n");
}
