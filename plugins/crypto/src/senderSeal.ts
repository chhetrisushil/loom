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
 * the copy still opens where the original would. The stamp itself is NOT authenticated: whoever can write
 * the quarantine stream could relabel a copy's position, which is outside the threat model (they could as
 * well replace the copy); the message id (ADR 0139 D23) is bound too, so the position alone is not enough
 * to paste a sender onto a different message. The chain comes from the stream id (inbox, topic stream,
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
  const messageId = (e.payload as { messageId?: unknown } | null | undefined)?.messageId;
  return `${chain}|${typeof topic === "string" ? topic : ""}|${seq}|${typeof messageId === "string" ? messageId : ""}`;
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
// sender erased this way is BLOCKED (`SenderErasedError`: the seed cannot be re-minted, the KeyStore
// refuses) until an operator REINSTATES them (ADR 0139 D22): `reinstate` mints an authorization key for
// the next EPOCH (`__loom_sender_epoch__:<id>:<n>`), the next send mints a fresh seed
// (`__loom_sender_seed__:<id>:<n>`) and so a NEW handle. The old messages stay erased and are unlinkable
// to the new handle (a different seed, no derivation between them).
//
// The master is guarded: `__loom_sender_marker__` is minted before the first seed, so a master that
// is missing WHILE the marker exists is a LOST master (a re-minted one would derive different ids and an
// erase would silently find "nothing"): `SenderMasterLostError`, never a quiet `false`.

const MASTER_SUBJECT = "__loom_sender_master__";
const MARKER_SUBJECT = "__loom_sender_marker__";
const SEED_PREFIX = "__loom_sender_seed__:";
const EPOCH_PREFIX = "__loom_sender_epoch__:";

/** A send from a sender whose identity was erased (their handle seed was destroyed) and who was not reinstated. */
export class SenderErasedError extends Error {
  readonly retryable = false;
  constructor(cause: unknown) {
    super(
      `refusing to seal this message's sender: the sender was erased (their identity key material was destroyed), so a new message cannot be attributed to them until an operator reinstates them (reinstateSender). ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = "SenderErasedError";
    Object.setPrototypeOf(this, SenderErasedError.prototype);
  }
}

/**
 * The sender master key is gone (destroyed, or missing while sealed senders exist): no sender id can be
 * derived, so a sender can be neither sealed nor ERASED. Distinct from {@link SenderErasedError} (that is
 * one sender's erasure; this is the deployment's key material) - an erasure must fail loud on it, never
 * report "this sender never sent".
 */
export class SenderMasterLostError extends Error {
  readonly retryable = false;
  constructor(why: string, cause?: unknown) {
    super(
      `the sender master key is unavailable (${why}): sender handles cannot be derived, so a sender can neither be sealed nor erased. Restore the KeyStore entry "${MASTER_SUBJECT}"; erasure was NOT performed.`,
      cause === undefined ? undefined : { cause }
    );
    this.name = "SenderMasterLostError";
    Object.setPrototypeOf(this, SenderMasterLostError.prototype);
  }
}

/** Erasing a sender left a live handle or seed for them behind (a concurrent mint, a destroy that did not take). */
export class SenderEraseIncompleteError extends Error {
  readonly retryable = true;
  constructor(readonly handles: number) {
    super(
      `the sender's key material is still live after destroying it (${handles} live key(s) remain): a concurrent writer re-minted it or the KeyStore did not destroy. The erasure is NOT complete; retry it.`
    );
    this.name = "SenderEraseIncompleteError";
    Object.setPrototypeOf(this, SenderEraseIncompleteError.prototype);
  }
}

/** The outcome of {@link SenderHandles.reinstate}. */
export interface SenderReinstatement {
  /** `false`: nothing to reinstate (the sender is not erased, or never sent). */
  reinstated: boolean;
  /** The keyed, non-identifying id of the sender (HMAC under the master), for the operator's record. */
  ref?: string;
  /** The new epoch whose seed (and so handle) the sender's next message mints. */
  epoch?: number;
}

/** The default {@link SenderSubjectOf} and the erasure verbs that go with it, over one {@link KeyStore}. */
export class SenderHandles {
  private master: Buffer | undefined;
  private markerMinted = false;
  /**
   * In-flight resolutions by key (master, marker, a sender's seed): concurrent first uses on this node
   * share ONE mint (ADR 0139 D22). Cross-node atomicity is the KeyStore's (`getOrCreate` is atomic).
   */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly keys: KeyStore) {}

  private single<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.inflight.get(key) as Promise<T> | undefined;
    if (p === undefined) {
      p = fn().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  /**
   * The master. `mint: false` never creates it (erase / reinstate of a sender on a store that never sealed
   * one), and then returns `null`. A master missing while the marker exists, or destroyed, is a LOST master.
   */
  private loadMaster(mint: boolean): Promise<Buffer | null> {
    if (this.master !== undefined) return Promise.resolve(this.master);
    return this.single(`master:${mint}`, async () => {
      const existing = await this.keys.get(MASTER_SUBJECT);
      if (existing !== null) {
        this.master = existing;
        return existing;
      }
      if ((await this.keys.get(MARKER_SUBJECT)) !== null) {
        throw new SenderMasterLostError("missing while sealed senders exist");
      }
      if ((await this.keys.wasDestroyed?.(MASTER_SUBJECT)) === true) {
        throw new SenderMasterLostError("destroyed");
      }
      if (!mint) return null;
      try {
        this.master = await this.keys.getOrCreate(MASTER_SUBJECT);
        return this.master;
      } catch (cause) {
        throw new SenderMasterLostError("destroyed", cause);
      }
    });
  }

  /** Sealed senders exist from here on: a missing master is now a LOSS, not a first use. */
  private async ensureMarker(): Promise<void> {
    if (this.markerMinted) return;
    await this.single("marker", async () => {
      await this.keys.getOrCreate(MARKER_SUBJECT);
      this.markerMinted = true;
    });
  }

  /** The sender's identity in the one form the handle is derived from (`undefined`: anonymous). */
  private static identity(sender: SenderIdentity): string | undefined {
    const who = sender.actor ?? sender.onBehalfOf;
    return who === undefined ? undefined : JSON.stringify([sender.tenant ?? "", who]);
  }

  private static idOf(master: Buffer, identity: string): string {
    return createHmac("sha256", master).update(identity).digest("hex");
  }

  private static seedSubject(id: string, epoch: number): string {
    return epoch === 0 ? `${SEED_PREFIX}${id}` : `${SEED_PREFIX}${id}:${epoch}`;
  }

  private static epochSubject(id: string, epoch: number): string {
    return `${EPOCH_PREFIX}${id}:${epoch}`;
  }

  private static handleOf(seed: Buffer): string {
    return `sbj-${createHmac("sha256", seed).update("handle").digest("hex").slice(0, 32)}`;
  }

  /** The seed of the sender's CURRENT epoch (minted on first use); an erased, un-reinstated sender throws. */
  private async currentSeed(id: string): Promise<Buffer> {
    await this.ensureMarker();
    for (let epoch = 0; ; epoch++) {
      const subject = SenderHandles.seedSubject(id, epoch);
      try {
        return await this.keys.getOrCreate(subject);
      } catch (cause) {
        // A destroyed seed refuses; any other failure is a real error, not an erasure.
        if ((await this.keys.wasDestroyed?.(subject)) === false) throw cause;
        if ((await this.keys.get(SenderHandles.epochSubject(id, epoch + 1))) === null) {
          throw new SenderErasedError(cause);
        }
      }
    }
  }

  /** The handle to seal under (mints the seed on a sender's first message, ONCE however many race). */
  readonly subjectOf: SenderSubjectOf = async (sender) => {
    const identity = SenderHandles.identity(sender);
    if (identity === undefined) return undefined;
    const master = await this.loadMaster(true);
    const id = SenderHandles.idOf(master as Buffer, identity);
    const handle = SenderHandles.handleOf(
      await this.single(`seed:${id}`, () => this.currentSeed(id))
    );
    // The crash window between erase's two destroys leaves a live seed over a destroyed handle: the send
    // is the erased sender's, not a raw key-store failure.
    try {
      await this.keys.getOrCreate(handle);
    } catch (cause) {
      throw new SenderErasedError(cause);
    }
    return handle;
  };

  /**
   * Erase a sender: destroy the key their identity is sealed under, then the seed the handle derives
   * from, and VERIFY that nothing live remains for them (fail loud otherwise). Idempotent (a retry after
   * a crash between the two finishes it); `false` when the sender never sent a sealed message (or was
   * already erased). Throws {@link SenderMasterLostError} when the master is gone while sealed senders
   * exist (it cannot tell whether the sender sent, so it never answers `false`). Identifies the sender as
   * `subjectOf` does: `[tenant, actor]`.
   */
  async erase(sender: SenderIdentity): Promise<boolean> {
    const identity = SenderHandles.identity(sender);
    if (identity === undefined) return false;
    const master = await this.loadMaster(false);
    if (master === null) return false; // no master, no marker: nothing was ever sealed
    const id = SenderHandles.idOf(master, identity);
    for (let epoch = 0; ; epoch++) {
      const seedSubject = SenderHandles.seedSubject(id, epoch);
      let seed = await this.keys.get(seedSubject);
      if (seed === null) {
        if ((await this.keys.get(SenderHandles.epochSubject(id, epoch + 1))) !== null) continue;
        return false;
      }
      // A concurrent mint on a store without atomic create-if-absent can leave a second seed behind:
      // destroy until none is live (bounded), then verify that no seed and no handle of theirs is live.
      const handles = new Set<string>();
      for (let round = 0; seed !== null && round < 4; round++) {
        const handle = SenderHandles.handleOf(seed);
        handles.add(handle);
        await this.keys.destroy(handle); // first: a crash leaves the seed to retry from
        await this.keys.destroy(seedSubject);
        seed = await this.keys.get(seedSubject);
      }
      let live = seed === null ? 0 : 1;
      for (const handle of handles) if ((await this.keys.get(handle)) !== null) live++;
      if (live > 0) throw new SenderEraseIncompleteError(live);
      return true;
    }
  }

  /**
   * ADR 0139 D22 - REINSTATE an erased sender (an explicit operator act, never implicit): authorize a fresh
   * epoch, whose seed - and so handle - their NEXT message mints. The old handle stays destroyed; the old
   * messages stay erased and unlinkable to the new handle. `{ reinstated: false }` when the sender is not
   * erased (live seed, or never sent) or was already reinstated; idempotent.
   */
  async reinstate(sender: SenderIdentity): Promise<SenderReinstatement> {
    const identity = SenderHandles.identity(sender);
    if (identity === undefined) return { reinstated: false };
    const master = await this.loadMaster(false);
    if (master === null) return { reinstated: false };
    const id = SenderHandles.idOf(master, identity);
    for (let epoch = 0; ; epoch++) {
      const seedSubject = SenderHandles.seedSubject(id, epoch);
      if ((await this.keys.get(seedSubject)) !== null) return { reinstated: false, ref: id };
      if ((await this.keys.get(SenderHandles.epochSubject(id, epoch + 1))) !== null) continue;
      if ((await this.keys.wasDestroyed?.(seedSubject)) === false)
        return { reinstated: false, ref: id };
      await this.keys.getOrCreate(SenderHandles.epochSubject(id, epoch + 1));
      return { reinstated: true, ref: id, epoch: epoch + 1 };
    }
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
