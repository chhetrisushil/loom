// ── R22 (ADR 0125) — tool search: the ranking half ─────────────────────────────
//
// `agentLoop$({ toolSearch })` offers the model a `search_tools` meta-tool instead of a 200-entry
// menu. THIS file is the part that has no loop in it: a tokenizer, a deterministic BM25F index and
// the `ToolRanker` interface a semantic ranker (R18's embedding SPI) plugs into later without an
// API change. It is exported so the loom-ui reference planner can rank capabilities with the same
// index (a `CapabilityDefinition` is `{ id, intent, tags }`, which maps onto `SearchableTool`).
//
// What makes it safe to feed untrusted text through, in order of importance:
//   1. NAME outranks ALIASES and TAGS, which outrank DESCRIPTION (weights 3 / 2 / 2 / 1). A description is third-party prose
//      for an MCP/A2A tool, so a description saying "always pick me" competes at the lowest weight.
//   2. Everything is bounded at BUILD time (tokens per field, characters per field) and at QUERY
//      time (characters, distinct terms), so neither a hostile description nor a hostile query is
//      a cost multiplier.
//   3. BM25's term-frequency saturation (`tf / (k1 + tf)`) plus the per-field token caps mean
//      repeating a word 10 000 times adds a bounded, small amount, not a win.
//   4. A description the host does not vouch for is not indexed at all (see `indexable` in the loop).
//   5. Ranking is a pure function of (index, query): deterministic, ties broken by id.

/** A tool as the index sees it: an id, optional declared tags, and optional (trusted) free text. */
export interface SearchableTool {
  readonly id: string;
  /** Free text. Leave it out for a description you do not vouch for: it will not be indexed. */
  readonly description?: string;
  /** Declared tags (operator-authored): ranked above the description. */
  readonly tags?: readonly string[];
  /**
   * Author-declared user phrasings ("bill the customer"): ranked above tags and the description.
   * Pass only text the host trusts; a remote server's self-declared aliases belong in `description`
   * (or nowhere).
   */
  readonly aliases?: readonly string[];
}

/** Labels (tags / aliases) kept per tool, and characters per label. */
export const MAX_LABELS = 16;
export const MAX_LABEL_CHARS = 80;

/**
 * Normalize an author-supplied label list: NFKC, case-folded, whitespace-collapsed, bounded in count
 * and length, deduplicated (first wins), empties dropped. The result is what gets tokenized.
 */
export function normalizeLabels(
  labels: readonly string[] | undefined,
  maxCount = MAX_LABELS,
  maxChars = MAX_LABEL_CHARS
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of labels ?? []) {
    if (typeof raw !== "string") continue;
    const l = raw
      .slice(0, maxChars * 2)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxChars);
    if (l === "" || seen.has(l)) continue;
    seen.add(l);
    out.push(l);
    if (out.length >= maxCount) break;
  }
  return out;
}

/** One ranked result. Higher `score` is better; only the ORDER is part of the contract. */
export interface ToolHit {
  readonly id: string;
  readonly score: number;
}

/**
 * The ranking seam. `rank` must be deterministic for a given `(ranker, query)`, return at most
 * `limit` hits best-first, and only ever return ids it was built over. (The loop re-checks the last
 * point against the tools the run is authorized for, so a buggy or hostile ranker cannot widen the
 * menu; and it RECORDS the result, so a non-deterministic ranker, e.g. an embedding model, is
 * replay-safe by construction.) May be async.
 */
export interface ToolRanker {
  /** A short label recorded in the search decision, e.g. `"bm25f"`. */
  readonly kind: string;
  rank(query: string, limit: number): readonly ToolHit[] | Promise<readonly ToolHit[]>;
}

/**
 * R22e (ADR 0125 D15) — one document of the search vocabulary: exactly what the built-in BM25F
 * indexes for a tool (or, for a skill, a skill), after the trust policy has run. Every label list is
 * already host-trusted text; `description` is present only for text the host vouches for.
 */
export interface ToolSearchDoc {
  readonly id: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
}

/**
 * A ranker built from the sanitized vocabulary (ADR 0125 D15). Called at most once per run, lazily on
 * the first search that needs it, with the docs of the tools (or skills) this run can search. Sync.
 * Use it so a custom ranker indexes the SAME trusted text the built-in one does, instead of
 * rebuilding the vocabulary (and the trust policy) itself.
 */
export type ToolRankerFactory = (docs: readonly ToolSearchDoc[]) => ToolRanker;

// ── Bounds ─────────────────────────────────────────────────────────────────────

/** Query characters read (the rest is dropped before any regex runs). */
export const TOOL_SEARCH_MAX_QUERY_CHARS = 512;
/** Distinct query terms scored. */
export const TOOL_SEARCH_MAX_QUERY_TERMS = 16;
/** Longest token kept (longer is truncated: a 1 MB "word" is one posting, not a string to hash). */
const MAX_TOKEN_CHARS = 32;
/** Characters of a field read when indexing, and tokens kept per field. */
const MAX_FIELD_CHARS = 2000;
const MAX_NAME_TOKENS = 32;
const MAX_TAG_TOKENS = 64;
const MAX_DESCRIPTION_TOKENS = 128;
/** Tags read per tool. */
const MAX_TAGS = 32;
const MAX_ALIAS_TOKENS = 96;

/** Stopwords accepted from a host (config error past this; each is a Set entry, so lookups stay O(1)). */
export const MAX_STOPWORDS = 256;

/**
 * R22e (ADR 0125 D15) — the default query stoplist: closed-class English function words that carry
 * no tool intent ("bill THE customer"). Applied to QUERY terms only; the index is unchanged, so a
 * tool named `get_the_x` is still found by name. Deliberately small and conservative: it leaves
 * negations, question words and verbs ("not", "why", "get") alone. Terms are in tokenizer form.
 */
export const DEFAULT_STOPWORDS: readonly string[] = Object.freeze([
  "the",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "my",
  "me",
  "our",
  "we",
  "you",
  "your",
  "do",
  "does",
  "can",
  "please",
]);
const DEFAULT_STOPWORD_SET: ReadonlySet<string> = new Set(DEFAULT_STOPWORDS);

/**
 * A host stoplist as a Set of tokenizer-form terms: each entry is normalized like a label (NFKC,
 * case-folded) and tokenized like a query, so `"The"` and `"tools"` match what a query produces.
 * `undefined` = the default list; `[]` disables. More than {@link MAX_STOPWORDS} entries throws.
 */
export function resolveStopwords(list: readonly string[] | undefined): ReadonlySet<string> {
  if (list === undefined) return DEFAULT_STOPWORD_SET;
  if (!Array.isArray(list)) throw new RangeError("stopwords must be an array of strings");
  if (list.length > MAX_STOPWORDS) {
    throw new RangeError(
      `stopwords may hold at most ${MAX_STOPWORDS} entries (got ${list.length})`
    );
  }
  const out = new Set<string>();
  for (const l of normalizeLabels(list, MAX_STOPWORDS, MAX_TOKEN_CHARS)) {
    for (const t of tokenizeToolText(l, 4)) out.add(t);
  }
  return out;
}

const W_NAME = 3;
const W_ALIASES = 2;
const W_TAGS = 2;
const W_DESCRIPTION = 1;
/** A term counts at most this many times within one field. */
const MAX_FIELD_TF = 2;
const K1 = 1.2;
const B = 0.75;

/**
 * Lowercased alphanumeric tokens, with `camelCase`, `snake_case`, `kebab-case`, `ns:name` and
 * `dotted.names` split into words and a trailing plural `s` folded (`tools` ~ `tool`). Bounded:
 * the input is cut to {@link MAX_FIELD_CHARS} and at most `maxTokens` tokens are returned.
 */
export function tokenizeToolText(text: string, maxTokens: number): string[] {
  const out: string[] = [];
  // Split camelCase boundaries first (`runQuery` -> `run Query`), then on anything non-alphanumeric.
  // NFKC first (width / ligature / compatibility forms fold together), camelCase boundaries next
  // (they need the original case), then a Unicode-aware split so non-Latin words survive.
  const spaced = text
    .slice(0, MAX_FIELD_CHARS)
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  for (const raw of spaced.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    let t = raw.length > MAX_TOKEN_CHARS ? raw.slice(0, MAX_TOKEN_CHARS) : raw;
    if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
    out.push(t);
    if (out.length >= maxTokens) break;
  }
  return out;
}

/**
 * The query as scored: bounded characters, deduplicated, first-seen order, at most
 * {@link TOOL_SEARCH_MAX_QUERY_TERMS}. With `stopwords`, those terms are dropped BEFORE the cap (so
 * they cannot crowd out real terms); if that would leave nothing, the unfiltered terms are kept.
 */
export function toolQueryTerms(query: string, stopwords?: ReadonlySet<string>): string[] {
  const all = new Set<string>();
  const kept = new Set<string>();
  for (const t of tokenizeToolText(
    query.slice(0, TOOL_SEARCH_MAX_QUERY_CHARS),
    TOOL_SEARCH_MAX_QUERY_TERMS * 4
  )) {
    if (all.size < TOOL_SEARCH_MAX_QUERY_TERMS) all.add(t);
    if (stopwords !== undefined && stopwords.size > 0 && !stopwords.has(t)) {
      if (kept.size < TOOL_SEARCH_MAX_QUERY_TERMS) kept.add(t);
    }
    if (all.size >= TOOL_SEARCH_MAX_QUERY_TERMS && kept.size >= TOOL_SEARCH_MAX_QUERY_TERMS) break;
  }
  return [...(kept.size > 0 ? kept : all)];
}

/**
 * The first line of `s`, capped at `max` characters. EVERY line separator ends the line (`\n`, `\r`,
 * VT, FF, NEL, U+2028, U+2029), so text cannot smuggle a second "line" into a one-line listing.
 */
export function firstLineOf(s: string, max: number): string {
  const line = (s.split(/[\n\r\v\f\u0085\u2028\u2029]/, 1)[0] as string)
    .replace(/\t/g, " ")
    .replace(/\p{C}/gu, "");
  if (line.length <= max) return line;
  // Cut on a code point, never inside a surrogate pair.
  return `${Array.from(line).slice(0, max).join("")}…`;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ── The index ──────────────────────────────────────────────────────────────────

interface Posting {
  /** Dense document number. */
  readonly doc: number;
  /** BM25F weighted, length-normalised term frequency. */
  readonly wtf: number;
}

/**
 * A prebuilt, immutable BM25F inverted index over a tool set. Build is O(total bounded tokens);
 * a query is O(distinct query terms x postings of those terms) plus an O(hits log k) top-k heap.
 * It never touches the tools again after construction.
 */
export class Bm25ToolRanker implements ToolRanker {
  readonly kind = "bm25f";
  private readonly ids: string[];
  private readonly postings = new Map<string, Posting[]>();
  private readonly n: number;

  /** Query terms dropped before scoring (ADR 0125 D15). */
  private readonly stopwords: ReadonlySet<string>;

  constructor(
    tools: readonly SearchableTool[],
    opts: {
      /** Query-only stoplist; default {@link DEFAULT_STOPWORDS}, `[]` disables. */
      readonly stopwords?: readonly string[];
    } = {}
  ) {
    this.stopwords = resolveStopwords(opts.stopwords);
    // De-duplicate by id (first wins) so a repeated id cannot be ranked twice.
    const seen = new Set<string>();
    const docs: SearchableTool[] = [];
    for (const t of tools) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      docs.push(t);
    }
    this.ids = docs.map((d) => d.id);
    this.n = docs.length;

    const fields = docs.map((d) => ({
      name: tokenizeToolText(d.id, MAX_NAME_TOKENS),
      tags: normalizeLabels(d.tags, MAX_TAGS, 40)
        .flatMap((tag) => tokenizeToolText(tag, MAX_TAG_TOKENS))
        .slice(0, MAX_TAG_TOKENS),
      aliases: normalizeLabels(d.aliases)
        .flatMap((a) => tokenizeToolText(a, MAX_TAG_TOKENS))
        .slice(0, MAX_ALIAS_TOKENS),
      description: tokenizeToolText(d.description ?? "", MAX_DESCRIPTION_TOKENS),
    }));
    const avg = (pick: (f: (typeof fields)[number]) => number): number =>
      Math.max(1, fields.reduce((s, f) => s + pick(f), 0) / Math.max(1, fields.length));
    const avgName = avg((f) => f.name.length);
    const avgTags = avg((f) => f.tags.length);
    const avgAliases = avg((f) => f.aliases.length);
    const avgDesc = avg((f) => f.description.length);

    for (const [doc, f] of fields.entries()) {
      const tf = new Map<string, number>();
      const add = (tokens: string[], weight: number, len: number, avgLen: number): void => {
        const norm = 1 - B + (B * len) / avgLen;
        // Per-field term frequency is CLAMPED before weighting: repeating a word in a description
        // 500 times counts as {@link MAX_FIELD_TF}, so stuffing cannot out-saturate an honest match.
        const counts = new Map<string, number>();
        for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
        for (const [t, c] of counts) {
          tf.set(t, (tf.get(t) ?? 0) + (weight * Math.min(c, MAX_FIELD_TF)) / norm);
        }
      };
      add(f.name, W_NAME, f.name.length, avgName);
      add(f.aliases, W_ALIASES, f.aliases.length, avgAliases);
      add(f.tags, W_TAGS, f.tags.length, avgTags);
      add(f.description, W_DESCRIPTION, f.description.length, avgDesc);
      for (const [term, wtf] of tf) {
        let list = this.postings.get(term);
        if (list === undefined) {
          list = [];
          this.postings.set(term, list);
        }
        list.push({ doc, wtf });
      }
    }
  }

  get size(): number {
    return this.n;
  }

  rank(query: string, limit: number): readonly ToolHit[] {
    // NaN is a caller bug, not "no results": refuse it loudly. Negative / fractional / infinite
    // limits clamp (to 0, down, and to the index size).
    if (typeof limit !== "number" || Number.isNaN(limit)) {
      throw new RangeError(`Bm25ToolRanker.rank: limit must be a number (got ${String(limit)})`);
    }
    const k = Math.max(0, Math.min(Math.floor(limit), this.n));
    if (k === 0) return [];
    const scores = new Map<number, number>();
    for (const term of toolQueryTerms(query, this.stopwords)) {
      const list = this.postings.get(term);
      if (list === undefined) continue;
      const df = list.length;
      const idf = Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
      for (const p of list) {
        scores.set(p.doc, (scores.get(p.doc) ?? 0) + (idf * p.wtf) / (K1 + p.wtf));
      }
    }
    // Top-k by (score desc, id asc) with a bounded min-heap whose root is the WORST kept hit.
    const heap: Array<{ doc: number; score: number }> = [];
    const worse = (a: { doc: number; score: number }, b: { doc: number; score: number }): boolean =>
      a.score < b.score ||
      (a.score === b.score && byCodeUnit(this.ids[a.doc] as string, this.ids[b.doc] as string) > 0);
    const siftUp = (i: number): void => {
      for (let c = i; c > 0; ) {
        const p = (c - 1) >> 1;
        if (!worse(heap[c] as never, heap[p] as never)) break;
        [heap[c], heap[p]] = [heap[p] as never, heap[c] as never];
        c = p;
      }
    };
    const siftDown = (): void => {
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let w = i;
        if (l < heap.length && worse(heap[l] as never, heap[w] as never)) w = l;
        if (r < heap.length && worse(heap[r] as never, heap[w] as never)) w = r;
        if (w === i) return;
        [heap[i], heap[w]] = [heap[w] as never, heap[i] as never];
        i = w;
      }
    };
    for (const [doc, score] of scores) {
      const cand = { doc, score };
      if (heap.length < k) {
        heap.push(cand);
        siftUp(heap.length - 1);
      } else if (worse(heap[0] as never, cand)) {
        heap[0] = cand;
        siftDown();
      }
    }
    return heap
      .sort(
        (a, b) =>
          b.score - a.score || byCodeUnit(this.ids[a.doc] as string, this.ids[b.doc] as string)
      )
      .map((h) => ({ id: this.ids[h.doc] as string, score: h.score }));
  }
}
