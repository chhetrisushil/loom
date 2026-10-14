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

/**
 * ADR 0130 residuals D7 (round 4) - does this stream carry the DURABLE ERASE INTENT of `subjectId`?
 * `shredSubject` appends an `ERASURE_PENDING` (an existing, ignorable, pure-audit kernel kind) naming
 * the key's subject to each affected execution's log BEFORE it destroys the key. It is the only
 * evidence that distinguishes the ShredIncomplete window (key destroyed, tombstone not yet written:
 * intent present) from a node that simply never had the key (no intent). `subjectId` omitted accepts
 * any intent.
 */
export function recordsErasureIntent(
  events: readonly Pick<EventEnvelope, "eventType" | "payload">[],
  subjectId?: string
): boolean {
  return events.some(
    (e) =>
      e.eventType === "ERASURE_PENDING" &&
      (subjectId === undefined ||
        (e.payload as { subjectId?: unknown } | null)?.subjectId === subjectId)
  );
}

/**
 * ADR 0130 D7 (round 5) - proof that the KEY STORE destroyed `subjectId`'s key (`KeyStore.wasDestroyed`,
 * or the operator's explicit assertion `() => true`). The log proves intent, never destruction.
 */
export type DestructionProof = (subjectId: string) => boolean | Promise<boolean>;

/**
 * The retry window, decided: a {@link KeyUnavailableError} carrying a redacted view is the genuine
 * ShredIncomplete window ONLY when that view records this subject's erase intent AND `destroyed`
 * proves the key store destroyed the key (a dangling intent whose key still lives elsewhere is not
 * the window). No proof, or a false one, fails closed. Returns the redacted view in that case,
 * `undefined` otherwise (the caller rethrows).
 */
export async function erasureWindowView(
  err: unknown,
  destroyed?: DestructionProof
): Promise<readonly EventEnvelope[] | undefined> {
  if (!isKeyUnavailable(err) || !err.redacted) return undefined;
  if (!recordsErasureIntent(err.redacted, err.subjectId)) return undefined;
  if (destroyed === undefined || (await destroyed(err.subjectId)) !== true) return undefined;
  return err.redacted;
}
