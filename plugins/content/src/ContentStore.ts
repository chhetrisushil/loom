import { createHash } from "node:crypto";
import { type ContentRef, contentAddress } from "./content";

// ── ADR 0046 — the ContentStore SPI ───────────────────────────────────────────
//
// A key→blob store for externalized payload bytes, addressed by content hash. Back it with
// object storage / a filesystem / an encrypted blob store in production (as separate
// `@loom/plugin-content-*` backends); the reference implementation here is in-memory.

/**
 * ContentStore SPI version (introduced retroactively by ADR 0062 — the SPI had
 * shipped two revisions without a version anchor for conformance to pin).
 *  - 1.0.0: `put`/`get`/`delete` (ADR 0046).
 *  - 1.1.0: optional `putStream` (ST-1, ADR 0059).
 *  - 1.2.0: optional `getMany` (TS-10, ADR 0062 — batched interactive reads).
 *  - 1.3.0: optional `deleteIfUntouchedSince` + `listPage`, and a per-blob touch time that
 *    every `put`/`putStream` bumps (ADR 0055 D5/D6 — the race-safe, orphan-reclaiming sweep).
 */
export const CONTENT_STORE_SPI_VERSION = "1.3.0";

/** One blob as {@link ContentStore.listPage} reports it (SPI 1.3.0). */
export interface ContentPageEntry {
  address: string;
  /** Epoch ms of the blob's last `put`/`putStream`, by the STORE's clock. */
  touchedAt: number;
}

/** Options for {@link ContentStore.listPage} (SPI 1.3.0). */
export interface ContentListPageOptions {
  /** Resume after this address: the previous page's `nextCursor`. Absent = from the start. */
  cursor?: string;
  /**
   * Page size. MUST be a positive integer (anything else rejects with a `RangeError`, never
   * "no limit"); a store MAY return fewer. Default {@link CONTENT_LIST_PAGE_DEFAULT_LIMIT},
   * clamped to {@link CONTENT_LIST_PAGE_MAX_LIMIT}.
   */
  limit?: number;
  /** Only blobs whose touch time is strictly before this (epoch ms). */
  touchedBefore?: number;
}

/** One page of {@link ContentStore.listPage}. `nextCursor` absent = the scan is complete. */
export interface ContentListPage {
  entries: ContentPageEntry[];
  nextCursor?: string;
}

export const CONTENT_LIST_PAGE_DEFAULT_LIMIT = 500;
export const CONTENT_LIST_PAGE_MAX_LIMIT = 10_000;

/**
 * Validate and clamp a `listPage` limit (shared by the reference stores so a 3P backend has
 * one rule to copy). Rejects rather than defaulting: SQLite reads `LIMIT -1` as NO limit.
 */
export function contentListPageLimit(limit: number | undefined): number {
  if (limit === undefined) return CONTENT_LIST_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`listPage: limit must be a positive integer, got ${limit}`);
  }
  return Math.min(limit, CONTENT_LIST_PAGE_MAX_LIMIT);
}

export interface ContentStore {
  /** Store bytes, returning their content-addressed ref. Idempotent by hash (stored once). */
  put(bytes: Uint8Array): Promise<ContentRef>;
  /**
   * OPTIONAL (ST-1, ADR 0059) — store a byte STREAM without materializing it in
   * the caller's memory. Contract: the returned ref MUST be the content address
   * of the full streamed sequence, idempotent by that address, exactly as if
   * `put(concat(chunks))` had been called. HOW the backend achieves it is its
   * business — the reference approach hashes while spooling; an object-store
   * backend that cannot address before completion may hash-while-upload and
   * verify (or re-key) on finalize (resolves requirements §6.3). Node
   * `Readable` streams satisfy `AsyncIterable<Uint8Array>` directly.
   */
  putStream?(stream: AsyncIterable<Uint8Array>): Promise<ContentRef>;
  /** Resolve a ref to its bytes, or `null` if erased/absent — MUST NOT throw on absence. */
  get(ref: ContentRef): Promise<Uint8Array | null>;
  /**
   * OPTIONAL (TS-10, ADR 0062) — batched get for interactive read paths (e.g.
   * frozen-snapshot serving: many refs, one human waiting). Result is
   * positionally aligned with `refs`; `null` per absent entry; MUST NOT throw
   * on absence. Duplicate refs are legal and resolve identically. Semantics are
   * exactly element-wise `get` — only the round-trip count may differ.
   */
  getMany?(refs: readonly ContentRef[]): Promise<(Uint8Array | null)[]>;
  /** Physically erase the bytes. Idempotent; referential integrity is the caller's concern. */
  delete(ref: ContentRef): Promise<void>;
  /**
   * OPTIONAL (SPI 1.3.0, ADR 0055 D5) — erase the blob only if its touch time is strictly
   * before `cutoffMs`, as ONE atomic operation (a single conditional `DELETE`, never a read
   * followed by a delete). Resolves `true` iff it deleted; `false` for a touched or absent
   * blob, never a throw.
   *
   * A store that implements this MUST bump the blob's touch time on EVERY `put`/`putStream`,
   * including a put of bytes it already holds (`ON CONFLICT … DO UPDATE`, not
   * `INSERT OR IGNORE`). A dedup'd put is a re-citation the log has not recorded yet; the
   * touch is how the sweep learns of it.
   */
  deleteIfUntouchedSince?(ref: ContentRef, cutoffMs: number): Promise<boolean>;
  /**
   * OPTIONAL (SPI 1.3.0, ADR 0055 D6) — enumerate blobs, keyset-paged ascending by address,
   * so a scan uses bounded memory and deleting entries mid-scan never skips a survivor.
   * Every blob present for the whole scan is returned exactly once. Implement together
   * with {@link deleteIfUntouchedSince}: the orphan pass requires both.
   */
  listPage?(opts: ContentListPageOptions): Promise<ContentListPage>;
}

/** Options for {@link InMemoryContentStore}. */
export interface InMemoryContentStoreOptions {
  /** Clock for touch times (epoch ms). Default `Date.now`. */
  now?: () => number;
}

/**
 * Reference in-memory {@link ContentStore} (tests / ephemeral apps). Content-addressed, so a
 * repeated `put` of identical bytes stores one blob — dedup is visible via {@link size} — and
 * bumps that blob's touch time (SPI 1.3.0).
 */
export class InMemoryContentStore implements ContentStore {
  private readonly blobs = new Map<string, { bytes: Uint8Array; touchedAt: number }>();
  /**
   * Addresses in ascending order for `listPage`'s keyset scan, rebuilt lazily: only a NEW
   * address invalidates it (O(1) per put), a delete leaves a stale entry the scan skips, so a
   * sweep deleting while it pages sorts once — O(n log n) per scan, O(log n + limit) per page.
   */
  private sorted: string[] = [];
  private sortedStale = false;
  private readonly now: () => number;

  constructor(options: InMemoryContentStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async put(bytes: Uint8Array): Promise<ContentRef> {
    const address = contentAddress(bytes);
    this.store(address, bytes);
    return { __loomContent: address, size: bytes.length };
  }

  async putStream(stream: AsyncIterable<Uint8Array>): Promise<ContentRef> {
    // Hash incrementally while spooling (an in-memory store holds the bytes
    // anyway — durable backends spool to their medium instead of an array).
    const hash = createHash("sha256");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream) {
      hash.update(chunk);
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    const address = `sha256:${hash.digest("hex")}`;
    const existing = this.blobs.get(address);
    if (existing !== undefined) {
      existing.touchedAt = this.now();
    } else {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      this.store(address, bytes);
    }
    return { __loomContent: address, size };
  }

  async get(ref: ContentRef): Promise<Uint8Array | null> {
    return this.blobs.get(ref.__loomContent)?.bytes ?? null;
  }

  async getMany(refs: readonly ContentRef[]): Promise<(Uint8Array | null)[]> {
    return refs.map((ref) => this.blobs.get(ref.__loomContent)?.bytes ?? null);
  }

  async delete(ref: ContentRef): Promise<void> {
    this.blobs.delete(ref.__loomContent);
  }

  async deleteIfUntouchedSince(ref: ContentRef, cutoffMs: number): Promise<boolean> {
    // No await between the check and the delete: atomic on the event loop.
    const blob = this.blobs.get(ref.__loomContent);
    if (blob === undefined || !(blob.touchedAt < cutoffMs)) return false;
    return this.blobs.delete(ref.__loomContent);
  }

  async listPage(opts: ContentListPageOptions = {}): Promise<ContentListPage> {
    const limit = contentListPageLimit(opts.limit);
    if (this.sortedStale || this.sorted.length > 2 * this.blobs.size + 64) {
      this.sorted = [...this.blobs.keys()].sort();
      this.sortedStale = false;
    }
    let i = opts.cursor === undefined ? 0 : upperBound(this.sorted, opts.cursor);
    const entries: ContentPageEntry[] = [];
    let last: string | undefined;
    for (; i < this.sorted.length && entries.length < limit; i++) {
      const address = this.sorted[i] as string;
      last = address;
      const blob = this.blobs.get(address);
      if (blob === undefined) continue; // deleted since the last rebuild
      if (opts.touchedBefore !== undefined && !(blob.touchedAt < opts.touchedBefore)) continue;
      entries.push({ address, touchedAt: blob.touchedAt });
    }
    return i < this.sorted.length && last !== undefined
      ? { entries, nextCursor: last }
      : { entries };
  }

  /** Number of distinct blobs stored — makes content-addressed dedup observable in tests. */
  get size(): number {
    return this.blobs.size;
  }

  private store(address: string, bytes: Uint8Array): void {
    const touchedAt = this.now();
    const existing = this.blobs.get(address);
    if (existing !== undefined) {
      existing.touchedAt = touchedAt; // a re-citation: bump, keep the stored bytes
      return;
    }
    this.blobs.set(address, { bytes, touchedAt });
    this.sortedStale = true;
  }
}

/** First index whose element is strictly greater than `key` (binary search). */
function upperBound(sorted: readonly string[], key: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as string) <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
