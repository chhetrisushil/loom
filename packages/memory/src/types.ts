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
export interface MemoryStore {
  append(key: string, entry: MemoryEntry): Promise<void>;
  read(key: string): Promise<MemoryEntry[]>;
  clear(key: string): Promise<void>;
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
