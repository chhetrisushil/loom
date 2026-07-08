import type { EventEnvelope } from "@loom/core";

// ── Learning seam: outcomes → rankings (closes the P9 loop) ───────────────────
//
// The decision seam (P9) records WHAT was chosen (DECISION_RECORDED). This is the
// symmetric half: record HOW a choice turned out, then mine those outcomes into a
// ranking you feed back to `rankedRouter` (@loom/reasoning) so future routes favor
// what actually worked. The route choice stays a logged decision (P9) — auditable
// and replay-deterministic — so the loop improves outcomes run-to-run without ever
// making replay non-deterministic. `recordOutcome` only hands a payload to the
// caller's `emit`; analytics never mutates the fold (it stays a read lens on the log).

/** Anything with the kernel's `emit` syscall — a WorkflowContext or an EffectContext. */
export interface OutcomeSink {
  emit(eventType: string, payload: unknown): void;
}

export interface Outcome {
  /** What is being scored — a model id, capability id, tool id, etc. */
  key: string;
  /** Binary outcome (did the choice succeed?). */
  success?: boolean;
  /** Continuous reward/quality (averaged as-is); takes precedence over `success`. */
  score?: number;
  /** Optional link to the DECISION_RECORDED this outcome judges (provenance). */
  decisionId?: string;
}

export interface OutcomeStats {
  key: string;
  count: number;
  /** Mean of per-outcome value where value = score ?? (success ? 1 : 0). Higher = better. */
  rank: number;
}

/** Emit a durable OUTCOME_RECORDED fact for how a prior choice turned out. */
export function recordOutcome(sink: OutcomeSink, outcome: Outcome): void {
  sink.emit("OUTCOME_RECORDED", {
    key: outcome.key,
    ...(outcome.success !== undefined && { success: outcome.success }),
    ...(outcome.score !== undefined && { score: outcome.score }),
    ...(outcome.decisionId !== undefined && { decisionId: outcome.decisionId }),
  });
}

function outcomeValue(o: { success?: boolean; score?: number }): number {
  if (typeof o.score === "number") return o.score;
  if (typeof o.success === "boolean") return o.success ? 1 : 0;
  return 0;
}

/** Aggregate OUTCOME_RECORDED events into per-key stats, best-first. */
export function outcomeAnalytics(events: EventEnvelope[]): OutcomeStats[] {
  const acc = new Map<string, { sum: number; count: number }>();
  for (const e of events) {
    if (e.eventType !== "OUTCOME_RECORDED") continue;
    const p = e.payload as { key?: unknown; success?: boolean; score?: number };
    if (typeof p.key !== "string") continue;
    const cur = acc.get(p.key) ?? { sum: 0, count: 0 };
    cur.sum += outcomeValue(p);
    cur.count += 1;
    acc.set(p.key, cur);
  }
  return [...acc.entries()]
    .map(([key, v]) => ({ key, count: v.count, rank: v.sum / v.count }))
    .sort((a, b) => b.rank - a.rank);
}

/**
 * Rank keys by how well their choices turned out (mean success/score). Feed to
 * `rankedRouter(rankFromOutcomes(events))` (@loom/reasoning) to route future work
 * toward proven models — the outcome-driven counterpart to `rankModels` (which ranks
 * by frequency chosen). The resulting route is still recorded via `ctx.decide` (P9).
 */
export function rankFromOutcomes(events: EventEnvelope[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of outcomeAnalytics(events)) out[s.key] = s.rank;
  return out;
}
