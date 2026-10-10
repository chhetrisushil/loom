import type { Identity } from "./access";
import { parseSignedEnvelope, signedEnvelope } from "./conversation";

/** What a host-signed inbox envelope says (the signature is added by {@link signInboxEnvelope}). */
export interface InboxEnvelopeBody {
  /** The conversation this message is for. A signature for one conversation is refused by any other. */
  conversationId: string;
  /** `"user"` is a turn (needs `text`); `"close"` closes the conversation. */
  kind: "user" | "close";
  /** The replay-set key: unique per message. Re-using an id is refused as `replayed`. */
  id: string;
  /** Issue time, ms since epoch. An envelope at or before the conversation's staleness floor is refused as `stale`. */
  iat: number;
  /** The user text (kind `"user"`). */
  text?: string;
  /** Whose voice this is. Owner mode accepts only the owner's; shared mode needs a participant. */
  asker?: Identity;
  /** Shared mode: the `ord` of the asker's earlier user turn this one replaces. */
  editOf?: number;
}

/** Thrown by {@link signInboxEnvelope} when the body is not an envelope the conversation would accept the SHAPE of. */
export class InvalidEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEnvelopeError";
  }
}

/**
 * Sign an inbox envelope the way a host's own client does, so a test, a script or a TRUSTED bridge can write
 * to a conversation's inbox directly (`runtime.send(id, { topic: CONVERSATION_TOPIC, payload })`).
 *
 * - It needs the conversation's envelope key (`ConversationFlowOptions.key`). The key is the authority of a
 *   TRUSTED bridge: keep it server-side, never ship it to a browser, and rotate it via `previousKeys`.
 * - The body is checked up front with the same shape rules the conversation applies (a non-empty `id` of
 *   at most 256 chars, a finite `iat`, a valid `asker`, `text` for `"user"`, a positive integer `editOf`);
 *   a body that would be refused as malformed throws {@link InvalidEnvelopeError} instead of being signed.
 * - A signature is NOT "nothing". A holder of the key can: (1) in SHARED mode, speak as ANY participant (the
 *   body checks only that the named `asker` is a participant); (2) edit that asker's earlier turns (`editOf`
 *   is checked against the signed `asker`, so it is only as strong as (1)); (3) bypass the client-only
 *   checks: the per-asker queue cap (`maxQueuedPerAsker`), and the "delegated sender needs `principalFor`"
 *   rule; (4) in OWNER mode the `asker` = owner comparison is a consistency check, not authentication: the
 *   runtime's access policy on `send` decides who may write at all; (5) write to EVERY conversation the
 *   runtime's `send` policy admits, because the key is per flow, not per tenant; (6) skew the staleness
 *   floor: an `iat` up to 60 s in the future is accepted, and once that id is evicted from the replay set
 *   the floor moves forward, making legitimate envelopes issued in the following ~60 s `stale`.
 * - What still holds against a key holder: the conversation binding, replayed ids, the staleness floor and
 *   age window, the owner-mode voice, the shared-mode participant check for user turns, a shared-mode
 *   close needing the owner, the service principal or a `manageParticipants` manager, `maxTurnChars`, and
 *   the shape checks above.
 * - Intended users: tests and trusted server-side bridges. An application normally calls
 *   `conversations.sendTurn`, which builds and signs the envelope itself.
 */
export function signInboxEnvelope(key: string, body: InboxEnvelopeBody): Record<string, unknown> {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError(
      "signInboxEnvelope: `key` must be the conversation's non-empty envelope key"
    );
  }
  const signed = signedEnvelope(key, { ...body });
  const { reason } = parseSignedEnvelope(signed, key, body.conversationId);
  if (reason !== undefined) {
    throw new InvalidEnvelopeError(
      `signInboxEnvelope: the body would be refused as ${reason} (check conversationId, kind, id, iat, text, asker, editOf)`
    );
  }
  return signed;
}
