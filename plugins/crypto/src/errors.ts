import type { EventEnvelope } from "@loom/core";
import { brandPayloadShredded } from "@loom/event-runtime";

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
    // The realm-safe brand the kernel classifies erasure by (never the name alone; ADR 0039).
    brandPayloadShredded(this);
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

/**
 * A whole-state snapshot envelope (`sealState`) the subject's key, which EXISTS, could not open
 * as the slot it was loaded from: a row copied from another execution, an older snapshot rolled
 * into a newer sequence, an envelope without the binding marker, or corruption. Distinct from
 * {@link PayloadShreddedError} so a defect never reads as an erasure.
 */
export class SnapshotUndecryptableError extends Error {
  constructor(
    readonly subjectId: string,
    readonly executionId: string,
    readonly sequence: number,
    override readonly cause?: unknown
  ) {
    super(
      `snapshot ${sequence} of execution "${executionId}" (subject "${subjectId}") could not be opened although the key exists: the sealed state is bound to its own execution id and sequence, so a row moved from another slot, a rolled-back snapshot, an unbound envelope or corruption all fail here`
    );
    this.name = "SnapshotUndecryptableError";
    Object.setPrototypeOf(this, SnapshotUndecryptableError.prototype);
  }
}

/**
 * A `sealState` store configured with `legacyPlaintext: "refuse"` loaded a snapshot whose state is
 * not a whole-state envelope (plaintext or static-path): a sealed deployment must not be
 * downgraded by swapping a sealed row for a plaintext one.
 */
export class PlaintextSnapshotRefusedError extends Error {
  constructor(
    readonly executionId: string,
    readonly sequence: number
  ) {
    super(
      `snapshot ${sequence} of execution "${executionId}" is not sealed, and this store is configured with legacyPlaintext: "refuse". Re-save it through a sealState store, or set legacyPlaintext: "load" to read pre-sealState snapshots.`
    );
    this.name = "PlaintextSnapshotRefusedError";
    Object.setPrototypeOf(this, PlaintextSnapshotRefusedError.prototype);
  }
}

/**
 * ADR 0143 - a sealing content store ({@link EncryptingContentStore}) was called without the owning
 * execution. It cannot know whose key to use, and it never seals under a guess or returns bytes it could not
 * authenticate to a subject: it refuses.
 */
export class ContentAccessRequiredError extends Error {
  constructor(operation: string) {
    super(
      `EncryptingContentStore.${operation}: no content access (the owning executionId + workflowId) was given, so the subject whose key seals/opens the blob is unknown. Pass it as the second argument (the claim-check middleware, exportSubject and resolveClaimCheck do); a content store that seals per subject cannot be driven without it.`
    );
    this.name = "ContentAccessRequiredError";
    Object.setPrototypeOf(this, ContentAccessRequiredError.prototype);
  }
}

/**
 * ADR 0143 - a blob exists but did NOT open under the subject's key, although the key exists: corruption,
 * a tampered row, a blob moved from another subject, or a `subjectOf` that drifted since it was sealed.
 * Deliberately not {@link PayloadShreddedError}: a defect never reads as an erasure, and plaintext or
 * garbage is never returned in its place.
 */
export class ContentUndecryptableError extends Error {
  constructor(
    readonly subjectId: string,
    readonly address: string,
    override readonly cause?: unknown
  ) {
    super(
      `content blob "${address}" could not be opened under subject "${subjectId}"'s key although the key exists: the stored bytes are corrupt, were tampered with or moved from another subject, or the subject mapping drifted since they were sealed`
    );
    this.name = "ContentUndecryptableError";
    Object.setPrototypeOf(this, ContentUndecryptableError.prototype);
  }
}
