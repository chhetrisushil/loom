import type { EventEnvelope } from "@loom/core";

/** The stable `code` of {@link KeyUnavailableError}. */
export const KEY_UNAVAILABLE_CODE = "KEY_UNAVAILABLE" as const;

/**
 * ADR 0130 residuals D7 - a sealing store holds ciphertext for a subject whose key THIS node's key
 * store does not have, and the log carries NO `PAYLOAD_SHREDDED` tombstone for it: the node is
 * misconfigured (a different or empty key store), not erased. It is deliberately not
 * `PayloadShreddedError`, which stays exclusively the erasure outcome. Lives beside the store error
 * contract so the kernel can recognise it without depending on the crypto plugin.
 *
 * Carries the subject id and stream id, never ciphertext or key material. The kernel translates it
 * to a denial-shaped `SealedStreamUnreadableError` (operator-only detail `key-unavailable`).
 */
export class KeyUnavailableError extends Error {
  readonly code = KEY_UNAVAILABLE_CODE;
  constructor(
    readonly subjectId: string,
    readonly streamId?: string,
    /** The stream's workflow id (a plaintext column), so the kernel can word its refusal. */
    readonly workflowId?: string,
    /**
     * The stream with each sealed field replaced by a placeholder (its status and tip are
     * plaintext). Lets the erasure lifecycle (`EraseCoordinator`, `exportSubject`) judge a stream
     * in the ShredIncomplete window (key destroyed, tombstone not yet written). Never ciphertext.
     */
    readonly redacted?: readonly EventEnvelope[]
  ) {
    super(
      `the encryption key for subject "${subjectId}"${streamId ? ` (stream "${streamId}")` : ""} is not available to this node and the log records no erasure (no PAYLOAD_SHREDDED): this node's key store lacks the key. It is not a crypto-shred.`
    );
    this.name = "KeyUnavailableError";
    Object.setPrototypeOf(this, KeyUnavailableError.prototype);
  }
}

/** True for a {@link KeyUnavailableError}, by its stable `code` (survives duplicate package copies). */
export function isKeyUnavailable(e: unknown): e is KeyUnavailableError {
  return (e as { code?: unknown } | null)?.code === KEY_UNAVAILABLE_CODE;
}
