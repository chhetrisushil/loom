// A single remembered item, scoped to a memory id + a scope (e.g. an execution,
// a conversation, or a user). Content is arbitrary — a message, a tool result,
// a fact — plus a timestamp used for TTL eviction.
//
// `content` must be JSON-serializable for any DURABLE backend: SQLite and
// Postgres round-trip an entry through JSON, so a value JSON cannot express
// (undefined, a function, a Date's identity, a cycle) survives the in-memory
// store and silently degrades everywhere else. The conformance kit pins the
// fidelity that IS promised: nesting, arrays, null, numbers, unicode, and an
// absent `role` staying absent.
export interface MemoryEntry {
  role?: string;
  content: unknown;
  timestamp: number;
}

// Pluggable storage backend. Implement this to persist memory in Redis, a DB,
// a vector store, etc. InMemoryMemoryStore is the built-in default (and loses
// everything on restart); `SqliteMemoryStore` / `PostgresMemoryStore` in the
// store plugins are the durable ones. Async-first, so network-backed stores
// (Redis, a DB, a vector store) are real implementations — not just the
// in-memory default.
//
// The contract is deliberately dumb: a key names an ordered list of entries.
// TTL and size policy live above the SPI, in MemoryRuntime.
//
//  - `read` returns entries in APPEND order (not timestamp order — entries can
//    share a timestamp, and MemoryRuntime rewrites lists that are already
//    ordered). An absent key reads as `[]`, never a throw.
//  - `clear` is idempotent.
/**
 * The {@link MemoryStore} SPI contract version (ADR 0033 / ADR 0090).
 *
 * Same rules as the other store SPIs: MINOR for an additive, optional-with-fallback
 * method; MAJOR only for a change that breaks an existing backend. It exists because
 * implementations now live OUTSIDE this repo — `loom-plugin-vector` is third-party —
 * so a breaking change would otherwise reach a backend nothing in this workspace
 * builds, tests, or can even see.
 *
 * 1.0.0: `append` / `read` / `clear`, plus optional `replace`, `search` and `close`.
 *   The optional three shipped together with the first durable backends, so there is
 *   no earlier shape to be compatible with.
 */
export const MEMORY_STORE_SPI_VERSION = "1.0.0";

export interface MemorySearchOptions {
  /**
   * Return at most N entries. Backends default to {@link DEFAULT_SEARCH_LIMIT} and MUST
   * route the value through {@link clampSearchLimit} — see it for why.
   */
  limit?: number;
}

/** Hits returned when a caller names no limit. */
export const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Hard ceiling on a search page, mirroring `@loom/plugin-read-model`'s `MAX_QUERY_LIMIT`.
 * One answer per repo to "how much may a single query return".
 */
export const MAX_SEARCH_LIMIT = 10_000;

/**
 * Validate and clamp a search limit. Backends MUST call this — it is contract, not hygiene.
 *
 * Passed through raw, the same call produced three different behaviours: `.slice(0, -1)`
 * dropped the last hit in memory, SQLite read `LIMIT -1` as NO LIMIT and returned the entire
 * matching set, and Postgres rejected it. So a negative limit — the value a caller reaches by
 * arithmetic, not by malice — silently DEFEATED the bound on one backend and crashed another.
 *
 * That the unbounded one is the quiet failure is what makes it more than an inconsistency:
 * `recallRelevant` records what it retrieved through `ctx.decide`, so an unbounded search
 * writes the whole corpus into a DECISION_RECORDED payload — permanently, into the
 * append-only log, the way an over-large sandbox result once could.
 *
 * A fractional limit is clamped to its floor rather than refused: `Math.floor` is what every
 * caller means by it, and refusing would turn `limit: total / pages` into a crash.
 */
export function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
  if (!Number.isFinite(limit)) {
    throw new TypeError(`memory search: limit must be a finite number (got ${limit})`);
  }
  return Math.min(Math.max(Math.floor(limit), 0), MAX_SEARCH_LIMIT);
}

export interface MemoryStore {
  append(key: string, entry: MemoryEntry): Promise<void>;
  read(key: string): Promise<MemoryEntry[]>;
  clear(key: string): Promise<void>;
  /**
   * OPTIONAL — retrieve a key's entries by RELEVANCE to a text query, best first.
   *
   * This is the verb that separates "memory" from "the tail of a conversation".
   * `read` answers *what happened last*; a `semantic`/`procedural` tier has no
   * eviction at all, so answering *what is relevant to this question* over one
   * cannot mean loading it.
   *
   * The contract, which the conformance kit pins:
   *  - results are a SUBSET of `read(key)` — search never invents or leaks across keys;
   *  - ANY query term may match (terms are OR-ed); an entry matching more of them, or
   *    rarer ones, ranks higher. Requiring every term would make a longer question
   *    return less;
   *  - what gets indexed is `searchableText(entry)` and terms are `tokenize`'s — both
   *    exported, because "what text is searched" is contract, not backend detail;
   *  - a query with no terms, or one matching nothing, returns `[]`.
   *
   * RANKING itself is the backend's business — BM25, `ts_rank` and the reference
   * scorer disagree, and a kit that pinned an order would be pinning an implementation.
   *
   * A SIMILARITY BACKEND MUST CHOOSE A FLOOR. The requirement above that a query
   * matching nothing returns `[]` is free for an inverted index — a term is present
   * or it is not — and is the one real design decision for a vector store, where
   * cosine similarity is defined against EVERY stored entry. Ranked and
   * unthresholded, `search(key, "unrelated")` returns the whole scope in order,
   * least-unrelated first, and is never empty on a non-empty scope. So "matches"
   * has to mean something, and for such a backend the only available meaning is a
   * minimum score. Expose it: the right value is a property of the embedding model,
   * not of the store, and it does not transfer between models.
   * (`loom-plugin-vector`, third-party, is the worked example.)
   */
  search?(key: string, query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]>;
  /**
   * OPTIONAL — atomically replace a key's whole list (empty ⇒ the key is dropped).
   *
   * MemoryRuntime rewrites a list whenever TTL/maxEntries eviction changes it. Without
   * this the rewrite is `clear` + N × `append`, and a durable backend that crashes
   * between the two loses the scope outright — eviction, the routine path, would be the
   * thing that destroys memory. Backends that can do it in one transaction should; the
   * fallback stays for those that cannot (and is what the in-memory store uses).
   */
  replace?(key: string, entries: readonly MemoryEntry[]): Promise<void>;
  /** OPTIONAL — release backend resources (a file handle, a connection pool). */
  close?(): Promise<void>;
}
