import { createHmac } from "node:crypto";
import { inboxChainOf, senderErasedMarker } from "@loom/event-runtime";
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

/**
 * The erasure SUBJECT of a sender, or `undefined` for an anonymous one (nothing to seal). It may be async
 * (the default derives it from key material held in the {@link KeyStore}).
 */
export type SenderSubjectOf = (
  sender: SenderIdentity
) => string | undefined | Promise<string | undefined>;

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

const SENDER_AAD_V = "loom-sender-v1";

/**
 * The context a sealed sender is bound to (AEAD additional data, ADR 0139 N7): WHICH MESSAGE the envelope
 * is - its chain, topic and position in the inbox (`chain|topic|sequence`) - so a sealed sender cut from one
 * message cannot be pasted into another (a swap authenticates as corruption, never as a different sender).
 *
 * The position is the envelope's sequence, EXCEPT for a quarantine copy, which a node that cannot open the
 * message copies VERBATIM (sender still sealed) into `__loom_quarantine__:<chain>` at another sequence and
 * stamps with the original's (`metadata.quarantine.inboxSeq`): that stamped inbox sequence stands in, so
 * the copy still opens where the original would. The chain comes from the stream id (inbox, topic stream,
 * quarantine stream and an archive late key all resolve to it); the topic is the payload's (in the clear).
 */
export function senderBindOf(e: {
  executionId: string;
  sequence: number;
  payload?: unknown;
  metadata?: unknown;
}): string {
  const chain = inboxChainOf(e.executionId) ?? e.executionId;
  const topic = (e.payload as { topic?: unknown } | null | undefined)?.topic;
  const stamped = (e.metadata as { quarantine?: { inboxSeq?: unknown } } | null | undefined)
    ?.quarantine?.inboxSeq;
  const seq = typeof stamped === "number" ? stamped : e.sequence;
  return `${chain}|${typeof topic === "string" ? topic : ""}|${seq}`;
}

/** Seal `sender` under `key` (the key of `subject`), bound to `bind` ({@link senderBindOf}). */
export function sealSender(
  key: Buffer,
  subject: string,
  sender: unknown,
  bind: string
): SealedSender {
  const env = encryptValue(key, sender, { v: SENDER_AAD_V, bind });
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
export async function openSender(
  keys: KeyStore,
  sealed: SealedSender,
  bind: string
): Promise<unknown> {
  const key = await keys.get(sealed.subject);
  // The opaque handle rides along as the erased sender's stable reference (ADR 0139 N3).
  if (key === null) return senderErasedMarker(sealed.subject);
  return decryptValue(key, JSON.parse(Buffer.from(sealed.ct, "base64").toString("utf-8")), bind);
}

// ── ADR 0139 N6 - the DEFAULT sender subject: an opaque, keyed, erasable handle ─────────────────────
//
// The sender's erasure subject is stored in the clear beside the ciphertext, so it must not be (or be
// derivable from) the identity. The default derives it from KeyStore-held material:
//
//   id     = HMAC(master, [tenant, actor])         master: a KeyStore key, `__loom_sender_master__`
//   seed   = the KeyStore key `__loom_sender_seed__:<id>`   (32 random bytes, minted on first use)
//   handle = "sbj-" + HMAC(seed, "handle")          the subject the sender's sealing key lives under
//
// Erasing the sender destroys the handle's sealing key AND the seed. The log then holds a handle that no
// longer opens anything and that nobody - the operator holding `master` included - can recompute from the
// identity (the seed it derives from is gone): the erased messages are unlinkable to the person. A
// sender erased this way cannot send again (the seed cannot be re-minted: the KeyStore refuses).

const MASTER_SUBJECT = "__loom_sender_master__";
const SEED_PREFIX = "__loom_sender_seed__:";

/** A send from a sender whose identity was erased (their handle seed was destroyed). */
export class SenderErasedError extends Error {
  readonly retryable = false;
  constructor(cause: unknown) {
    super(
      `refusing to seal this message's sender: the sender was erased (their identity key material was destroyed), so a new message cannot be attributed to them. ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = "SenderErasedError";
    Object.setPrototypeOf(this, SenderErasedError.prototype);
  }
}

/** The default {@link SenderSubjectOf} and the erasure verb that goes with it, over one {@link KeyStore}. */
export class SenderHandles {
  private master: Promise<Buffer> | undefined;

  constructor(private readonly keys: KeyStore) {}

  private masterKey(): Promise<Buffer> {
    this.master ??= this.keys.getOrCreate(MASTER_SUBJECT).catch((err: unknown) => {
      this.master = undefined;
      throw err;
    });
    return this.master;
  }

  /** The sender's identity in the one form the handle is derived from (`undefined`: anonymous). */
  private static identity(sender: SenderIdentity): string | undefined {
    const who = sender.actor ?? sender.onBehalfOf;
    return who === undefined ? undefined : JSON.stringify([sender.tenant ?? "", who]);
  }

  private async seedId(identity: string): Promise<string> {
    return createHmac("sha256", await this.masterKey())
      .update(identity)
      .digest("hex");
  }

  private static handleOf(seed: Buffer): string {
    return `sbj-${createHmac("sha256", seed).update("handle").digest("hex").slice(0, 32)}`;
  }

  /** The handle to seal under (mints the seed on a sender's first message). */
  readonly subjectOf: SenderSubjectOf = async (sender) => {
    const identity = SenderHandles.identity(sender);
    if (identity === undefined) return undefined;
    let seed: Buffer;
    try {
      seed = await this.keys.getOrCreate(`${SEED_PREFIX}${await this.seedId(identity)}`);
    } catch (cause) {
      throw new SenderErasedError(cause);
    }
    return SenderHandles.handleOf(seed);
  };

  /**
   * Erase a sender: destroy the key their identity is sealed under, then the seed the handle derives
   * from. Idempotent (a retry after a crash between the two finishes it); `false` when the sender never
   * sent a sealed message (or was already erased). Identifies the sender as `subjectOf` does: `[tenant,
   * actor]`.
   */
  async erase(sender: SenderIdentity): Promise<boolean> {
    const identity = SenderHandles.identity(sender);
    if (identity === undefined) return false;
    const seedSubject = `${SEED_PREFIX}${await this.seedId(identity)}`;
    const seed = await this.keys.get(seedSubject);
    if (seed === null) return false;
    await this.keys.destroy(SenderHandles.handleOf(seed)); // first: a crash leaves the seed to retry from
    await this.keys.destroy(seedSubject);
    return true;
  }
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
