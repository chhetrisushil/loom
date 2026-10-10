import type { EventEnvelope } from "@loom/core";

/**
 * K10.2 — a read touched payload encrypted under a subject key that has been
 * DESTROYED (crypto-shredded). Replay of a shredded execution MUST fail
 * explicitly like this — never silently diverge by folding ciphertext or a
 * default. The `PAYLOAD_SHREDDED` tombstone in the log records the erasure; this
 * is the loud failure the acceptance criterion requires.
 */
export class PayloadShreddedError extends Error {
  constructor(
    readonly subjectId: string,
    readonly executionId?: string,
    /**
     * The events the failed read returned, each sealed field replaced by `{ $shredded: true }`.
     * For lifecycle operations that need no sealed field (cancelling an erased owner) and for
     * operator tooling; NEVER the basis of a resume (the placeholder is not the original value).
     */
    readonly redacted?: readonly EventEnvelope[]
  ) {
    super(
      `payload for subject "${subjectId}"${executionId ? ` (execution "${executionId}")` : ""} was crypto-shredded: the encryption key is destroyed, so the sensitive fields are unrecoverable and replay cannot proceed`
    );
    this.name = "PayloadShreddedError";
    Object.setPrototypeOf(this, PayloadShreddedError.prototype);
  }
}

/**
 * A chain's inbox stream (ADR 0110 D9) holds ciphertext that the subject's key, which EXISTS, cannot
 * open: corruption, a tampered row, or a `subjectOf` that no longer resolves the stream to the
 * subject it was sealed under. It is deliberately not {@link PayloadShreddedError} and never reads
 * as the erasure marker, so a defect cannot pass for an erasure.
 */
export class PayloadUndecryptableError extends Error {
  constructor(
    readonly subjectId: string,
    readonly executionId?: string,
    override readonly cause?: unknown
  ) {
    super(
      `payload for subject "${subjectId}"${executionId ? ` (stream "${executionId}")` : ""} could not be decrypted although the key exists: the stored ciphertext is corrupt, or the subject the stream resolves to has changed since it was sealed`
    );
    this.name = "PayloadUndecryptableError";
    Object.setPrototypeOf(this, PayloadUndecryptableError.prototype);
  }
}

/**
 * A write to a chain's inbox stream needed the OWNER's workflow id (a `subjectOf` keyed on it) and
 * it could not be resolved (a transient read failure, the owner has no log yet, no ranged read).
 * The write FAILS and is retryable; it is never sealed under a guessed subject.
 */
export class OwnerUnresolvedError extends Error {
  constructor(
    readonly chainId: string,
    why: string,
    override readonly cause?: unknown
  ) {
    super(
      `cannot resolve the owner of inbox chain "${chainId}" (${why}): refusing to seal its payload under a guessed erasure subject. Retry.`
    );
    this.name = "OwnerUnresolvedError";
    Object.setPrototypeOf(this, OwnerUnresolvedError.prototype);
  }
}
