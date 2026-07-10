import { randomBytes } from "node:crypto";

// ── K10.2 — per-subject key management ────────────────────────────────────────
//
// Crypto-shredding = "encrypt sensitive payload fields at rest, then satisfy
// erasure by DESTROYING THE KEY" (GDPR right-to-erasure without rewriting an
// append-only log). The key lives here, keyed by a SUBJECT id — the unit of
// erasure. Default subject = executionId (per-execution keys), but a subject can
// span executions (per-data-subject erasure), which is also how fork lineage is
// handled: a forked child resolves to the parent's subject, so the parent's
// copied-ciphertext prefix stays readable and shredding the subject erases the
// parent and all its forks together (they hold the same personal data). See A2.

/**
 * Key material store. Back it with a KMS/HSM in production; destroying a key is
 * the erasure primitive, so its durability + true deletion are security-critical.
 */
export interface KeyStore {
  /** Get the subject's key, creating one on first use. */
  getOrCreate(subjectId: string): Promise<Buffer>;
  /** Get the subject's key, or null if it never existed OR was destroyed (shredded). */
  get(subjectId: string): Promise<Buffer | null>;
  /** Destroy a subject's key — irreversible erasure of everything encrypted under it. */
  destroy(subjectId: string): Promise<void>;
}

/** Reference in-memory {@link KeyStore} (tests / ephemeral apps). */
export class InMemoryKeyStore implements KeyStore {
  private readonly keys = new Map<string, Buffer>();
  private readonly destroyed = new Set<string>();

  async getOrCreate(subjectId: string): Promise<Buffer> {
    if (this.destroyed.has(subjectId)) {
      throw new Error(`key for subject "${subjectId}" was destroyed (shredded); cannot recreate`);
    }
    let key = this.keys.get(subjectId);
    if (key === undefined) {
      key = randomBytes(32); // AES-256
      this.keys.set(subjectId, key);
    }
    return key;
  }

  async get(subjectId: string): Promise<Buffer | null> {
    return this.keys.get(subjectId) ?? null;
  }

  async destroy(subjectId: string): Promise<void> {
    this.keys.delete(subjectId);
    this.destroyed.add(subjectId); // tombstone: getOrCreate must never resurrect it
  }
}
