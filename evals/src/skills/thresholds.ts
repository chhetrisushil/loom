import type { Thresholds } from "../gate";

// Skill-discovery floors (`discovery: "search"`, ADR 0125 D12/D13). A tripwire, not a quality claim: 30 intents
// over 15 skills. threshold = measured - 0.02 (2026-10-17), applied to both modes (one combined index; two
// rankers with a host `skillRanker`), which measure the same BM25F and must agree.
//
// hit@3 equals hit@1 here: BM25F returns only skills that share a term with the intent, and the five misses
// (i06, i07, i11, i23, i24) are either empty results or a wrong top hit with the right skill absent from the
// top three. That is lexical search's honest ceiling on this dataset, and the reason a semantic ranker (R18)
// is a seam rather than a rewrite.
export const SKILL_THRESHOLDS: Thresholds = {
  "hit@1": 0.8133, // measured 0.8333
  "hit@3": 0.8133, // measured 0.8333
};
