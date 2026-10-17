import { openKnowledgeBase } from "@loom/knowledge";
import { InMemoryMemoryStore, type MemoryStore, queryTerms } from "@loom/memory";
import { PostgresMemoryStore } from "@loom/plugin-postgres";
import { SqliteMemoryStore } from "@loom/plugin-sqlite";
import { type Scores, type Thresholds, toRows } from "../gate";
import { mean, ndcgAtK, recallAtK } from "../metrics";
import type { MetricRow } from "../scoreboard";
import { DOCS } from "./corpus";
import { QUERIES, type RetrievalQuery } from "./queries";

// ── The retrieval subjects ────────────────────────────────────────────────────
//
// The same corpus and the same labelled queries run through EVERY MemoryStore backend, by two routes:
//  - `memory`: `MemoryStore.search(key, query)` directly (ADR 0090), the entry id is the document id;
//  - `knowledge`: `openKnowledgeBase(store).retrieve(query)` (ADR 0091), the passage's docId is the document id.
// Only public APIs are used. Each backend ranks differently (reference scorer, FTS5 bm25, `ts_rank`), which is
// why scores are per backend and a divergence between them is a finding, not noise.

export type BackendName = "memory" | "sqlite" | "postgres";

export interface Backend {
  readonly name: BackendName;
  open(): Promise<MemoryStore & { close?(): Promise<void> }>;
}

export const BACKENDS: readonly Backend[] = [
  { name: "memory", open: async () => new InMemoryMemoryStore() },
  { name: "sqlite", open: async () => new SqliteMemoryStore(":memory:") },
];

/** The Postgres backend, when `LOOM_TEST_POSTGRES_URL` is set; otherwise `undefined` and the caller says why. */
export function postgresBackend(
  env: Readonly<Record<string, string | undefined>> = process.env
): Backend | undefined {
  const url = env.LOOM_TEST_POSTGRES_URL;
  if (url === undefined || url === "") return undefined;
  return { name: "postgres", open: async () => new PostgresMemoryStore(url) };
}

/** Why the Postgres leg did not run, printed by the suite and the runner so a skip is never silent. */
export const POSTGRES_SKIP_REASON =
  "LOOM_TEST_POSTGRES_URL is not set: the Postgres leg is skipped (start a local PG 17 and set it to run all three backends)";

export const SEARCH_LIMIT = 10;

/** Where a corpus lives in the store. A fixed key, cleared before and after, so a re-run is clean. */
const KEY = "evals-retrieval-corpus";

const decide = <T>(_key: string, fn: () => Promise<T> | T): Promise<T> =>
  Promise.resolve().then(fn);

export type SearchFn = (query: string) => Promise<string[]>;

/** Wraps a store so the query the backend receives is rewritten first (used to inject a degraded `queryTerms`). */
export function withQueryRewrite(
  store: MemoryStore,
  rewrite: (query: string) => string
): MemoryStore {
  return {
    append: (k, e) => store.append(k, e),
    read: (k) => store.read(k),
    clear: (k) => store.clear(k),
    ...(store.replace !== undefined && {
      replace: (k, es) => (store.replace as NonNullable<typeof store.replace>)(k, es),
    }),
    ...(store.remove !== undefined && {
      remove: (k, ids) => (store.remove as NonNullable<typeof store.remove>)(k, ids),
    }),
    search: (k, q, o) => (store.search as NonNullable<typeof store.search>)(k, rewrite(q), o),
  };
}

/**
 * A degraded `queryTerms`, as the backend would see it: only the FIRST derived term survives (what an
 * over-aggressive cap would do). A reversed term list is not injected: terms are OR-ed, so order cannot
 * change a bag-of-words ranking and the degradation would be a no-op.
 */
export const truncatedTerms = (query: string): string => queryTerms(query).slice(0, 1).join(" ");

export interface Subject {
  /** Searches the loaded corpus; ids are document ids `dNN`. */
  readonly memory: SearchFn;
  readonly knowledge: SearchFn;
  /** Same two routes through a store whose `search` receives a degraded query. */
  readonly degraded: { readonly memory: SearchFn; readonly knowledge: SearchFn };
  /** Raw store search for the pathological query (returns the hit count). */
  readonly rawSearch: (query: string) => Promise<number>;
  close(): Promise<void>;
}

/** Load the corpus into a fresh store of `backend` and return the search routes over it. */
export async function openSubject(backend: Backend): Promise<Subject> {
  const store = await backend.open();
  await store.clear(KEY);
  await store.clear(`${KEY}-kb`);
  await store.clear(`${KEY}-kb::docs`);

  for (const d of DOCS) await store.append(KEY, { id: d.id, content: d.text, timestamp: 0 });
  const kb = openKnowledgeBase(store, { scope: `${KEY}-kb` });
  for (const d of DOCS) await kb.putDoc({ id: d.id, text: d.text });

  const bad = withQueryRewrite(store, truncatedTerms);
  const badKb = openKnowledgeBase(bad, { scope: `${KEY}-kb` });

  const viaMemory =
    (s: MemoryStore): SearchFn =>
    async (q) =>
      (await (s.search as NonNullable<typeof s.search>)(KEY, q, { limit: SEARCH_LIMIT })).map(
        (e) => e.id
      ) as string[];
  const viaKnowledge =
    (k: typeof kb): SearchFn =>
    async (q) =>
      (await k.retrieve(q, { decide, limit: SEARCH_LIMIT })).map((p) => p.docId);

  return {
    memory: viaMemory(store),
    knowledge: viaKnowledge(kb),
    degraded: { memory: viaMemory(bad), knowledge: viaKnowledge(badKb) },
    rawSearch: async (q) =>
      (await (store.search as NonNullable<typeof store.search>)(KEY, q, { limit: SEARCH_LIMIT }))
        .length,
    close: async () => {
      await store.clear(KEY);
      await store.clear(`${KEY}-kb`);
      await store.clear(`${KEY}-kb::docs`);
      await store.close?.();
    },
  };
}

const relevantOf = (q: RetrievalQuery): string[] => Object.keys(q.grades);

/** Score a search route over the graded queries: recall@5 and nDCG@10. */
export async function scoreRetrieval(search: SearchFn): Promise<Scores> {
  const recall: number[] = [];
  const ndcg: number[] = [];
  for (const q of QUERIES) {
    const ranked = await search(q.query);
    recall.push(recallAtK(ranked, relevantOf(q), 5));
    ndcg.push(ndcgAtK(ranked, q.grades, 10));
  }
  return { "recall@5": mean(recall), "ndcg@10": mean(ndcg) };
}

/** All scoreboard rows of the retrieval area for the backends given. */
export async function measureRetrieval(
  backends: readonly Backend[],
  thresholdsFor: (b: BackendName, route: "memory" | "knowledge") => Thresholds
): Promise<MetricRow[]> {
  const out: MetricRow[] = [];
  for (const backend of backends) {
    const subject = await openSubject(backend);
    try {
      for (const route of ["memory", "knowledge"] as const) {
        out.push(
          ...toRows(
            `retrieval/${backend.name}/${route}`,
            await scoreRetrieval(subject[route]),
            thresholdsFor(backend.name, route)
          )
        );
      }
    } finally {
      await subject.close();
    }
  }
  return out;
}
