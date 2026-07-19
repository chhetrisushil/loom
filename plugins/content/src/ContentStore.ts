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
 */
export const CONTENT_STORE_SPI_VERSION = "1.2.0";

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
}

/**
 * Reference in-memory {@link ContentStore} (tests / ephemeral apps). Content-addressed, so a
 * repeated `put` of identical bytes stores one blob — dedup is visible via {@link size}.
 */
export class InMemoryContentStore implements ContentStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<ContentRef> {
    const address = contentAddress(bytes);
    if (!this.blobs.has(address)) this.blobs.set(address, bytes);
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
    if (!this.blobs.has(address)) {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      this.blobs.set(address, bytes);
    }
    return { __loomContent: address, size };
  }

  async get(ref: ContentRef): Promise<Uint8Array | null> {
    return this.blobs.get(ref.__loomContent) ?? null;
  }

  async getMany(refs: readonly ContentRef[]): Promise<(Uint8Array | null)[]> {
    return refs.map((ref) => this.blobs.get(ref.__loomContent) ?? null);
  }

  async delete(ref: ContentRef): Promise<void> {
    this.blobs.delete(ref.__loomContent);
  }

  /** Number of distinct blobs stored — makes content-addressed dedup observable in tests. */
  get size(): number {
    return this.blobs.size;
  }
}
