import type { EventEnvelope } from "@loom/core";

// ── Invariants — the properties every fault schedule must preserve ────────────
//
// An `Invariant` is a pure predicate over an execution's DURABLE log (the events
// that actually survived the injected faults). These are the kernel guarantees a
// simulation is trying to falsify: run thousands of seeded fault schedules, and if
// any leaves the log in a state that violates one of these, DST has found a bug and
// hands back the minimal schedule that reproduces it.

export interface InvariantContext {
  /** The durable event log for the target execution, in sequence order. */
  readonly log: readonly EventEnvelope[];
}

export interface InvariantResult {
  ok: boolean;
  /** Populated on failure: a small, human-readable explanation + offending data. */
  evidence?: unknown;
}

export interface Invariant {
  name: string;
  check(ctx: InvariantContext): InvariantResult;
}

const fenceOf = (e: EventEnvelope): number | undefined => {
  const f = e.metadata?.fence;
  return typeof f === "number" ? f : undefined;
};

const TERMINAL = new Set([
  "EXECUTION_COMPLETED",
  "EXECUTION_FAILED",
  "EXECUTION_CANCELLED",
  "EXECUTION_CONTINUED", // ADR 0109: a continued execution's one terminal fact
]);

/**
 * A non-idempotent effect must leave at most one durable completion per step: after
 * crash-recovery converges, the log must not show the same step completed twice (the
 * K9 at-least-once window must collapse to exactly-once in the log).
 */
const noDoubleNonIdempotentEffect: Invariant = {
  name: "noDoubleNonIdempotentEffect",
  check({ log }) {
    const completions = new Map<string, number>();
    for (const e of log) {
      if (e.eventType !== "STEP_COMPLETED") continue;
      const stepId = (e.payload as { stepId?: string }).stepId;
      if (stepId === undefined) continue;
      completions.set(stepId, (completions.get(stepId) ?? 0) + 1);
    }
    const doubled = [...completions.entries()].filter(([, n]) => n > 1);
    return doubled.length === 0 ? { ok: true } : { ok: false, evidence: { doubledSteps: doubled } };
  },
};

/** The durable log must be a gap-free, duplicate-free sequence starting at 0. */
const logPrefixConsistency: Invariant = {
  name: "logPrefixConsistency",
  check({ log }) {
    if (log.length === 0) return { ok: true };
    const seqs = log.map((e) => e.sequence);
    for (let i = 0; i < seqs.length; i++) {
      if (seqs[i] !== i) {
        return {
          ok: false,
          evidence: { expected: i, got: seqs[i], at: log[i]?.eventType },
        };
      }
    }
    return { ok: true };
  },
};

/** Fencing tokens (K9.4) recorded in the log must never decrease. */
const fenceMonotonic: Invariant = {
  name: "fenceMonotonic",
  check({ log }) {
    let max = Number.NEGATIVE_INFINITY;
    for (const e of log) {
      const f = fenceOf(e);
      if (f === undefined) continue;
      if (f < max)
        return { ok: false, evidence: { sequence: e.sequence, fence: f, priorMax: max } };
      max = f;
    }
    return { ok: true };
  },
};

/** An execution must record at most one terminal event (never both completed & failed). */
const exactlyOnceOutcome: Invariant = {
  name: "exactlyOnceOutcome",
  check({ log }) {
    const terminals = log.filter((e) => TERMINAL.has(e.eventType));
    return terminals.length <= 1
      ? { ok: true }
      : { ok: false, evidence: { terminals: terminals.map((e) => e.eventType) } };
  },
};

/**
 * A terminally-completed execution must have converged: every step that STARTED has
 * a matching COMPLETED/FAILED (no step left dangling in the durable log). Executions
 * that ended suspended or failed are exempt — they may legitimately hold an open step
 * (e.g. an in-doubt parking).
 */
const resumeConvergence: Invariant = {
  name: "resumeConvergence",
  check({ log }) {
    const completed = log.some((e) => e.eventType === "EXECUTION_COMPLETED");
    if (!completed) return { ok: true };
    const started = new Set<string>();
    const settled = new Set<string>();
    for (const e of log) {
      const stepId = (e.payload as { stepId?: string }).stepId;
      if (stepId === undefined) continue;
      if (e.eventType === "STEP_STARTED") started.add(stepId);
      else if (e.eventType === "STEP_COMPLETED" || e.eventType === "STEP_FAILED")
        settled.add(stepId);
    }
    const dangling = [...started].filter((s) => !settled.has(s));
    return dangling.length === 0
      ? { ok: true }
      : { ok: false, evidence: { danglingSteps: dangling } };
  },
};

/** The five built-in kernel invariants, keyed by name. */
export const INVARIANTS = {
  noDoubleNonIdempotentEffect,
  logPrefixConsistency,
  fenceMonotonic,
  exactlyOnceOutcome,
  resumeConvergence,
} as const;

/** All built-in invariants as a list (the default checked set). */
export const ALL_INVARIANTS: readonly Invariant[] = Object.values(INVARIANTS);
