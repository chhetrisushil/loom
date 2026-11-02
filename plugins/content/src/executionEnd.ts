import type { EventEnvelope } from "@loom/core";

// A terminal timestamp that is not a finite number (NaN, a string from an imported log or a 3P store,
// +-Infinity, null) is not comparable: treat the execution as not ended so the citation clock applies.
const finiteOrUndefined = (t: unknown): number | undefined =>
  typeof t === "number" && Number.isFinite(t) ? t : undefined;

/**
 * ADR 0146 - when did this execution END, as far as the live log can tell? The `at` of its newest
 * kernel terminal event, or `undefined` when it has not ended: no terminal event, or it was RE-OPENED
 * after its newest one (`resumeAs` appends EXECUTION_RESUMED to a terminal execution; a later
 * EXECUTION_SUSPENDED / EXECUTION_STARTED likewise means live). `undefined` makes the sweep fall back
 * to the citation clock, so every uncertainty can only age a ref LATER or equal, never earlier.
 *
 * The terminal set is the one `@loom/workflow-runtime`'s `terminalEndedAt` uses (and the replay VM's
 * `isKernelWritten` check for EXECUTION_CONTINUED); it is duplicated, not imported, so this package
 * takes no dependency on workflow-runtime. `gc.endClock.test.ts` (l) pins it against the ReplayVM.
 * Scans from the tail in sequence order (not timestamp order), usually stopping within a few events.
 */
export function terminalEndOf(events: readonly EventEnvelope[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as EventEnvelope;
    switch (e.eventType) {
      case "EXECUTION_RESUMED":
      case "EXECUTION_SUSPENDED":
      case "EXECUTION_STARTED":
        return undefined;
      case "EXECUTION_COMPLETED":
      case "EXECUTION_FAILED":
      case "EXECUTION_CANCELLED":
        return finiteOrUndefined(e.timestamp);
      case "EXECUTION_CONTINUED":
        if (e.metadata?.kernel === true) return finiteOrUndefined(e.timestamp);
    }
  }
  return undefined;
}

/**
 * ADR 0146 - was this execution RE-OPENED after a terminal event? True iff its tail is live
 * (`terminalEndOf` returns `undefined` because a RESUMED / SUSPENDED / STARTED follows) AND a terminal
 * event (the same set as `terminalEndOf`) precedes that live tail. A run that never ended is false.
 * A terminal event with a non-finite timestamp still counts as an end here (the log shows it ended).
 */
export function wasReopened(events: readonly EventEnvelope[]): boolean {
  let live = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as EventEnvelope;
    switch (e.eventType) {
      case "EXECUTION_RESUMED":
      case "EXECUTION_SUSPENDED":
      case "EXECUTION_STARTED":
        live = true;
        break;
      case "EXECUTION_COMPLETED":
      case "EXECUTION_FAILED":
      case "EXECUTION_CANCELLED":
        return live;
      case "EXECUTION_CONTINUED":
        if (e.metadata?.kernel === true) return live;
    }
  }
  return false;
}
