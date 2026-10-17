import type { Thresholds } from "../gate";

// Tool-search floors (ADR 0131 D4.1). A THRESHOLD IS A TRIPWIRE, NOT A QUALITY CLAIM: 48 queries over 72
// tools catch a regression; they do not say how good tool search is.
//
// Policy: threshold = measured - 0.02, measured on the committed dataset (2026-10-17, the first run after the
// labels were frozen). One flipped query moves a metric by about 0.02 to 0.03, so a single regression fails.
// Lowering a number needs a one-line reason in the PR and here. Raising is free.
//
// The same floors apply to both setups the eval measures: the built-in BM25F (`toolSearch/real`) and a custom
// ranker FACTORY built from the sanitized docs (`toolSearch/factory`, the ADR 0125 D15 two-ranker path); the
// factory here builds the same BM25F, so the two must agree.
export const TOOL_SEARCH_THRESHOLDS: Thresholds = {
  "recall@3": 0.9349, // measured 0.9549
  "recall@5": 0.9349, // measured 0.9549
  mrr: 0.9383, // measured 0.9583
  "mrr:plain": 0.9086, // measured 0.9286
  // The stoplist and annotation slices are gated on their own, so that emptying the stoplist or dropping the
  // host annotations is named by the metric that proves it, not hidden inside an average.
  "mrr:stoplist": 0.98, // measured 1.0000 (does NOT discriminate: BM25 IDF already ranks the right tool first without a stoplist)
  // What the stoplist actually buys is a SMALLER, cleaner page (ADR 0125 D15: "bill the customer" finds one tool,
  // not ten): page precision on the function-word queries. Emptying the stoplist drops it to 0.1000.
  "precision:stoplist": 0.135, // measured 0.1550
  "mrr:annotation": 0.98, // measured 1.0000
};
