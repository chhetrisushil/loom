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
    const stored = await this.store.read(key);
    const pruned = this.pruneList(memoryId, stored);
    // Lazy expiry: if the view dropped entries, persist it so a cold scope (read but never
    // re-appended) doesn't retain stale entries — and a scope pruned to empty drops its key
    // entirely (clear + no re-append), bounding the store's distinct-scope growth.
    if (pruned.length !== stored.length) await this.persist(key, pruned);
    return pruned;
  }

  async clear(memoryId: string, scope: string): Promise<void> {
    await this.store.clear(this.key(memoryId, scope));
  }

  // Drop entries older than ttlMs, then keep only the newest maxEntries. Pure.
  private pruneList(memoryId: string, entries: MemoryEntry[]): MemoryEntry[] {
    const def = this.definitions.get(memoryId);
    let out = entries;
    if (def?.ttlMs !== undefined) {
      const cutoff = Date.now() - def.ttlMs;
      out = out.filter((e) => e.timestamp >= cutoff);
    }
    if (def?.maxEntries !== undefined && out.length > def.maxEntries) {
      out = out.slice(out.length - def.maxEntries);
    }
    return out;
  }

  // Rewrite the stored list to `entries` (empty ⇒ the key is dropped).
  private async persist(key: string, entries: MemoryEntry[]): Promise<void> {
    await this.store.clear(key);
    for (const entry of entries) await this.store.append(key, entry);
  }

  // Rewrite the stored list to the pruned view so eviction is durable (only when it changed).
  private async evict(memoryId: string, key: string): Promise<void> {
    const def = this.definitions.get(memoryId);
    if (def?.ttlMs === undefined && def?.maxEntries === undefined) return;
    const stored = await this.store.read(key);
    const pruned = this.pruneList(memoryId, stored);
    if (pruned.length !== stored.length) await this.persist(key, pruned);
  }
}
