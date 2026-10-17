import type { Thresholds } from "../gate";

// Planner gates (ADR 0131 D4.1, S3). A TRIPWIRE, NOT A QUALITY CLAIM: 12 operator intents over hand-authored
// cassettes (PROVENANCE.md), through the real `IntentRuntime` (routing) and `PlannerRuntime.planGraph` (the DAG).
// The "model" is a script of sensible answers, so these measure the runtimes' handling of a model transcript
// (routing fallbacks, plan parsing and validation, the bounded retry, typed refusals), not a model's quality.
//
// Measured on the committed cassettes (2026-10-17), 12 cases:
//
//   graphCorrectness  1.0000 (12/12)  exact structural equality, incl. the repaired plan and the typed refusal
//   routeAccuracy     1.0000 (12/12)  `no-capability` was a MEASURED GAP (11/12 at first measurement): the router
//                                     model answered NONE ("nothing fits") and `IntentRuntime.route` FELL BACK to its
//                                     offline keyword matcher, which routed "Find me a good Italian restaurant for
//                                     dinner tonight." to `diagnose-cpu` on shared words. FIXED 2026-10-17: a model's
//                                     NONE is final (the keyword matcher runs only with no model configured), so the
//                                     case now routes to none as labelled. See PROVENANCE.md.
//
// Floors follow the S2 convention (floor = the score after losing ONE more case, rounded UP, so a single further
// loss falls below the gate):
//
//   graphCorrectness floor = 11/12 = 0.916667, written 0.9167
//   routeAccuracy    floor = 11/12 = 0.916667, written 0.9167 (measured minus one case; was 0.8334 while the gap stood)
//
// Lowering a floor needs a one-line reason in the PR and here; raising is free.

export const PLANNER_THRESHOLDS: Thresholds = {
  graphCorrectness: 0.9167, // measured 1.0000 (12/12)
  routeAccuracy: 0.9167, // measured 1.0000 (12/12)
};
