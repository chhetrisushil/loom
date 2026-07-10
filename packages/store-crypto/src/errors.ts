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
    readonly executionId?: string
  ) {
    super(
      `payload for subject "${subjectId}"${executionId ? ` (execution "${executionId}")` : ""} was crypto-shredded: the encryption key is destroyed, so the sensitive fields are unrecoverable and replay cannot proceed`
    );
    this.name = "PayloadShreddedError";
    Object.setPrototypeOf(this, PayloadShreddedError.prototype);
  }
}
