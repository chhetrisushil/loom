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
export interface MemorySearchOptions {
  /** Return at most N entries. Backends default to 20. */
  limit?: number;
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
