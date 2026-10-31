import { SENDER_ERASED } from "@loom/event-runtime";
import { decryptValue, encryptValue } from "./crypto";
import type { KeyStore } from "./keystore";

// ── ADR 0139 D12 - an inbox envelope's SENDER is sealed under the SENDER's subject ───────────────────
//
// An inbox envelope (`INBOX_MESSAGE`) carries the message body (the OWNER's data, sealed under the owner's
// subject) and the SENDER's identity (`payload.sender`: actor, tenant, onBehalfOf). The identity is the
// sender's personal data sitting in ANOTHER chain's stream and, after a trim, in that chain's archive. It
// is therefore sealed under the sender's own subject, so erasing the sender shreds their identity
// everywhere it was copied while the message body stays under the owner's record. A reader whose sender
// key is gone gets the `{ erased: true }` marker in place of the identity and never an error: the OWNER's
// message must stay readable.
//
// The sealed form deliberately carries no `__loomEnc` key (the ciphertext rides base64-encoded): the
// kernel's sealed-payload guard recognises that shape and would read a still-sealed sender as an
// unopenable message; this one is opened (or erased) by the store layer before anything above sees it.

/** What identifies a message's sender (the inbox envelope's `sender`). */
export interface SenderIdentity {
  actor?: string;
  tenant?: string;
  onBehalfOf?: string;
}

/** The erasure SUBJECT of a sender, or `undefined` for an anonymous one (nothing to seal). */
export type SenderSubjectOf = (sender: SenderIdentity) => string | undefined;

/** The stored form of a sealed sender. */
export interface SealedSender {
  $loomSender: 1;
  subject: string;
  ct: string;
}

export function isSealedSender(v: unknown): v is SealedSender {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { $loomSender?: unknown }).$loomSender === 1 &&
    typeof (v as { subject?: unknown }).subject === "string" &&
    typeof (v as { ct?: unknown }).ct === "string"
  );
}

/** Seal `sender` under `key` (the key of `subject`). */
export function sealSender(key: Buffer, subject: string, sender: unknown): SealedSender {
  const env = encryptValue(key, sender);
  return {
    $loomSender: 1,
    subject,
    ct: Buffer.from(JSON.stringify(env), "utf-8").toString("base64"),
  };
}

/**
 * Open a sealed sender: the identity, or {@link SENDER_ERASED} when its subject's key is gone. A key that
 * exists but cannot open the value is corruption and throws (it must never read as an erasure).
 */
export async function openSender(keys: KeyStore, sealed: SealedSender): Promise<unknown> {
  const key = await keys.get(sealed.subject);
  if (key === null) return SENDER_ERASED;
  return decryptValue(key, JSON.parse(Buffer.from(sealed.ct, "base64").toString("utf-8")));
}

/** Whether `payload` is an inbox message payload with a plaintext, non-empty sender object. */
export function plaintextSenderOf(payload: unknown): SenderIdentity | undefined {
  const sender = (payload as { sender?: unknown } | null | undefined)?.sender;
  if (typeof sender !== "object" || sender === null || isSealedSender(sender)) return undefined;
  const s = sender as SenderIdentity & { erased?: unknown };
  if (s.erased === true) return undefined;
  return s.actor === undefined && s.tenant === undefined && s.onBehalfOf === undefined
    ? undefined
    : s;
}
