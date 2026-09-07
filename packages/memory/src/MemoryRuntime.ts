import type { MemoryDefinition } from "@loom/core";
import { InMemoryMemoryStore } from "./InMemoryMemoryStore";
import type { MemoryEntry, MemorySearchOptions, MemoryStore } from "./types";

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

  /**
   * The registered definition for a memory id, or `undefined`.
   *
   * Exposed for the same reason as `TieredMemory.tierPolicy`: a caller that is about to
   * write data whose correctness depends on the WHOLE set being present needs to know
   * whether something else has registered an eviction policy over the same key space.
   * Two runtimes can share one store, and only the one that reads applies its own policy.
   */
  definitionFor(memoryId: string): MemoryDefinition | undefined {
    return this.definitions.get(memoryId);
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

  /**
   * Remove specific entries by {@link MemoryEntry.id}, keeping the rest of the scope.
   *
   * Unlike `search`, an absent backend verb here does NOT fail: the fallback —
   * read, filter, rewrite — is CORRECT, just linear in the scope, so refusing would
   * deny a working capability rather than prevent a silent wrong answer. (That is the
   * whole distinction: there is no read-based way to fake relevance retrieval, and
   * there is an obvious read-based way to delete.)
   *
   * The rewrite goes through `persist`, so it inherits atomic `replace` where the
   * backend has one — the same durability argument as eviction: a crash between
   * `clear` and the re-appends would lose the scope this call was asked to prune.
   */
  async remove(memoryId: string, scope: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const key = this.key(memoryId, scope);
    if (this.store.remove !== undefined) {
      await this.store.remove(key, ids);
      return;
    }
    const stored = await this.store.read(key);
    const doomed = new Set(ids);
    const kept = stored.filter((entry) => entry.id === undefined || !doomed.has(entry.id));
    if (kept.length !== stored.length) await this.persist(key, kept);
  }

  /**
   * Retrieve by relevance instead of by recency. Requires a store that implements the
   * optional `search`; a store without one FAILS LOUDLY rather than falling back to
   * `read`, because a silent fallback would hand back the tail of the scope while the
   * caller believed it had retrieved — the kind of degradation nothing downstream can
   * detect, and which shows up only as worse answers.
   */
  async search(
    memoryId: string,
    scope: string,
    query: string,
    opts: MemorySearchOptions = {}
  ): Promise<MemoryEntry[]> {
    if (this.store.search === undefined) {
      throw new Error(
        `memory "${memoryId}": the configured MemoryStore does not implement search(). Use a backend that does (SqliteMemoryStore, PostgresMemoryStore, InMemoryMemoryStore), or recall by recency with read().`
      );
    }
    const hits = await this.store.search(this.key(memoryId, scope), query, opts);
    // TTL applies to a hit as much as to a read — an expired entry reaching a prompt is
    // the bug TTL exists to prevent. Filtered AFTER the store's `limit`, so an expiring
    // tier can return fewer than `limit` rows; the alternative is reading the whole scope
    // to prune it, which is exactly what an index is for. NOT persisted: unlike `read`,
    // these entries are an arbitrary subset, and rewriting the list from a subset would
    // delete everything that did not match.
    const def = this.definitions.get(memoryId);
    if (def?.ttlMs === undefined) return hits;
    const cutoff = Date.now() - def.ttlMs;
    return hits.filter((e) => e.timestamp >= cutoff);
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
  //
  // Prefers the store's atomic `replace` when it has one: on a durable backend the
  // clear-then-re-append fallback is a window in which eviction — the routine path —
  // can lose the whole scope to a crash. The fallback is still the contract for
  // backends without it (including the in-memory default, which has no crash to lose).
  private async persist(key: string, entries: MemoryEntry[]): Promise<void> {
    if (this.store.replace !== undefined) {
      await this.store.replace(key, entries);
      return;
    }
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
