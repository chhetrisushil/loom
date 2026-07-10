import type { EventEnvelope } from "@loom/core";

// ── Replay cost + scheduler metrics (issue #83) ──────────────────────────────
//
// A direct measure of the work a COLD replay does over a log, plus a live scheduler
// snapshot. Both stay read-only and dependency-free (structural types only) — the
// replay-cost lens folds nothing, it counts the fold work the log implies.

/**
 * Event types whose fold APPENDS to an unbounded durable structure in `variables` — the
 * eight audit lists plus the `_decisions` map. `RESOURCE_METERED`/`QUOTA_EXCEEDED` are
 * excluded: they fold into a FIXED-size accumulator, not a growing list.
 */
const AUDIT_APPEND_TYPES = new Set([
  "DECISION_RECORDED", // _decisions (map, per key)
  "OUTCOME_RECORDED", // _outcomes
  "EFFECT_DENIED", // _denials
  "SAFETY_BLOCKED", // _safety
  "EFFECT_INDOUBT", // _indoubt
  "EXECUTION_MIGRATED", // _migrations
  "APPROVAL_GRANTED", // _approvals
  "EGRESS_DENIED", // _egress
  "TIMER_FIRED", // _timers
]);

export interface ReplayCost {
  /** Events a cold replay folds. Snapshots are out-of-band (no marker in the log), so this
   * is the FULL-tail cost; a resume that loads a snapshot folds only the suffix after it —
   * which is not visible from the event list alone. */
  events: number;
  /** Distinct executions in the set. */
  executions: number;
  /** Fold-handler invocations (one per event). */
  folds: number;
  /** `STEP_STARTED` events — frame allocations during fold. */
  frameAllocations: number;
  /** Events whose fold appends to a durable audit list (decisions/outcomes/denials/…). */
  auditAppends: number;
  /** Per-eventType histogram. */
  byType: Record<string, number>;
}

/**
 * The work a cold replay of `events` implies — a direct fold-cost meter (issue #83): folds
 * = events, frame allocations = `STEP_STARTED`, audit appends = the growing-list events.
 * Pure and log-derived; it does not run the fold.
 */
export function replayCost(events: EventEnvelope[]): ReplayCost {
  const byType: Record<string, number> = Object.create(null);
  const execs = new Set<string>();
  let frameAllocations = 0;
  let auditAppends = 0;
  for (const e of events) {
    byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;
    execs.add(e.executionId);
    if (e.eventType === "STEP_STARTED") frameAllocations += 1;
    if (AUDIT_APPEND_TYPES.has(e.eventType)) auditAppends += 1;
  }
  return {
    events: events.length,
    executions: execs.size,
    folds: events.length,
    frameAllocations,
    auditAppends,
    byType,
  };
}

/** Live scheduler counters. The scheduler is ephemeral and emits no events, so this is a
 * point-in-time read of runtime state, NOT a lens over the durable log. */
export interface SchedulerCounters {
  inFlight: number;
  pending: number;
}

/**
 * Snapshot a scheduler's live counters. Structural parameter (no `@loom/scheduler` dependency)
 * — pass any `{ inFlight, pending }`, e.g. a `Scheduler`.
 */
export function schedulerSnapshot(scheduler: {
  readonly inFlight: number;
  readonly pending: number;
}): SchedulerCounters {
  return { inFlight: scheduler.inFlight, pending: scheduler.pending };
}
