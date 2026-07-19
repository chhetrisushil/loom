import type { ContentRef } from "./content";
import type { ContentStore } from "./ContentStore";

export interface CachingContentStoreOptions {
  /**
   * Total cache budget in BYTES (not entries — blob sizes vary by orders of
   * magnitude). A single blob larger than the budget is never admitted.
   */
  maxBytes: number;
}

/**
 * ADR 0062 — a caching decorator for any {@link ContentStore}. Content
 * addressing makes this trivially correct: a blob's address is a pure function
 * of its bytes, so cached entries are immutable and valid forever — with
 * exactly one edge: **`delete` evicts BEFORE forwarding**, so an erased /
 * crypto-shredded blob (K10, T3) is never resurrected from a warm cache.
 *
 * Byte-budgeted LRU on Map insertion order (touch = delete+set, evict = first
 * key) — O(1) per operation. `getMany` serves hits from cache and fetches only
 * the misses (one inner `getMany` when supported). A decorator is still a
 * conformant store and runs the full conformance kit.
 */
export class CachingContentStore implements ContentStore {
  private readonly cache = new Map<string, Uint8Array>();
  private cachedBytes = 0;
  readonly putStream?: NonNullable<ContentStore["putStream"]>;
  readonly getMany: NonNullable<ContentStore["getMany"]>;

  constructor(
    private readonly inner: ContentStore,
    private readonly options: CachingContentStoreOptions
  ) {
    // Forwarded uncached: the stream's bytes are consumed by the inner upload.
    if (inner.putStream !== undefined) {
      this.putStream = (stream) => inner.putStream!(stream);
    }
    this.getMany = async (refs) => {
      const results = new Array<Uint8Array | null>(refs.length);
      const missIndexes: number[] = [];
      const missRefs: ContentRef[] = [];
      refs.forEach((ref, i) => {
        const hit = this.touch(ref.__loomContent);
        if (hit !== undefined) {
          results[i] = hit;
        } else {
          missIndexes.push(i);
          missRefs.push(ref);
        }
      });
      if (missRefs.length > 0) {
        const fetched =
          inner.getMany !== undefined
            ? await inner.getMany(missRefs)
            : await Promise.all(missRefs.map((r) => inner.get(r)));
        fetched.forEach((bytes, j) => {
          const at = missIndexes[j] as number;
          results[at] = bytes ?? null;
          if (bytes != null) this.admit((missRefs[j] as ContentRef).__loomContent, bytes);
        });
      }
      return results;
    };
  }

  async put(bytes: Uint8Array): Promise<ContentRef> {
    const ref = await this.inner.put(bytes);
    this.admit(ref.__loomContent, bytes);
    return ref;
  }

  async get(ref: ContentRef): Promise<Uint8Array | null> {
    const hit = this.touch(ref.__loomContent);
    if (hit !== undefined) return hit;
    const bytes = await this.inner.get(ref);
    if (bytes !== null) this.admit(ref.__loomContent, bytes);
    return bytes;
  }

  async delete(ref: ContentRef): Promise<void> {
    // Evict FIRST — erasure must never be resurrected from cache.
    const cached = this.cache.get(ref.__loomContent);
    if (cached !== undefined) {
      this.cache.delete(ref.__loomContent);
      this.cachedBytes -= cached.byteLength;
    }
    return this.inner.delete(ref);
  }

  /** Cache hit with LRU touch (delete+set moves the key to the Map's tail). */
  private touch(address: string): Uint8Array | undefined {
    const hit = this.cache.get(address);
    if (hit !== undefined) {
      this.cache.delete(address);
      this.cache.set(address, hit);
    }
    return hit;
  }

  private admit(address: string, bytes: Uint8Array): void {
    if (bytes.byteLength > this.options.maxBytes) return; // never admit an over-budget blob
    const existing = this.cache.get(address);
    if (existing !== undefined) {
      this.cache.delete(address);
      this.cachedBytes -= existing.byteLength;
    }
    this.cache.set(address, bytes);
    this.cachedBytes += bytes.byteLength;
    while (this.cachedBytes > this.options.maxBytes) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      const evicted = this.cache.get(oldest.value) as Uint8Array;
      this.cache.delete(oldest.value);
      this.cachedBytes -= evicted.byteLength;
    }
  }

  /** Observability for tests: current cached byte total. */
  get cacheBytes(): number {
    return this.cachedBytes;
  }
}
