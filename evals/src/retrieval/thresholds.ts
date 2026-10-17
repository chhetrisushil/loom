import type { Thresholds } from "../gate";
import type { BackendName } from "./measure";

// Retrieval floors (ADR 0131 D4.1, ADR 0090/0091). A TRIPWIRE, NOT A QUALITY CLAIM: 33 queries over 40
// documents. threshold = measured - 0.02 (2026-10-17), measured per backend because the backends rank
// differently: the reference scorer (`InMemoryMemoryStore`), SQLite FTS5 bm25, and Postgres `ts_rank`.
//
// A backend-specific floor is allowed only with a reason, and here the reason is the measured divergence
// (recall@5 / nDCG@10): memory 0.8030 / 0.7213, sqlite 0.7879 / 0.7782, postgres 0.7121 / 0.7031. Postgres is
// lowest because `ts_rank` has no inverse-document-frequency, so common words in a conversational query
// ("my", "the", "how") weigh as much as the rare one that names the topic. This is reported as a finding in
// the PR; the floor records today's behaviour, it does not endorse it.
//
// Both routes (`MemoryStore.search` and `KnowledgeBase.retrieve`) measure identically on every backend (a
// one-chunk-per-document corpus), so they share a floor.
const FLOORS: Readonly<Record<BackendName, Thresholds>> = {
  memory: {
    "recall@5": 0.783, // measured 0.8030
    "ndcg@10": 0.7013, // measured 0.7213
  },
  sqlite: {
    "recall@5": 0.7679, // measured 0.7879
    "ndcg@10": 0.7582, // measured 0.7782
  },
  postgres: {
    "recall@5": 0.6921, // measured 0.7121
    "ndcg@10": 0.6831, // measured 0.7031
  },
};

export function retrievalThresholds(
  backend: BackendName,
  _route: "memory" | "knowledge"
): Thresholds {
  return FLOORS[backend];
}
