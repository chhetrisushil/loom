// A single remembered item, scoped to a memory id + a scope (e.g. an execution,
// a conversation, or a user). Content is arbitrary — a message, a tool result,
// a fact — plus a timestamp used for TTL eviction.
export interface MemoryEntry {
  role?: string;
  content: unknown;
  timestamp: number;
}

// Pluggable storage backend. Implement this to persist memory in Redis, a DB,
// a vector store, etc. InMemoryMemoryStore is the built-in default.
export interface MemoryStore {
  append(key: string, entry: MemoryEntry): void;
  read(key: string): MemoryEntry[];
  clear(key: string): void;
}
