import type { MemoryDefinition } from "@loom/core";
import { InMemoryMemoryStore } from "./InMemoryMemoryStore";
import type { MemoryEntry, MemoryStore } from "./types";

// The Agent Runtime's "memory access" from the proposal. A MemoryRuntime holds
// named memories (registered from memory$() definitions) and enforces each
// memory's ttlMs / maxEntries policy on read and write. Memory is addressed by
// (memoryId, scope) — scope is typically an executionId, conversationId, or
// userId, letting one memory definition serve many concurrent sessions.
export class MemoryRuntime {
  private readonly definitions = new Map<string, MemoryDefinition>();

  constructor(private readonly store: MemoryStore = new InMemoryMemoryStore()) {}

  register(definition: MemoryDefinition): this {
    this.definitions.set(definition.id, definition);
    return this;
  }

  private key(memoryId: string, scope: string): string {
    return `${memoryId}::${scope}`;
  }

  append(memoryId: string, scope: string, entry: Omit<MemoryEntry, "timestamp"> & { timestamp?: number }): void {
    const key = this.key(memoryId, scope);
    this.store.append(key, { ...entry, timestamp: entry.timestamp ?? Date.now() });
    this.evict(memoryId, key);
  }

  read(memoryId: string, scope: string): MemoryEntry[] {
    const key = this.key(memoryId, scope);
    return this.prune(memoryId, key);
  }

  clear(memoryId: string, scope: string): void {
    this.store.clear(this.key(memoryId, scope));
  }

  // Drop entries older than ttlMs, then keep only the newest maxEntries.
  private prune(memoryId: string, key: string): MemoryEntry[] {
    const def = this.definitions.get(memoryId);
    let entries = this.store.read(key);

    if (def?.ttlMs !== undefined) {
      const cutoff = Date.now() - def.ttlMs;
      entries = entries.filter((e) => e.timestamp >= cutoff);
    }
    if (def?.maxEntries !== undefined && entries.length > def.maxEntries) {
      entries = entries.slice(entries.length - def.maxEntries);
    }
    return entries;
  }

  // Rewrite the stored list to the pruned view so eviction is durable.
  private evict(memoryId: string, key: string): void {
    const def = this.definitions.get(memoryId);
    if (def?.ttlMs === undefined && def?.maxEntries === undefined) return;
    const pruned = this.prune(memoryId, key);
    this.store.clear(key);
    for (const entry of pruned) this.store.append(key, entry);
  }
}
