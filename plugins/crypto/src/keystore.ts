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
  /**
   * Get the subject's key, creating one on first use.
   *
   * MUST be an ATOMIC create-if-absent across every caller and node sharing the store (ADR 0139 D22):
   * concurrent first calls for one subject all resolve to the SAME key. Two callers that each mint and
   * "last writer wins" leave one of them holding a key nothing else can find - erasure then destroys one
   * key and reports success while the other copy of the data stays readable. Implement it as a conditional
   * write (`INSERT ... ON CONFLICT DO NOTHING` then re-read; a KMS/vault create-if-not-exists /
   * compare-and-set), never as `get` -> `write`. Held by the conformance kit
   * (`runKeyStoreConformance`, "concurrent getOrCreate").
   */
  getOrCreate(subjectId: string): Promise<Buffer>;
  /** Get the subject's key, or null if it never existed OR was destroyed (shredded). */
  get(subjectId: string): Promise<Buffer | null>;
  /**
   * Destroy a subject's key — irreversible erasure of everything encrypted under it. MUST be
   * idempotent: destroying an absent or already-destroyed key is a no-op (a retried
   * `shredSubject` destroys again before writing its missing tombstones).
   *
   * After a destroy, `getOrCreate` MUST NOT mint a new key for the subject (throw, as
   * {@link InMemoryKeyStore} does). A re-minted key cannot open the older ciphertext, and an
   * inbox read then raises `PayloadUndecryptableError` instead of reading as erased.
   */
  destroy(subjectId: string): Promise<void>;
  /**
   * OPTIONAL (ADR 0130 D7, round 5) - proof of destruction. `true` ONLY if THIS store destroyed
   * (tombstoned) the subject's key: a `destroy` call recorded it, durably when the store is. A
   * subject never minted here, or minted and still alive, is `false`.
   *
   * The log can prove an erase INTENT, never that the key died; a retry of `shredSubject` on a
   * node whose key store merely lacks the key (wrong key, partitioned store) must not report an
   * erasure that never happened while the real key lives on. Only the key store can say. Without
   * this method, `shredSubject` completes a window retry only under the operator's explicit
   * `force: "key-destroyed-elsewhere"`, and `eraseSubject` / `exportSubject` only with an explicit
   * `destroyed` proof. Implement it on any store that can persist a tombstone.
   */
  wasDestroyed?(subjectId: string): Promise<boolean>;
  /**
   * Does this store survive a restart? **Declare it.**
   *
   * Losing a key is indistinguishable from shredding the subject: the log is still there,
   * every field encrypted under that key is permanently unreadable, and nothing fails at the
   * time it happens. A store that cannot persist must say `false` so a pre-flight check can
   * refuse it before the data is written, not after.
   *
   * Omitting it is not the same as `false` — it means *this store does not say*, which
   * `loom doctor` reports as an advisory rather than silently accepting.
   */
  readonly durable?: boolean;
}

/** Reference in-memory {@link KeyStore} (tests / ephemeral apps). */
export class InMemoryKeyStore implements KeyStore {
  /**
   * Declared, not inferred. Wired behind an `EncryptingEventStore`, this store makes every
   * encrypted field unreadable the moment the process ends — a durable log whose contents
   * are gone. Saying so lets `loom doctor` refuse the combination.
   */
  readonly durable = false;
  private readonly keys = new Map<string, Buffer>();
  private readonly destroyed = new Set<string>();

  async getOrCreate(subjectId: string): Promise<Buffer> {
    // Atomic create-if-absent: no await between the lookup and the set (single-threaded), so concurrent
    // callers all see the one key.
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

  async wasDestroyed(subjectId: string): Promise<boolean> {
    return this.destroyed.has(subjectId);
  }

  async destroy(subjectId: string): Promise<void> {
    this.keys.delete(subjectId);
    this.destroyed.add(subjectId); // tombstone: getOrCreate must never resurrect it
  }
}
