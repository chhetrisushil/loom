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
  /**
   * OPTIONAL caller-assigned identity, opaque to the store and unique within a key.
   *
   * It exists because the unit a corpus is EDITED in is not the unit it is SEARCHED in.
   * `search` ranks over one key, so a searchable corpus has to be one key; a document,
   * which is what actually gets revised and deleted, is a subset of it. Without an
   * identity the only removal verb is `clear`, so fixing one line of one wiki page means
   * rebuilding the whole corpus, and re-ingesting a document duplicates its chunks
   * (`append` is a list, not a set).
   *
   * Stores MUST round-trip it: an entry appended with an `id` reads back with the same
   * `id`, and one appended WITHOUT reads back with none (`{ content }` must not become
   * `{ id: null, content }` — the same rule `role` already has, for the same reason).
   * This is required rather than optional because {@link MemoryStore.remove} is optional:
   * a store without it is removed from through read-filter-`replace`, which matches on
   * the `id` that `read` gives back. A backend that dropped ids would make that fallback
   * silently delete nothing.
   *
   * It is NOT indexed — `searchableText` projects `content` only, so an id is metadata by
   * the same rule as `role` and the timestamp. Indexing it would make a document's own id
   * a term that matches every one of its chunks.
   */
  id?: string;
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
//  - an entry may carry a caller-assigned `id`; every backend MUST round-trip it,
//    and `remove` (optional) deletes by it.
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
 * 2.1.0: the query is BOUNDED — a term-based backend derives its terms with `queryTerms`
 *   (deduplicated, capped at `MAX_QUERY_TERMS`) rather than `tokenize`. MINOR because a
 *   backend that already used `tokenize` returns the same rows for every query anyone would
 *   actually ask; what changes is that a pathological one can no longer buy unbounded work.
 *   A similarity backend derives no terms and is unaffected.
 * 2.0.0: entry IDENTITY — `MemoryEntry.id`, optional for the caller but REQUIRED to
 *   round-trip, plus the optional `remove`. MAJOR and not MINOR because the round-trip
 *   is a requirement on every backend, including ones that do not implement `remove`:
 *   a store that decomposes an entry into columns (both first-party SQL backends did)
 *   silently dropped a field it had never been told to keep, and the conformance kit
 *   now fails it. A backend that persists the entry object whole — `loom-plugin-vector`
 *   is the third-party example — conforms unchanged.
 */
export const MEMORY_STORE_SPI_VERSION = "2.1.0";

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
   *  - what gets indexed is `searchableText(entry)`, and a term-based backend derives its
   *    terms with `queryTerms` — both exported, because "what text is searched" is
   *    contract, not backend detail. `queryTerms` deduplicates and caps at
   *    `MAX_QUERY_TERMS`: repeated terms are OR-ed with themselves and cannot change which
   *    entries match, and an uncapped question is unbounded work bought from a text box
   *    (measured: one word repeated 20,000 times took SQLite 32.7 seconds). A SIMILARITY
   *    backend derives no terms and is unaffected, exactly as it is by the ranking
   *    carve-out below;
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
  /**
   * OPTIONAL — remove the entries in `key` whose {@link MemoryEntry.id} is listed,
   * keeping the append order of the survivors.
   *
   * This is the verb a mutable corpus needs and `clear` cannot give it. A knowledge
   * base is not append-only: a document gets revised, and re-ingesting it without
   * removing the previous revision leaves BOTH in the index, so retrieval returns
   * the stale passage alongside the current one and a citation cannot say which is
   * live. `clear` is the whole scope, which for a shared corpus means every other
   * document too.
   *
   * The contract:
   *  - IDEMPOTENT. An id that is not present is a no-op, not an error — a caller
   *    that crashed mid-write re-runs the same removal, and so does one racing
   *    another writer;
   *  - an empty `ids` is a no-op (and MUST NOT be read as "all");
   *  - an entry with NO id is never removed, whatever is passed;
   *  - survivors keep their relative append order, because `read` still promises it;
   *  - removing every entry leaves the key readable as `[]`, exactly like `clear`;
   *  - if a caller broke uniqueness and two entries share an id, BOTH go. Enforcing
   *    uniqueness would need an index the SPI does not require, and the alternative —
   *    removing one of them — leaves a duplicate that no id can ever address again.
   *
   * When it is ABSENT, {@link MemoryRuntime} falls back to read-filter-`replace`,
   * which is correct but rewrites the whole key: O(scope) per document edit, on a
   * corpus that only grows. Implement it if the backend can express the delete —
   * both first-party SQL backends do it as one statement.
   */
  remove?(key: string, ids: readonly string[]): Promise<void>;
  /** OPTIONAL — release backend resources (a file handle, a connection pool). */
  close?(): Promise<void>;
}
