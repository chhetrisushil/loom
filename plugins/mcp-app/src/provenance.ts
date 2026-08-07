// ── Decision provenance across a long suspension ─────────────────────────────
//
// A gate can stay open for days. In that time the surface keeps advancing, so by
// the time a user clicks Approve their decision may have been made against a
// view of the world that no longer holds.
//
// The kernel already refuses everything it can decide on its own: K11 pins the
// flow CODE a resume runs on (or refuses loudly), K11.5 resumes with the
// recorded migrated input, K12.2 rejects a forged approval, K8.2 keeps cancel
// terminal. None of those can answer "was the human looking at current data?",
// because the execution knows the sequence at which IT suspended — not the
// sequence the human was looking at. For a gate open across days of surface
// churn those are different numbers, and only the second one says whether the
// decision was informed.
//
// This module supplies the missing evidence and deliberately stops there.
// Whether a decision is *too* stale is a domain question — it depends on what
// changed and whether that change matters — so a generic TTL in the framework
// would be policy in the wrong place (P10). What belongs here is the number, and
// a predicate a flow can build its own policy on.
//
// The natural way to act on it is an ADR 0060 typed channel: declare
// `staleDecision` on the step and `fail("staleDecision", { seen, current })`, so
// staleness is a recorded, replay-substituted, branchable outcome that can route
// into re-confirmation — not an exception.

/** The field a View echoes its rendered cursor back on. */
export const SEEN_SEQUENCE_FIELD = "seenSequence";

/**
 * The action payload the surface-host template sends when a user activates a
 * component. `seenSequence` is the cursor the View had folded at the moment of
 * the click — the provenance of the decision.
 */
export interface SurfaceAction {
  surfaceId: string;
  action: string;
  /**
   * The surface sequence the View had rendered when the user acted. Absent when
   * the View never received a payload (or predates this convention) — treat
   * absence as "unknown provenance", which {@link isStale} reports as stale.
   */
  seenSequence?: number;
}

/**
 * Whether a decision was made against a surface older than `currentSequence`.
 *
 * Absence of `seenSequence` counts as STALE. An action with no provenance is
 * indistinguishable from one made against arbitrarily old data, and defaulting
 * unknown to "fresh" would make the check silently vacuous for exactly the
 * clients that need it most.
 *
 * `tolerance` allows a decision to lag by that many sequences — useful when the
 * surface carries chatter (progress ticks, log lines) that cannot invalidate a
 * decision. It is a blunt instrument: prefer a small tolerance plus a domain
 * check over a large one.
 */
export function isStale(
  action: Pick<SurfaceAction, "seenSequence">,
  currentSequence: number,
  tolerance = 0
): boolean {
  if (typeof action.seenSequence !== "number" || !Number.isFinite(action.seenSequence)) {
    return true;
  }
  return action.seenSequence + tolerance < currentSequence;
}
