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

  async append(
    memoryId: string,
    scope: string,
    entry: Omit<MemoryEntry, "timestamp"> & { timestamp?: number }
  ): Promise<void> {
    const key = this.key(memoryId, scope);
    await this.store.append(key, { ...entry, timestamp: entry.timestamp ?? Date.now() });
    await this.evict(memoryId, key);
  }

  async read(memoryId: string, scope: string): Promise<MemoryEntry[]> {
    const key = this.key(memoryId, scope);
    return this.prune(memoryId, key);
  }

  async clear(memoryId: string, scope: string): Promise<void> {
    await this.store.clear(this.key(memoryId, scope));
  }

  // Drop entries older than ttlMs, then keep only the newest maxEntries.
  private async prune(memoryId: string, key: string): Promise<MemoryEntry[]> {
    const def = this.definitions.get(memoryId);
    let entries = await this.store.read(key);

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
  private async evict(memoryId: string, key: string): Promise<void> {
    const def = this.definitions.get(memoryId);
    if (def?.ttlMs === undefined && def?.maxEntries === undefined) return;
    const pruned = await this.prune(memoryId, key);
    await this.store.clear(key);
    for (const entry of pruned) await this.store.append(key, entry);
  }
}
