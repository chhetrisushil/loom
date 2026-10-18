import type { FoldBase } from "./types";

// ── ADR 0132 D15 — a bounded per-node LRU of fold bases (pure) ────────────────
// The store's monotonic compare-and-set stays the authority; an entry is only a guess at the base a
// live apply starts from. Map insertion order IS the recency order.

export class FoldStateCache {
  private readonly entries = new Map<string, FoldBase>();

  constructor(readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(
        `FoldStateCache: maxEntries must be a positive integer (got ${maxEntries}); disable the cache instead`
      );
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Return AND remove: a fold that throws mid-way must leave the key absent, not half-mutated. */
  take(modelId: string, executionId: string): FoldBase | undefined {
    const k = key(modelId, executionId);
    const hit = this.entries.get(k);
    if (hit !== undefined) this.entries.delete(k);
    return hit;
  }

  /** Stores a private copy: the caller keeps its object and may mutate it without touching the cache. */
  put(modelId: string, executionId: string, entry: FoldBase): void {
    const k = key(modelId, executionId);
    this.entries.delete(k);
    this.entries.set(k, structuredClone(entry));
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  delete(modelId: string, executionId: string): void {
    this.entries.delete(key(modelId, executionId));
  }

  /** O(entries): used on version change, purge and rebuild, which are rare. */
  deleteModel(modelId: string): void {
    const prefix = `${modelId}\u0000`;
    for (const k of [...this.entries.keys()]) if (k.startsWith(prefix)) this.entries.delete(k);
  }

  clear(): void {
    this.entries.clear();
  }
}

const key = (modelId: string, executionId: string): string => `${modelId}\u0000${executionId}`;
