import { decisionRecords, outcomeRecords } from "@loom/analytics";
import type { DecisionRecord, OutcomeRecord } from "@loom/analytics";
import type { EventEnvelope } from "@loom/core";
import type {
  PolicyContext,
  PolicyStamp,
  Trajectory,
  TrajectoryOptions,
  TrajectoryStep,
} from "./types";

// ── Trajectory extraction + credit assignment ────────────────────────────────
//
// A read lens, like everything in @loom/analytics: it never writes and never
// touches the fold. It turns the durable log into the `(state, action, reward)`
// tuples a learner needs, and does the one piece of that work an application
// cannot do for itself — deciding WHICH decisions a terminal outcome should be
// blamed on.

/**
 * `DECISION_RECORDED.source` values written by `@loom/agent` for replay bookkeeping (R10, ADR 0121):
 * the decision seam is how a nondeterministic VALUE becomes a recorded fact, but these are not
 * choices among alternatives, so they carry no reward and are excluded from trajectories.
 */
export const RECORDED_FACT_SOURCES: ReadonlySet<string> = new Set([
  "agent-response",
  "agent-outcome",
  "agent-abort",
  // R17 (ADR 0122): `@loom/conversation` records its token-budget fit the same way.
  "conversation-budget",
  "conversation-record",
]);

const TERMINAL: Record<string, Trajectory["outcome"]> = {
  EXECUTION_COMPLETED: "completed",
  EXECUTION_FAILED: "failed",
  EXECUTION_CANCELLED: "cancelled",
  // EVENT_SCHEMA 1.23.0 (ADR 0109) — the execution handed its work to a successor. Terminal,
  // but NOT a completion: it says nothing about decision quality (the chain's last generation does).
  EXECUTION_CONTINUED: "continued",
};

function defaultTerminalReward(outcome: Trajectory["outcome"]): number | undefined {
  if (outcome === "completed") return 1;
  if (outcome === "failed") return 0;
  return undefined; // cancelled/continued/open says nothing about decision quality
}

function outcomeValue(o: OutcomeRecord): number {
  if (typeof o.score === "number") return o.score;
  if (typeof o.success === "boolean") return o.success ? 1 : 0;
  return 0;
}

/**
 * Recover the action set a decision chose FROM.
 *
 * First choice is the decision's own `alternatives` (ADR 0030 D1) — the only
 * authoritative answer, because it is what the policy actually saw. Failing that
 * we fall back to every distinct choice observed for the same `decisionId`
 * anywhere in the supplied log, which is a *guess*: it can only contain actions
 * some policy already picked, so it systematically omits the arms that were never
 * tried. Evaluation reports say so rather than quietly pretending otherwise.
 */
function actionSets(decisions: readonly DecisionRecord[]): Map<string, unknown[]> {
  const observed = new Map<string, Map<string, unknown>>();
  for (const d of decisions) {
    let seen = observed.get(d.decisionId);
    if (seen === undefined) {
      seen = new Map();
      observed.set(d.decisionId, seen);
    }
    seen.set(stableKey(d.choice), d.choice);
  }
  const out = new Map<string, unknown[]>();
  for (const [id, seen] of observed) out.set(id, [...seen.values()]);
  return out;
}

/** A stable identity for an action, so choices can be compared and de-duplicated. */
export function stableKey(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return `{${entries.map(([k, v]) => `${k}:${stableKey(v)}`).join(",")}}`;
}

/**
 * Mine `(context, action, reward)` trajectories out of a raw event log.
 *
 * Credit assignment, in order of preference:
 *  1. **direct** — an `OUTCOME_RECORDED` naming this `decisionId`. Measured, so it wins.
 *     Several outcomes for one decision are averaged.
 *  2. **terminal** — the execution's own result, discounted backwards from the last
 *     decision (`discount ** stepsFromEnd`). Applied only to steps with no direct
 *     outcome, unless `terminalCreditOnScored` says otherwise; summing a measured
 *     reward with an inferred one double-counts.
 *  3. **none** — nothing scored this decision. `reward` stays undefined and evaluation
 *     skips the step rather than silently treating it as a zero.
 */
export function trajectories<A = unknown>(
  events: readonly EventEnvelope[],
  opts: TrajectoryOptions = {}
): Trajectory<A>[] {
  const discount = opts.discount ?? 1;
  if (!(discount > 0 && discount <= 1)) {
    throw new Error(`trajectories: discount must be in (0,1], got ${discount}`);
  }
  const terminalRewardOf = opts.terminalReward ?? ((outcome) => defaultTerminalReward(outcome));

  const all = events as EventEnvelope[];
  // R10 — recorded FACTS that share the decision log with real choices (a model response, a tool
  // outcome, an abort checkpoint) are not actions of any policy: counting them would dilute the
  // terminal-credit discount and pollute the fallback action sets.
  const decisions = decisionRecords(all).filter((d) => !RECORDED_FACT_SOURCES.has(d.source ?? ""));
  const outcomes = outcomeRecords(all);
  const fallbackActions = actionSets(decisions);

  // decisionId is unique within an execution (it keys ctx.decide), so
  // `${executionId}\u0000${decisionId}` uniquely identifies a step. NUL is the separator
  // because it cannot occur in either id, so no pair of ids can spell another pair's key.
  // Written as the ESCAPE, never as a literal NUL byte: a raw one makes git classify the
  // whole file as binary, silently costing every diff, blame and review of it.
  const direct = new Map<string, { sum: number; count: number }>();
  for (const o of outcomes) {
    if (o.decisionId === undefined) continue;
    const key = `${o.executionId}\u0000${o.decisionId}`;
    const cur = direct.get(key) ?? { sum: 0, count: 0 };
    cur.sum += outcomeValue(o);
    cur.count += 1;
    direct.set(key, cur);
  }

  // Group decisions by execution, preserving log order.
  const byExecution = new Map<string, DecisionRecord[]>();
  for (const d of decisions) {
    const list = byExecution.get(d.executionId);
    if (list === undefined) byExecution.set(d.executionId, [d]);
    else list.push(d);
  }

  const terminals = new Map<string, Trajectory["outcome"]>();
  const terminalEvents = new Map<string, EventEnvelope[]>();
  for (const e of events) {
    const outcome = TERMINAL[e.eventType];
    if (outcome === undefined) continue;
    // A continuation counts only when the kernel stamped it (the fold's own rule).
    if (e.eventType === "EXECUTION_CONTINUED" && e.metadata?.kernel !== true) continue;
    terminals.set(e.executionId, outcome);
    const list = terminalEvents.get(e.executionId);
    if (list === undefined) terminalEvents.set(e.executionId, [e]);
    else list.push(e);
  }

  const out: Trajectory<A>[] = [];
  for (const [executionId, list] of byExecution) {
    list.sort((a, b) => a.sequence - b.sequence);
    const outcome = terminals.get(executionId) ?? "open";
    const terminalReward = terminalRewardOf(outcome, terminalEvents.get(executionId) ?? []);

    const steps: TrajectoryStep<A>[] = list.map((d, i) => {
      const measured = direct.get(`${executionId}\u0000${d.decisionId}`);
      const directReward = measured === undefined ? undefined : measured.sum / measured.count;

      const credit =
        terminalReward === undefined
          ? undefined
          : terminalReward * discount ** (list.length - 1 - i);

      let reward: number | undefined;
      let rewardSource: TrajectoryStep["rewardSource"];
      if (directReward !== undefined) {
        // Measured beats inferred. Terminal credit is added on top only when the
        // caller explicitly asks, because the two rewards are not independent.
        reward =
          opts.terminalCreditOnScored === true && credit !== undefined
            ? directReward + credit
            : directReward;
        rewardSource = "direct";
      } else if (credit !== undefined) {
        reward = credit;
        rewardSource = "terminal";
      } else {
        rewardSource = "none";
      }

      const alternatives = Array.isArray(d.alternatives) ? (d.alternatives as A[]) : undefined;
      return {
        decisionId: d.decisionId,
        executionId,
        sequence: d.sequence,
        timestamp: d.timestamp,
        action: d.choice as A,
        ...(d.context !== undefined && { context: d.context as PolicyContext }),
        ...(d.policy !== undefined && { policy: d.policy as PolicyStamp }),
        actions: alternatives ?? ((fallbackActions.get(d.decisionId) ?? []) as A[]),
        ...(reward !== undefined && { reward }),
        rewardSource,
        ...(directReward !== undefined && { directReward }),
      };
    });

    const unit = opts.unitOf?.(executionId, steps[0]?.context);
    out.push({
      executionId,
      ...(unit !== undefined && { unit }),
      steps,
      ...(terminalReward !== undefined && { terminalReward }),
      outcome,
    });
  }
  return out;
}

/** Flatten trajectories back to a step list — the usual input to an offline learner. */
export function steps<A = unknown>(trajectories: readonly Trajectory<A>[]): TrajectoryStep<A>[] {
  const out: TrajectoryStep<A>[] = [];
  for (const t of trajectories) out.push(...t.steps);
  return out;
}
