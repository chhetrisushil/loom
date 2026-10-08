import { createHash } from "node:crypto";
import { searchableText, tokenize } from "./searchText";
import { clampSearchLimit } from "./types";
import type { MemoryEntry, MemorySearchOptions, MemoryStore } from "./types";

// ── Embeddings: a provider SPI, a vector index, and a semantic MemoryStore (R18, ADR 0124) ──
//
// `MemoryStore.search` is lexical in every first-party backend; a semantic backend was a
// third-party store that owned embedding, indexing and storage together, so you could not swap the
// embedding model without swapping the store. This splits the concerns:
//
//   EmbeddingProvider  texts -> vectors. A model. Implemented by a 3P (an API client, a local
//                      model); a deterministic hashing embedder ships here as the offline reference.
//   VectorIndex        vectors -> ranked ids. Brute-force cosine in memory ships here; a durable
//                      ANN index is a 3P implementing the same seam.
//   EmbeddingMemoryStore  any MemoryStore + a provider + an index = a store whose `search` is
//                      semantic. The wrapped store stays the system of record; the index is a
//                      derived cache rebuilt lazily, so losing it loses nothing.
//
// REPLAY. Embedding is nondeterministic across model versions and I/O, so it must never run in
// workflow code outside a recorded decision. `recallRelevant` already runs `search` inside
// `ctx.decide` and records WHICH entries came back; a replay serves that record and neither the
// provider nor the index is touched. Calling `store.search` directly from a flow is exactly as
// replay-unsafe as it is for a lexical store over a changing corpus - use `recallRelevant`.
// Embeddings are therefore RECOMPUTED (never recorded): they are a cache, the entries are the
// truth, and `modelId` is stamped on the index so a vector made by one model is never compared
// with a query made by another.

/**
 * The {@link EmbeddingProvider} / {@link VectorIndex} SPI contract version.
 * MINOR for an additive optional member; MAJOR for anything that breaks an existing implementation.
 * 1.0.0: `modelId`, `dimensions`, `embed`; `VectorIndex` add/remove/clear/search.
 */
export const EMBEDDING_PROVIDER_SPI_VERSION = "1.0.0";

export interface EmbedOptions {
  signal?: AbortSignal;
}

/** A text-embedding model. */
export interface EmbeddingProvider {
  /**
   * Identifies the model AND its version, e.g. `"acme/embed-3@2026-06"`. Two providers with the
   * same `modelId` MUST produce comparable vectors; a changed model MUST change this string - it is
   * how an index refuses vectors from a model it was not built with.
   */
  readonly modelId: string;
  /** Length of every vector `embed` returns. */
  readonly dimensions: number;
  /** Largest batch `embed` accepts. Callers split larger inputs. Default: unbounded (callers cap at 64). */
  readonly maxBatchSize?: number;
  /**
   * One vector per text, in order, each of length `dimensions`, finite. The same text gives the
   * same vector (to float tolerance) regardless of batch composition. An empty array in gives an
   * empty array out.
   */
  embed(texts: readonly string[], opts?: EmbedOptions): Promise<number[][]>;
}

export interface VectorHit {
  id: string;
  /** Cosine similarity in [-1, 1]. */
  score: number;
}

/** Ranked nearest-neighbour lookup over unit-keyed vectors. */
export interface VectorIndex {
  /** The model this index holds vectors for; `undefined` accepts any (not recommended). */
  readonly modelId?: string;
  readonly dimensions: number;
  add(key: string, id: string, vector: readonly number[]): void | Promise<void>;
  remove(key: string, ids: readonly string[]): void | Promise<void>;
  clear(key: string): void | Promise<void>;
  /**
   * The `limit` best ids under `key` with `score >= minScore`, best first; ties broken by
   * insertion order so a ranking is stable. NEVER returns an id from another key.
   */
  search(
    key: string,
    query: readonly number[],
    limit: number,
    minScore: number
  ): VectorHit[] | Promise<VectorHit[]>;
  size(key: string): number | Promise<number>;
}

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
export class EmbeddingModelMismatchError extends EmbeddingError {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingModelMismatchError";
  }
}
export class MemoryIndexTooLargeError extends EmbeddingError {
  constructor(message: string) {
    super(message);
    this.name = "MemoryIndexTooLargeError";
  }
}

function norm(v: readonly number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function checkVector(v: readonly number[], dims: number, what: string): void {
  if (v.length !== dims) {
    throw new EmbeddingError(`${what}: expected ${dims} dimensions, got ${v.length}`);
  }
  for (const x of v) {
    if (!Number.isFinite(x)) throw new EmbeddingError(`${what}: a component is not finite`);
  }
}

/** Unit-normalize; a zero vector has no direction and is refused (it would score 0 against all). */
function unit(v: readonly number[], what: string): Float64Array {
  const n = norm(v);
  if (!(n > 0)) throw new EmbeddingError(`${what}: zero vector has no direction`);
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / n;
  return out;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new EmbeddingError("cosine: dimension mismatch");
  const na = norm(a);
  const nb = norm(b);
  if (!(na > 0) || !(nb > 0)) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
  return dot / (na * nb);
}

interface Slot {
  id: string;
  vec: Float64Array;
  order: number;
}

/**
 * The reference index: exact (brute-force) cosine over unit-normalized vectors, one map per key.
 * Search is O(n log k) with a bounded top-k heap, so a large scope is scanned once and never
 * sorted whole. Honest about its scale: exact and in-memory, for corpora up to tens of thousands
 * of entries per key; a bigger one wants a real ANN index behind the same {@link VectorIndex}.
 */
export class InMemoryVectorIndex implements VectorIndex {
  readonly modelId?: string;
  readonly dimensions: number;
  private readonly keys = new Map<string, Map<string, Slot>>();
  private order = 0;

  constructor(opts: { dimensions: number; modelId?: string }) {
    if (!Number.isInteger(opts.dimensions) || opts.dimensions < 1) {
      throw new EmbeddingError("InMemoryVectorIndex: dimensions must be a positive integer");
    }
    this.dimensions = opts.dimensions;
    if (opts.modelId !== undefined) this.modelId = opts.modelId;
  }

  add(key: string, id: string, vector: readonly number[]): void {
    checkVector(vector, this.dimensions, "VectorIndex.add");
    let m = this.keys.get(key);
    if (m === undefined) {
      m = new Map();
      this.keys.set(key, m);
    }
    // Re-adding an id replaces its vector but keeps its place in the tie-break order.
    const prior = m.get(id);
    m.set(id, { id, vec: unit(vector, "VectorIndex.add"), order: prior?.order ?? this.order++ });
  }

  remove(key: string, ids: readonly string[]): void {
    const m = this.keys.get(key);
    if (m === undefined) return;
    for (const id of ids) m.delete(id);
    if (m.size === 0) this.keys.delete(key);
  }

  clear(key: string): void {
    this.keys.delete(key);
  }

  size(key: string): number {
    return this.keys.get(key)?.size ?? 0;
  }

  search(key: string, query: readonly number[], limit: number, minScore: number): VectorHit[] {
    checkVector(query, this.dimensions, "VectorIndex.search");
    const m = this.keys.get(key);
    if (m === undefined || limit <= 0) return [];
    const q = unit(query, "VectorIndex.search");
    // Bounded min-heap of the `limit` best: worst-of-the-best at the root.
    const heap: (VectorHit & { order: number })[] = [];
    const worse = (a: VectorHit & { order: number }, b: VectorHit & { order: number }): boolean =>
      a.score < b.score || (a.score === b.score && a.order > b.order);
    const up = (start: number): void => {
      let i = start;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!worse(heap[i] as never, heap[p] as never)) break;
        [heap[i], heap[p]] = [heap[p] as never, heap[i] as never];
        i = p;
      }
    };
    const down = (start: number): void => {
      let i = start;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let w = i;
        if (l < heap.length && worse(heap[l] as never, heap[w] as never)) w = l;
        if (r < heap.length && worse(heap[r] as never, heap[w] as never)) w = r;
        if (w === i) break;
        [heap[i], heap[w]] = [heap[w] as never, heap[i] as never];
        i = w;
      }
    };
    for (const slot of m.values()) {
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot += (q[i] as number) * (slot.vec[i] as number);
      if (!(dot >= minScore)) continue;
      const hit = { id: slot.id, score: dot, order: slot.order };
      if (heap.length < limit) {
        heap.push(hit);
        up(heap.length - 1);
      } else if (worse(heap[0] as never, hit)) {
        heap[0] = hit;
        down(0);
      }
    }
    return heap
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map(({ id, score }) => ({ id, score }));
  }
}

// ── The offline reference embedder ───────────────────────────────────────────

/** FNV-1a, 32-bit: tiny, stable across platforms, no dependency. */
function fnv1a(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A deterministic feature-hashing embedder: each token adds a signed unit to one of `dimensions`
 * buckets; the result is L2-normalised. It captures lexical overlap, NOT meaning - two paraphrases
 * with no shared word are orthogonal. It exists so semantic recall can be built, tested and run
 * offline with no model and no network, and as the reference every provider is held to; swap in a
 * real model for production relevance.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxBatchSize = 256;

  constructor(opts: { dimensions?: number } = {}) {
    const dims = opts.dimensions ?? 256;
    if (!Number.isInteger(dims) || dims < 8 || dims > 8192) {
      throw new EmbeddingError(
        "HashingEmbeddingProvider: dimensions must be an integer in [8, 8192]"
      );
    }
    this.dimensions = dims;
    this.modelId = `loom-hashing-embedder/1;dims=${dims}`;
  }

  async embed(texts: readonly string[], opts: EmbedOptions = {}): Promise<number[][]> {
    if (opts.signal?.aborted) throw new EmbeddingError("embed aborted");
    if (texts.length > this.maxBatchSize) {
      throw new EmbeddingError(
        `batch of ${texts.length} exceeds maxBatchSize ${this.maxBatchSize}`
      );
    }
    return texts.map((text) => {
      const v = new Array<number>(this.dimensions).fill(0);
      for (const tok of tokenize(text)) {
        const bucket = fnv1a(tok, 0) % this.dimensions;
        v[bucket] = (v[bucket] as number) + (fnv1a(tok, 0x9e3779b9) & 1 ? 1 : -1);
      }
      const n = norm(v);
      // A text with no tokens has no direction; give it a fixed, well-defined vector so embedding
      // never fails (it simply matches nothing above a sane floor).
      if (!(n > 0)) {
        v[0] = 1;
        return v;
      }
      return v.map((x) => x / n);
    });
  }
}

// ── The semantic store ───────────────────────────────────────────────────────

export interface EmbeddingMemoryStoreOptions {
  /** The system of record. Everything but `search` is forwarded to it untouched. */
  store: MemoryStore;
  provider: EmbeddingProvider;
  /** Defaults to a fresh {@link InMemoryVectorIndex} for the provider's model. */
  index?: VectorIndex;
  /**
   * The relevance FLOOR: a hit needs cosine >= this. REQUIRED, because the right value is a
   * property of the embedding model and does not transfer between models - and because cosine is
   * defined against every entry, so without a floor `search` never returns `[]` (MemoryStore
   * contract: a query matching nothing returns `[]`).
   */
  minScore: number;
  /** Refuse to index more than this many entries per key (fail loudly, never truncate). Default 20_000. */
  maxEntriesPerKey?: number;
  /** Texts per `embed` call while hydrating. Default min(provider.maxBatchSize ?? 64, 64). */
  batchSize?: number;
  /**
   * A query longer than this many characters is cut before it reaches the provider (a question is
   * an input, and an unbounded one is unbounded work bought from a text box). Default 8192.
   */
  maxQueryChars?: number;
}

const keyMemo = new WeakMap<MemoryEntry, string>();

function entryKey(e: MemoryEntry): string {
  if (e.id !== undefined) return `id:${e.id}`;
  // No identity: derive one from the searchable text + timestamp + role. Equal entries share a key
  // and a vector, which is exactly right (same text, same vector). Memoized per entry object, so a
  // store that hands back the same objects is hashed once, not once per search.
  const memo = keyMemo.get(e);
  if (memo !== undefined) return memo;
  const k = `h:${createHash("sha256")
    .update(`${e.role ?? ""}\u0000${e.timestamp}\u0000${searchableText(e)}`)
    .digest("hex")}`;
  keyMemo.set(e, k);
  return k;
}

const isZero = (v: readonly number[]): boolean => !(norm(v) > 0);
const MAX_HYDRATE_ATTEMPTS = 4;

/**
 * Any {@link MemoryStore} plus an {@link EmbeddingProvider}: `search` ranks by cosine similarity
 * and is bounded by the relevance floor. The index is hydrated lazily on a key's first search
 * (embedding its entries in batches) and kept current by `append` / `remove` / `replace`
 * afterwards; `clear` drops it. If embedding fails during an `append` to an already-indexed key,
 * the append is NOT made - the store and its index never disagree silently.
 *
 * Writes that race a hydration are never lost: every write is counted, and a hydration whose
 * snapshot could have missed one (a write in flight, or begun, while it read) is redone; if it
 * cannot settle the key is left unhydrated, so the next search rebuilds it instead of trusting a
 * stale index.
 *
 * Every search re-reads the key from the system of record (one pass, memoized hashing) so a hit is
 * always an entry the store still holds, even if another writer removed it behind this wrapper's
 * back. An entry whose embedding is a zero vector has no direction and is skipped and counted
 * ({@link skippedZeroVectors}) rather than failing every search on its key.
 */
export class EmbeddingMemoryStore implements MemoryStore {
  private readonly store: MemoryStore;
  private readonly provider: EmbeddingProvider;
  private readonly index: VectorIndex;
  private readonly minScore: number;
  private readonly maxEntries: number;
  private readonly batch: number;
  private readonly maxQuery: number;
  private readonly hydrated = new Set<string>();
  private readonly hydrating = new Map<string, Promise<void>>();
  /** What the index holds per hydrated key (entry keys), so `replace` can be incremental. */
  private readonly indexed = new Map<string, Set<string>>();
  private readonly writes = new Map<string, { started: number; inflight: number }>();
  /** Entries skipped from the index because their embedding was a zero vector. */
  skippedZeroVectors = 0;

  constructor(opts: EmbeddingMemoryStoreOptions) {
    if (!(opts.minScore >= -1 && opts.minScore <= 1)) {
      throw new EmbeddingError("EmbeddingMemoryStore: minScore must be in [-1, 1]");
    }
    this.store = opts.store;
    this.provider = opts.provider;
    this.minScore = opts.minScore;
    this.maxEntries = opts.maxEntriesPerKey ?? 20_000;
    this.maxQuery = opts.maxQueryChars ?? 8192;
    this.batch = Math.max(1, Math.min(opts.batchSize ?? 64, opts.provider.maxBatchSize ?? 64));
    this.index =
      opts.index ??
      new InMemoryVectorIndex({
        dimensions: opts.provider.dimensions,
        modelId: opts.provider.modelId,
      });
    if (this.index.dimensions !== opts.provider.dimensions) {
      throw new EmbeddingModelMismatchError(
        `index has ${this.index.dimensions} dimensions, provider ${opts.provider.modelId} has ${opts.provider.dimensions}`
      );
    }
    if (this.index.modelId !== undefined && this.index.modelId !== opts.provider.modelId) {
      throw new EmbeddingModelMismatchError(
        `index was built for ${this.index.modelId}, provider is ${opts.provider.modelId}`
      );
    }
  }

  private async embedAll(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batch) {
      const part = texts.slice(i, i + this.batch);
      const vecs = await this.provider.embed(part);
      if (vecs.length !== part.length) {
        throw new EmbeddingError(
          `provider ${this.provider.modelId} returned ${vecs.length} vectors for ${part.length} texts`
        );
      }
      for (const v of vecs) checkVector(v, this.provider.dimensions, this.provider.modelId);
      out.push(...vecs);
    }
    return out;
  }

  private mark(key: string): { started: number; inflight: number } {
    let w = this.writes.get(key);
    if (w === undefined) {
      w = { started: 0, inflight: 0 };
      this.writes.set(key, w);
    }
    return w;
  }

  /** Run a write, counting it so a concurrent hydration can tell its snapshot may be stale. */
  private async write<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const w = this.mark(key);
    w.started += 1;
    w.inflight += 1;
    try {
      return await fn();
    } finally {
      w.inflight -= 1;
      w.started += 1;
    }
  }

  private ensureHydrated(key: string): Promise<void> {
    if (this.hydrated.has(key)) return Promise.resolve();
    let p = this.hydrating.get(key);
    if (p === undefined) {
      p = (async () => {
        // Vectors computed so far, kept ACROSS retries: a retry (a write raced the snapshot) embeds
        // only entries it has not seen, never the whole corpus again.
        const cache = new Map<string, { text: string; vec: number[] }>();
        for (let attempt = 0; attempt < MAX_HYDRATE_ATTEMPTS; attempt++) {
          const w = this.mark(key);
          const before = { started: w.started, inflight: w.inflight };
          const entries = await this.store.read(key);
          if (entries.length > this.maxEntries) {
            throw new MemoryIndexTooLargeError(
              `key "${key}" has ${entries.length} entries, over the index limit of ${this.maxEntries}; shard the scope or raise maxEntriesPerKey`
            );
          }
          // Dedupe by entry key so identical entries are embedded once.
          const unique = new Map<string, string>();
          for (const e of entries) {
            const k = entryKey(e);
            if (!unique.has(k)) unique.set(k, searchableText(e));
          }
          const ids = [...unique.keys()];
          // Reuse a cached vector only for the SAME text (an id can be rewritten between attempts).
          const missing = ids.filter((k) => cache.get(k)?.text !== unique.get(k));
          const fresh = await this.embedAll(missing.map((k) => unique.get(k) as string));
          for (let i = 0; i < missing.length; i++) {
            cache.set(missing[i] as string, {
              text: unique.get(missing[i] as string) as string,
              vec: fresh[i] as number[],
            });
          }
          const vecs = ids.map((k) => (cache.get(k) as { vec: number[] }).vec);
          await this.index.clear(key);
          const held = new Set<string>();
          for (let i = 0; i < ids.length; i++) {
            const v = vecs[i] as number[];
            if (isZero(v)) {
              this.skippedZeroVectors += 1;
              continue;
            }
            await this.index.add(key, ids[i] as string, v);
            held.add(ids[i] as string);
          }
          this.indexed.set(key, held);
          if (before.inflight === 0 && w.inflight === 0 && before.started === w.started) {
            this.hydrated.add(key);
            return;
          }
          // A write raced the snapshot: it may be missing from what was just indexed. Go again.
        }
        // Could not settle under constant writes: serve this search from what was built, but do
        // NOT trust it - leave the key unhydrated so the next search rebuilds.
      })().finally(() => this.hydrating.delete(key));
      this.hydrating.set(key, p);
    }
    return p;
  }

  async append(key: string, entry: MemoryEntry): Promise<void> {
    // An in-flight hydration may or may not have read this entry: let it finish first. (Outside the
    // write count, or the hydration would see this very append as a racing writer and never settle.)
    await this.hydrating.get(key)?.catch(() => undefined);
    await this.write(key, async () => {
      if (this.hydrated.has(key)) {
        // Embed FIRST: if the model is down, nothing is appended and nothing diverges.
        const [vec] = await this.embedAll([searchableText(entry)]);
        await this.store.append(key, entry);
        const k = entryKey(entry);
        if (isZero(vec as number[])) this.skippedZeroVectors += 1;
        else {
          await this.index.add(key, k, vec as number[]);
          this.indexed.get(key)?.add(k);
        }
        return;
      }
      await this.store.append(key, entry);
    });
  }

  read(key: string): Promise<MemoryEntry[]> {
    return this.store.read(key);
  }

  async clear(key: string): Promise<void> {
    await this.hydrating.get(key)?.catch(() => undefined);
    await this.write(key, async () => {
      await this.store.clear(key);
      await this.index.clear(key);
      this.hydrated.delete(key);
      this.indexed.delete(key);
    });
  }

  async remove(key: string, ids: readonly string[]): Promise<void> {
    await this.hydrating.get(key)?.catch(() => undefined);
    await this.write(key, async () => {
      if (this.store.remove !== undefined) {
        await this.store.remove(key, ids);
      } else {
        const doomed = new Set(ids);
        const kept = (await this.store.read(key)).filter(
          (e) => e.id === undefined || !doomed.has(e.id)
        );
        await this.replaceInner(key, kept);
      }
      if (this.hydrated.has(key)) {
        const keys = ids.map((id) => `id:${id}`);
        await this.index.remove(key, keys);
        const held = this.indexed.get(key);
        for (const k of keys) held?.delete(k);
      }
    });
  }

  private async replaceInner(key: string, entries: readonly MemoryEntry[]): Promise<void> {
    if (this.store.replace !== undefined) await this.store.replace(key, entries);
    else {
      await this.store.clear(key);
      for (const e of entries) await this.store.append(key, e);
    }
  }

  /**
   * Replace a key's list. On a hydrated key this is INCREMENTAL: only entries the index does not
   * already hold are embedded and only ones that left are removed - TTL/size eviction rewrites a
   * list through here on the routine path, and re-embedding the whole corpus each time would make
   * eviction the most expensive thing the store does.
   */
  async replace(key: string, entries: readonly MemoryEntry[]): Promise<void> {
    await this.hydrating.get(key)?.catch(() => undefined);
    await this.write(key, async () => {
      if (!this.hydrated.has(key)) {
        await this.replaceInner(key, entries);
        return;
      }
      if (entries.length > this.maxEntries) {
        throw new MemoryIndexTooLargeError(
          `key "${key}" would hold ${entries.length} entries, over the index limit of ${this.maxEntries}`
        );
      }
      const want = new Map<string, string>();
      for (const e of entries) {
        const k = entryKey(e);
        if (!want.has(k)) want.set(k, searchableText(e));
      }
      const held = this.indexed.get(key) ?? new Set<string>();
      const fresh = [...want.keys()].filter((k) => !held.has(k));
      // Embed first: a model failure leaves the store and the index as they were.
      const vecs = await this.embedAll(fresh.map((k) => want.get(k) as string));
      await this.replaceInner(key, entries);
      const gone = [...held].filter((k) => !want.has(k));
      if (gone.length > 0) await this.index.remove(key, gone);
      for (const k of gone) held.delete(k);
      for (let i = 0; i < fresh.length; i++) {
        const v = vecs[i] as number[];
        if (isZero(v)) {
          this.skippedZeroVectors += 1;
          continue;
        }
        await this.index.add(key, fresh[i] as string, v);
        held.add(fresh[i] as string);
      }
      this.indexed.set(key, held);
    });
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }

  async search(key: string, query: string, opts: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    const limit = clampSearchLimit(opts.limit);
    const bounded = query.length > this.maxQuery ? query.slice(0, this.maxQuery) : query;
    if (limit === 0 || tokenize(bounded).length === 0) return [];
    await this.ensureHydrated(key);
    const [qv] = await this.embedAll([bounded]);
    if (isZero(qv as number[])) return [];
    const hits = await this.index.search(key, qv as number[], limit, this.minScore);
    if (hits.length === 0) return [];
    // Results are a SUBSET of read(key): map ids back through the system of record, so an
    // entry removed from the store behind the index's back can never be returned.
    const byKey = new Map<string, MemoryEntry[]>();
    for (const e of await this.store.read(key)) {
      const k = entryKey(e);
      const list = byKey.get(k);
      if (list === undefined) byKey.set(k, [e]);
      else list.push(e);
    }
    const out: MemoryEntry[] = [];
    for (const h of hits) {
      for (const e of byKey.get(h.id) ?? []) {
        out.push(e);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}
