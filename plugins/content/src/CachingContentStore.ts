import type { ContentStore } from "./ContentStore";
import { type ContentRef, contentAddress } from "./content";

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
  readonly deleteIfUntouchedSince?: NonNullable<ContentStore["deleteIfUntouchedSince"]>;
  readonly listPage?: NonNullable<ContentStore["listPage"]>;
  readonly touchClock?: NonNullable<ContentStore["touchClock"]>;
  readonly touch?: NonNullable<ContentStore["touch"]>;

  constructor(
    private readonly inner: ContentStore,
    private readonly options: CachingContentStoreOptions
  ) {
    // Forwarded uncached: the stream's bytes are consumed by the inner upload.
    if (inner.putStream !== undefined) {
      this.putStream = (stream) => inner.putStream!(stream);
    }
    // SPI 1.3.0 (ADR 0055 D5/D6): forwarded iff the inner store has them — a decorator that
    // dropped them would silently make the sweep racy and `reclaimOrphans` refuse. Touch
    // times are the inner store's; `put` already forwards, so a re-citation still bumps.
    if (inner.deleteIfUntouchedSince !== undefined) {
      this.deleteIfUntouchedSince = async (ref, cutoffMs) => {
        this.evict(ref.__loomContent); // before: erasure is never served from a warm cache
        const deleted = await inner.deleteIfUntouchedSince!(ref, cutoffMs);
        // after: a concurrent miss may have re-admitted the bytes while the delete ran
        if (deleted) this.evict(ref.__loomContent);
        return deleted;
      };
    }
    if (inner.listPage !== undefined) {
      this.listPage = (opts) => inner.listPage!(opts);
    }
    if (inner.touchClock !== undefined) {
      this.touchClock = () => inner.touchClock!();
    }
    // SPI 1.4.0: the touch time is the inner store's; the byte cache is untouched by it.
    if (inner.touch !== undefined) {
      this.touch = (addresses) => inner.touch!(addresses);
    }
    this.getMany = async (refs) => {
      const results = new Array<Uint8Array | null>(refs.length);
      const missIndexes: number[] = [];
      const missRefs: ContentRef[] = [];
      refs.forEach((ref, i) => {
        const hit = this.lruTouch(ref.__loomContent);
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
          if (bytes != null) {
            this.verifyFetched((missRefs[j] as ContentRef).__loomContent, bytes);
            this.admit((missRefs[j] as ContentRef).__loomContent, bytes);
          }
          results[at] = bytes ?? null;
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
    const hit = this.lruTouch(ref.__loomContent);
    if (hit !== undefined) return hit;
    const bytes = await this.inner.get(ref);
    if (bytes !== null) {
      this.verifyFetched(ref.__loomContent, bytes);
      this.admit(ref.__loomContent, bytes);
    }
    return bytes;
  }

  async delete(ref: ContentRef): Promise<void> {
    // Evict FIRST — erasure must never be resurrected from cache.
    this.evict(ref.__loomContent);
    return this.inner.delete(ref);
  }

  private evict(address: string): void {
    const cached = this.cache.get(address);
    if (cached !== undefined) {
      this.cache.delete(address);
      this.cachedBytes -= cached.byteLength;
    }
  }

  /** Cache hit with LRU touch (delete+set moves the key to the Map's tail). */
  private lruTouch(address: string): Uint8Array | undefined {
    const hit = this.cache.get(address);
    if (hit !== undefined) {
      this.cache.delete(address);
      this.cache.set(address, hit);
    }
    return hit;
  }

  /**
   * Audit SEC-2 — FETCHED bytes are verified against their content address
   * before they are served OR cached: a buggy/compromised inner store returning
   * wrong bytes for an address must neither poison the cache nor reach the
   * caller (the sandbox pins scripts by hash through this store — a mispairing
   * would defeat that provenance). Throws loudly on mismatch. Applies only to
   * sha256-addressed refs (the ADR 0046 scheme) and only to the fetch path —
   * `put` bytes came from the caller and the inner store derived the address.
   */
  private verifyFetched(address: string, bytes: Uint8Array): void {
    if (address.startsWith("sha256:") && contentAddress(bytes) !== address) {
      throw new Error(
        `CachingContentStore: inner store returned bytes whose hash does not match "${address}" — refusing to cache or serve (possible corruption or poisoning)`
      );
    }
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
