import type { Identity } from "./access";
import { signedEnvelope } from "./conversation";

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

/**
 * Sign an inbox envelope the way a host's own client does, so a test, a script or a TRUSTED bridge can write
 * to a conversation's inbox directly (`runtime.send(id, { topic: CONVERSATION_TOPIC, payload })`).
 *
 * - It needs the conversation's envelope key (`ConversationFlowOptions.key`). Anyone holding that key can
 *   mint envelopes: keep it server-side, never ship it to a browser, and rotate it via `previousKeys`.
 * - Signing authorizes NOTHING by itself. The conversation still refuses an envelope for another
 *   conversation, a replayed `id`, a stale `iat`, and (owner mode) any voice but the owner's or (shared mode)
 *   any asker who is not a participant. The runtime's access policy still decides who may `send` at all.
 * - Intended users: tests and trusted server-side bridges. An application normally calls
 *   `conversations.sendTurn`, which builds and signs the envelope itself.
 */
export function signInboxEnvelope(key: string, body: InboxEnvelopeBody): Record<string, unknown> {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError(
      "signInboxEnvelope: `key` must be the conversation's non-empty envelope key"
    );
  }
  return signedEnvelope(key, { ...body });
}
