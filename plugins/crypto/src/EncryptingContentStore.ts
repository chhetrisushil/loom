import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";
import type { EventEnvelope } from "@loom/core";
import { KeyUnavailableError } from "@loom/event-runtime";
import type { ContentAccess, ContentRef, ContentStore } from "@loom/plugin-content";
import {
  ContentAccessRequiredError,
  ContentUndecryptableError,
  PayloadShreddedError,
} from "./errors";
import type { KeyStore } from "./keystore";
import { defaultSubjectOf } from "./subject";

// ── ADR 0143 - a ContentStore that seals every blob under its owner's subject key ────────────────────────
//
// Wraps any ContentStore. A blob is sealed with AES-256-GCM under a key DERIVED from the subject's key
// (the same KeyStore the event log uses), so destroying the subject's key makes every blob it ever put
// unreadable: erasure is satisfied by the shred, exactly as for the log.
//
// The ADDRESS is the inner store's own content address of the stored bytes (`sha256:<hex of the
// ciphertext>`), and the ciphertext is DETERMINISTIC per (subject, plaintext): the GCM nonce is a keyed hash
// of the plaintext (a synthetic IV, so a nonce repeats only for an identical plaintext under one key, which
// leaks nothing new). Consequences:
//  - within one subject, identical plaintext -> identical bytes -> ONE blob (dedupe, and the claim-check's
//    crash re-run reproduces the same envelope);
//  - across subjects, identical plaintext -> unrelated bytes -> DIFFERENT addresses: an address reveals no
//    cross-subject equality, and one subject's erasure cannot be defeated (or blocked) by another's blob;
//  - the inner store, its sweep, `listPage`, touch times and conditional delete work unchanged on the
//    addresses, and need no key.

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;
const AAD_PREFIX = "loom/content/v1|";

export interface EncryptingContentStoreOptions {
  /**
   * The erasure subject of a blob's owner; default the executionId. MUST be the mapping the event store
   * runs (`defineConfig` refuses a different function when both are visible).
   */
  subjectOf?: (owner: Pick<EventEnvelope, "executionId" | "workflowId">) => string;
}

function derive(subjectKey: Buffer, label: string): Buffer {
  return createHmac("sha256", subjectKey).update(`loom/content/${label}/v1`).digest();
}

/** Seal `plaintext` for `subject`: `[version][iv][tag][ciphertext]`, deterministic per (key, plaintext). */
function seal(subjectKey: Buffer, subject: string, plaintext: Uint8Array): Uint8Array {
  const iv = createHmac("sha256", derive(subjectKey, "iv"))
    .update(plaintext)
    .digest()
    .subarray(0, IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", derive(subjectKey, "enc"), iv);
  cipher.setAAD(Buffer.from(AAD_PREFIX + subject, "utf-8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

function open(subjectKey: Buffer, subject: string, stored: Uint8Array): Uint8Array {
  if (stored.byteLength < HEADER_BYTES || stored[0] !== VERSION) {
    throw new Error("not a sealed content blob");
  }
  const buf = Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    derive(subjectKey, "enc"),
    buf.subarray(1, 1 + IV_BYTES)
  );
  decipher.setAAD(Buffer.from(AAD_PREFIX + subject, "utf-8"));
  decipher.setAuthTag(buf.subarray(1 + IV_BYTES, HEADER_BYTES));
  return new Uint8Array(
    Buffer.concat([decipher.update(buf.subarray(HEADER_BYTES)), decipher.final()])
  );
}

export class EncryptingContentStore implements ContentStore {
  /** The marker `defineConfig` (claim-check under `security.crypto`) and `eraseSubject` read. */
  readonly sealsContent = true as const;
  /** PUBLIC so `defineConfig` can compare it, by identity, with the event store's. */
  readonly subjectOf: (owner: Pick<EventEnvelope, "executionId" | "workflowId">) => string;
  readonly deleteIfUntouchedSince?: NonNullable<ContentStore["deleteIfUntouchedSince"]>;
  readonly listPage?: NonNullable<ContentStore["listPage"]>;
  readonly touchClock?: NonNullable<ContentStore["touchClock"]>;
  readonly touch?: NonNullable<ContentStore["touch"]>;

  /**
   * `putStream` is deliberately NOT offered: the deterministic nonce needs the whole plaintext before the
   * first byte is sealed, so a stream would have to be buffered, which is what a stream result exists to
   * avoid. The claim-check middleware reports the missing method by name (fail closed).
   */
  constructor(
    private readonly inner: ContentStore,
    /** PUBLIC like `EncryptingEventStore.keys`: the SAME KeyStore must back the log and the blobs. */
    readonly keys: KeyStore,
    options: EncryptingContentStoreOptions = {}
  ) {
    this.subjectOf = options.subjectOf ?? defaultSubjectOf;
    // The inner store's own conditional delete / enumeration / touch work on its addresses: forwarded iff
    // present, so the sweep keeps its race-safety through this layer.
    if (inner.deleteIfUntouchedSince !== undefined) {
      this.deleteIfUntouchedSince = (ref, cutoff) => inner.deleteIfUntouchedSince!(ref, cutoff);
    }
    if (inner.listPage !== undefined) this.listPage = (opts) => inner.listPage!(opts);
    if (inner.touchClock !== undefined) this.touchClock = () => inner.touchClock!();
    if (inner.touch !== undefined) this.touch = (addresses) => inner.touch!(addresses);
  }

  private subjectFor(access: ContentAccess | undefined, operation: string): string {
    if (access === undefined) throw new ContentAccessRequiredError(operation);
    const subject = this.subjectOf(access);
    if (subject === "") {
      throw new Error(
        `EncryptingContentStore.${operation}: the subject for "${access.executionId}" resolved to "" and the crypto layer refuses to seal under it. Fix \`subjectOf\`.`
      );
    }
    return subject;
  }

  /** The subject's key to READ with: absent = erased (a recorded destruction) or merely not on this node. */
  private async readKey(subject: string, access: ContentAccess): Promise<Buffer> {
    const key = await this.keys.get(subject);
    if (key !== null) return key;
    if ((await this.keys.wasDestroyed?.(subject)) === true) {
      throw new PayloadShreddedError(subject, access.executionId);
    }
    throw new KeyUnavailableError(subject, access.executionId, access.workflowId);
  }

  async put(bytes: Uint8Array, access?: ContentAccess): Promise<ContentRef> {
    const subject = this.subjectFor(access, "put");
    let key: Buffer;
    try {
      key = await this.keys.getOrCreate(subject);
    } catch (err) {
      // A destroyed subject's key is never re-minted: a put for it is refused as the erasure it is.
      if ((await this.keys.wasDestroyed?.(subject)) === true) {
        throw new PayloadShreddedError(subject, (access as ContentAccess).executionId);
      }
      throw err;
    }
    const ref = await this.inner.put(seal(key, subject, bytes));
    return { __loomContent: ref.__loomContent, size: bytes.byteLength };
  }

  private openStored(
    key: Buffer,
    subject: string,
    ref: ContentRef,
    stored: Uint8Array
  ): Uint8Array {
    try {
      // The address names the ciphertext: a blob swapped under an address (or an inner store returning
      // another blob's bytes) is caught before decryption, and GCM + the subject AAD catches the rest.
      const address = ref.__loomContent;
      if (address.startsWith("sha256:")) {
        const actual = `sha256:${createHash("sha256").update(stored).digest("hex")}`;
        if (actual !== address) throw new Error("stored bytes do not match their address");
      }
      return open(key, subject, stored);
    } catch (err) {
      throw new ContentUndecryptableError(subject, ref.__loomContent, err);
    }
  }

  async get(ref: ContentRef, access?: ContentAccess): Promise<Uint8Array | null> {
    const subject = this.subjectFor(access, "get");
    // Absence is null (the SPI never throws on it) and needs no key; a PRESENT blob needs the subject's.
    const stored = await this.inner.get(ref);
    if (stored === null) return null;
    const key = await this.readKey(subject, access as ContentAccess);
    return this.openStored(key, subject, ref, stored);
  }

  async getMany(
    refs: readonly ContentRef[],
    access?: ContentAccess
  ): Promise<(Uint8Array | null)[]> {
    const subject = this.subjectFor(access, "getMany");
    const stored =
      this.inner.getMany !== undefined
        ? await this.inner.getMany(refs)
        : await Promise.all(refs.map((r) => this.inner.get(r)));
    if (stored.every((bytes) => bytes === null || bytes === undefined))
      return stored.map(() => null);
    const key = await this.readKey(subject, access as ContentAccess);
    return stored.map((bytes, i) =>
      bytes === null || bytes === undefined
        ? null
        : this.openStored(key, subject, refs[i] as ContentRef, bytes)
    );
  }

  /** Physically erase the sealed bytes (by address; needs no key). Idempotent. */
  delete(ref: ContentRef): Promise<void> {
    return this.inner.delete(ref);
  }
}
