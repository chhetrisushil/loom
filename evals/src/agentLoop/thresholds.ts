import type { Thresholds } from "../gate";

// agentLoop$ task gates (ADR 0131 D4.1, S2). A TRIPWIRE, NOT A QUALITY CLAIM: 13 scripted tasks over hand-authored
// cassettes (PROVENANCE.md). They measure the LOOP's handling of a given model transcript (dispatch, parallel
// scope, isError feedback, approval park and resume, tool search, budgets), never a model's quality.
//
// One task is 1/13 = 0.0769 of the success rate and moves each mean by about 1/13 per extra step or tool call.
// Measured on the committed cassettes (2026-10-17): successRate 1.0000 (13/13), meanSteps 2.3846 (31 model calls),
// meanToolCalls 1.7692 (23 tool calls the model asked for).
//
//   successRate floor     = measured - one task's worth = 1 - 1/13 = 0.923077, written 0.9231 (rounded UP, so
//                           that LOSING ONE TASK falls below the gate, as in S1 where one flipped case fails).
//   meanSteps ceiling     = measured + one step in the suite = 32/13 = 2.461538, written 2.4615 (rounded DOWN,
//                           so ONE EXTRA MODEL CALL anywhere exceeds it).
//   meanToolCalls ceiling = measured + one tool call in the suite = 24/13 = 1.846154, written 1.8461 (down).
//
// "Measured plus one" is read as one task's worth of the mean, not +1.0 on the mean: +1.0 on a mean over 13 tasks
// would allow 13 extra model calls, a ceiling nothing realistic could trip.
// Lowering a floor or raising a ceiling needs a one-line reason in the PR and here.

export const AGENT_LOOP_THRESHOLDS: Thresholds = {
  successRate: 0.9231, // measured 1.0000 (13/13)
};

export const AGENT_LOOP_CEILINGS: Thresholds = {
  meanSteps: 2.4615, // measured 2.3846
  meanToolCalls: 1.8461, // measured 1.7692
};
