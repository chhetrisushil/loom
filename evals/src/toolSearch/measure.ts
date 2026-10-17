import {
  Bm25ToolRanker,
  type ToolRanker,
  type ToolRankerFactory,
  ToolSearchSession,
} from "@loom/agent";
import { type ToolDefinition, tool$ } from "@loom/core";
import { z } from "zod";
import { type Scores, type Thresholds, toRows } from "../gate";
import { mean, precision, recallAtK, reciprocalRank } from "../metrics";
import type { MetricRow } from "../scoreboard";
import { ANNOTATIONS, TOOLS } from "./catalogue";
import { QUERIES, type QueryKind } from "./queries";

// ── The tool-search subject ───────────────────────────────────────────────────
//
// Scored through the PUBLIC `ToolSearchSession` (the exact object `agentLoop$({ toolSearch })` drives),
// with no model: a search is `session.run(ctx, key, { query })` and `ctx.decide` is a pass-through, so what
// is measured is the real ranker, the real stoplist, the real host annotations and the real page logic.

/** A search: a query to the tool ids it returned, best first. */
export type ToolRankFn = (query: string) => Promise<string[]>;

/** The knobs a degraded run turns. The REAL configuration is {@link REAL_SETUP}. */
export interface ToolSearchSetup {
  /** Query stoplist; `undefined` = the default list, `[]` disables. */
  readonly stopwords?: readonly string[];
  /** Host annotations; `undefined` = none (what an "annotations ignored" run uses). */
  readonly annotations?: typeof ANNOTATIONS;
  /** A custom ranker or ranker factory (ADR 0125 D13/D15). Absent = the built-in BM25F. */
  readonly ranker?: ToolRanker | ToolRankerFactory;
}

/** What a correctly configured app does: default stoplist, the catalogue's host annotations, built-in BM25F. */
export const REAL_SETUP: ToolSearchSetup = { annotations: ANNOTATIONS };

/** Results per search: the metrics read down to rank 5, and the page is ranked a little deeper than that. */
export const PAGE = 10;

export const toolDefinitions = (): ToolDefinition[] =>
  TOOLS.map((t) =>
    tool$({
      id: t.id,
      name: t.id,
      description: t.description,
      inputSchema: z.object({}).passthrough(),
      outputSchema: z.unknown(),
      ...(t.tags !== undefined && { tags: [...t.tags] }),
    })
  );

const passThrough = {
  decide: async <T>(_key: string, fn: () => Promise<T> | T): Promise<T> => fn(),
};

/** Build a search function over the catalogue. A fresh session per query: no search budget or menu carries over. */
export function toolSearchWith(setup: ToolSearchSetup): ToolRankFn {
  const catalog = toolDefinitions();
  return async (query) => {
    const session = new ToolSearchSession(
      {
        catalog,
        maxPerSearch: PAGE,
        ...(setup.stopwords !== undefined && { stopwords: setup.stopwords }),
        ...(setup.annotations !== undefined && { annotations: setup.annotations }),
        ...(setup.ranker !== undefined && { ranker: setup.ranker }),
      },
      []
    );
    const res = await session.run(passThrough as never, "eval", { query, limit: PAGE });
    if (res.isError) throw new Error(`search failed for "${query}": ${JSON.stringify(res.output)}`);
    return (res.output as { tools: { name: string }[] }).tools.map((t) => t.name);
  };
}

/** Score a search function over the labelled queries. */
export async function scoreToolSearch(search: ToolRankFn): Promise<Scores> {
  const rows: { kind: QueryKind; ranked: string[]; relevant: readonly string[] }[] = [];
  for (const q of QUERIES)
    rows.push({ kind: q.kind, ranked: await search(q.query), relevant: q.relevant });
  const mrrOf = (kind?: QueryKind): number =>
    mean(
      rows
        .filter((r) => kind === undefined || r.kind === kind)
        .map((r) => reciprocalRank(r.ranked, r.relevant))
    );
  return {
    "recall@3": mean(rows.map((r) => recallAtK(r.ranked, r.relevant, 3))),
    "recall@5": mean(rows.map((r) => recallAtK(r.ranked, r.relevant, 5))),
    mrr: mrrOf(),
    "mrr:plain": mrrOf("plain"),
    "mrr:stoplist": mrrOf("stoplist"),
    // Page precision on the function-word queries: the stoplist keeps "the", "of", "for" from matching half the
    // catalogue. Reciprocal rank cannot see that (BM25 IDF already ranks the right tool first); precision can.
    "precision:stoplist": mean(
      rows.filter((r) => r.kind === "stoplist").map((r) => precision(r.ranked, r.relevant))
    ),
    "mrr:annotation": mrrOf("annotation"),
  };
}

// ── Degradations (used by the committed fail-proof tests) ──────────────────────

/** A ranker factory that wraps the REAL BM25F and returns its page reversed (worst first). */
export const reversedRankerFactory: ToolRankerFactory = (docs) => {
  const real = new Bm25ToolRanker(docs);
  return { kind: "degraded-reversed", rank: (q, limit) => [...real.rank(q, limit)].reverse() };
};

/** A custom-ranker factory that is the real BM25F over the sanitized docs (the D15 "two-ranker" path). */
export const bm25FactoryRanker: ToolRankerFactory = (docs) => new Bm25ToolRanker(docs);

export const SETUPS = {
  real: REAL_SETUP,
  factory: { annotations: ANNOTATIONS, ranker: bm25FactoryRanker },
} as const satisfies Record<string, ToolSearchSetup>;

/** All scoreboard rows of the tool-search area (the real setup and the factory setup). */
export async function measureToolSearch(thresholds: Thresholds): Promise<MetricRow[]> {
  const out: MetricRow[] = [];
  for (const [name, setup] of Object.entries(SETUPS)) {
    out.push(
      ...toRows(`toolSearch/${name}`, await scoreToolSearch(toolSearchWith(setup)), thresholds)
    );
  }
  return out;
}
