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

/** One late reward for a decision of a finished execution (ADR 0116). */
export interface LateReward {
  executionId: string;
  decisionId: string;
  key: string;
  success?: boolean;
  score?: number;
}

/**
 * The slice of `WorkflowRuntime` {@link attachOutcomes} needs — structural, so analytics keeps no
 * dependency on the runtime.
 */
export interface OutcomeAttacher {
  recordOutcome(
    executionId: string,
    outcome: { decisionId: string; key: string; success?: boolean; score?: number },
    options?: { principal?: unknown; system?: unknown }
  ): Promise<{ appended: boolean }>;
}

export interface AttachOutcomesResult {
  appended: number;
  /** Already recorded (idempotent). */
  duplicates: number;
  /** Refused or exhausted retries; the reward pipeline decides what to do with these. */
  failed: Array<{ reward: LateReward; error: unknown }>;
}

/**
 * The thin reward pipeline over `runtime.recordOutcome` (ADR 0116 D2): attach each late reward in
 * order, retrying only errors that say `retryable` (a lost sequence race) up to `retries` times.
 * A refusal (unauthorized, not terminal, unknown decision, conflicting score) is NOT retried: it is
 * reported in `failed` and the rest continue. Idempotent, so the whole batch is safe to re-run.
 */
export async function attachOutcomes(
  runtime: OutcomeAttacher,
  rewards: readonly LateReward[],
  opts: { retries?: number; options?: { principal?: unknown; system?: unknown } } = {}
): Promise<AttachOutcomesResult> {
  const retries = Math.max(0, opts.retries ?? 3);
  const result: AttachOutcomesResult = { appended: 0, duplicates: 0, failed: [] };
  for (const reward of rewards) {
    const { executionId, ...outcome } = reward;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await runtime.recordOutcome(executionId, outcome, opts.options);
        if (r.appended) result.appended++;
        else result.duplicates++;
        break;
      } catch (error) {
        const retryable = (error as { retryable?: unknown } | null)?.retryable === true;
        if (retryable && attempt < retries) continue;
        result.failed.push({ reward, error });
        break;
      }
    }
  }
  return result;
}

function outcomeValue(o: { success?: boolean; score?: number }): number {
  if (typeof o.score === "number") return o.score;
  if (typeof o.success === "boolean") return o.success ? 1 : 0;
  return 0;
}

export interface OutcomeAnalyticsOptions {
  /**
   * Exponential recency decay: an outcome `halfLifeMs` older than `now` counts
   * half as much toward `rank`. Omit for the flat lifetime mean (every outcome
   * weighted equally, however stale).
   *
   * Rewards here are NON-STATIONARY — a provider ships a new checkpoint, a tool
   * gets fixed, a prompt changes — so the flat mean lets a model's ancient
   * reputation outvote its current behaviour indefinitely. `count` is unaffected
   * (it stays the raw sample count that sample floors and UCB1 need).
   */
  halfLifeMs?: number;
  /**
   * Reference time for decay. Default: the newest OUTCOME_RECORDED timestamp in
   * `events` — a pure function of the log, so the ranking is clock-free and
   * identical on every replay of the same log.
   */
  now?: number;
}

/** Aggregate OUTCOME_RECORDED events into per-key stats, best-first. */
export function outcomeAnalytics(
  events: EventEnvelope[],
  opts: OutcomeAnalyticsOptions = {}
): OutcomeStats[] {
  const { halfLifeMs } = opts;
  if (halfLifeMs !== undefined && !(halfLifeMs > 0)) {
    throw new Error(`outcomeAnalytics: halfLifeMs must be > 0, got ${halfLifeMs}`);
  }

  // Decay is relative to the newest outcome, which needs one pass to find before
  // weights can be assigned. Two O(n) passes with O(k) state beats one pass that
  // buffers every outcome per key, and avoids the overflow of accumulating
  // growing exponentials against a fixed epoch.
  let now = opts.now;
  if (halfLifeMs !== undefined && now === undefined) {
    now = Number.NEGATIVE_INFINITY;
    for (const e of events) {
      if (e.eventType === "OUTCOME_RECORDED" && e.timestamp > now) now = e.timestamp;
    }
  }

  const acc = new Map<string, { sum: number; weight: number; count: number }>();
  for (const e of events) {
    if (e.eventType !== "OUTCOME_RECORDED") continue;
    const p = e.payload as { key?: unknown; success?: boolean; score?: number };
    if (typeof p.key !== "string") continue;
    const w =
      halfLifeMs === undefined
        ? 1
        : 2 ** (-Math.max(0, (now as number) - e.timestamp) / halfLifeMs);
    const cur = acc.get(p.key) ?? { sum: 0, weight: 0, count: 0 };
    cur.sum += outcomeValue(p) * w;
    cur.weight += w;
    cur.count += 1;
    acc.set(p.key, cur);
  }
  return [...acc.entries()]
    .map(([key, v]) => ({ key, count: v.count, rank: v.weight > 0 ? v.sum / v.weight : 0 }))
    .sort((a, b) => b.rank - a.rank);
}

/**
 * Rank keys by how well their choices turned out (mean success/score). Feed to
 * `rankedRouter(rankFromOutcomes(events))` (@loom/reasoning) to route future work
 * toward proven models — the outcome-driven counterpart to `rankModels` (which ranks
 * by frequency chosen). The resulting route is still recorded via `ctx.decide` (P9).
 *
 * This projection DROPS the sample counts, so a router fed from it cannot tell one
 * lucky success from ten thousand consistent ones and cannot apply a sample floor.
 * Prefer passing `outcomeAnalytics(events)` itself to `rankedRouter`/`ucb1`.
 */
export function rankFromOutcomes(
  events: EventEnvelope[],
  opts: OutcomeAnalyticsOptions = {}
): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const s of outcomeAnalytics(events, opts)) out[s.key] = s.rank;
  return out;
}
