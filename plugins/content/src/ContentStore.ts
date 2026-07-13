import { type ContentRef, contentAddress } from "./content";

// ── ADR 0046 — the ContentStore SPI ───────────────────────────────────────────
//
// A key→blob store for externalized payload bytes, addressed by content hash. Back it with
// object storage / a filesystem / an encrypted blob store in production (as separate
// `@loom/plugin-content-*` backends); the reference implementation here is in-memory.

export interface ContentStore {
  /** Store bytes, returning their content-addressed ref. Idempotent by hash (stored once). */
  put(bytes: Uint8Array): Promise<ContentRef>;
  /** Resolve a ref to its bytes, or `null` if erased/absent — MUST NOT throw on absence. */
  get(ref: ContentRef): Promise<Uint8Array | null>;
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

  async get(ref: ContentRef): Promise<Uint8Array | null> {
    return this.blobs.get(ref.__loomContent) ?? null;
  }

  async delete(ref: ContentRef): Promise<void> {
    this.blobs.delete(ref.__loomContent);
  }

  /** Number of distinct blobs stored — makes content-addressed dedup observable in tests. */
  get size(): number {
    return this.blobs.size;
  }
}
