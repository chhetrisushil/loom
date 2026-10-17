import type { Thresholds } from "../gate";

// appgen gates (ADR 0131 D4.1, S3). A TRIPWIRE, NOT A QUALITY CLAIM: 10 intents over hand-authored cassettes
// (PROVENANCE.md). They measure how `planChangesModel` (its reasoning ladder, semantic validation and self-repair)
// and `applyChanges` handle a given model transcript, and what `planChangesDeterministic` does with the same intents.
// They never measure a model's quality: the "model" is a script of sensible answers.
//
// Measured on the committed cassettes (2026-10-17), 10 cases:
//
//   model arm          validity 1.0000 (10/10)   coverage 0.9000 (9/10 cases fully covered)
//   deterministic arm  validity 1.0000 (10/10)   coverage 0.4000 (4/10: only grammar-shaped intents and `remove <flow>`)
//
// VALIDITY is gated at 100% of the committed cases (every plan was accepted, applied inside the fixture and
// typechecks), as measured; one invalid plan is a regression. The deterministic arm is the same.
//
// COVERAGE is a mean over cases of the recall of the expected items, so the smallest thing that can regress is ONE
// item in the 5-item cases: 1/5 of a case = 0.02 of the mean. The margin is 0.015, deliberately under that, so losing
// a single expected item fails (floor = measured - 0.015). The model arm's 0.9 is not 1.0 on purpose: the
// `edit-remove-digest` case is a MEASURED GAP, not a labelling error. The ChangeSpec prompt and schema of
// `@loom/appgen-model` offer create / extend / modify and no delete, so the model arm cannot plan "remove the digest
// flow" (the deterministic arm can). See PROVENANCE.md; if the planner learns to delete, raise this floor.
//
// Lowering a floor needs a one-line reason in the PR and here; raising is free.

export const APPGEN_THRESHOLDS: Record<"model" | "deterministic", Thresholds> = {
  model: {
    validity: 1, // measured 1.0000
    coverage: 0.885, // measured 0.9000 - 0.015
  },
  deterministic: {
    validity: 1, // measured 1.0000
    coverage: 0.385, // measured 0.4000 - 0.015
  },
};
