// A single remembered item, scoped to a memory id + a scope (e.g. an execution,
// a conversation, or a user). Content is arbitrary — a message, a tool result,
// a fact — plus a timestamp used for TTL eviction.
export interface MemoryEntry {
  role?: string;
  content: unknown;
  timestamp: number;
}

// Pluggable storage backend. Implement this to persist memory in Redis, a DB,
// a vector store, etc. InMemoryMemoryStore is the built-in default. Async-first,
// so network-backed stores (Redis, a DB, a vector store) are real implementations
// — not just the in-memory default.
export interface MemoryStore {
  append(key: string, entry: MemoryEntry): Promise<void>;
  read(key: string): Promise<MemoryEntry[]>;
  clear(key: string): Promise<void>;
}
