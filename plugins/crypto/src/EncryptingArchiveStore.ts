import type { EventEnvelope } from "@loom/core";
import {
  type ArchiveExecutionPage,
  type ArchiveSegment,
  type ArchiveSegmentHeader,
  type ArchiveStore,
  KeyUnavailableError,
  archiveChainOf,
  forwardStoreMarkers,
} from "@loom/event-runtime";
import { decryptValue, encryptValue, hasEnvelope } from "./crypto";
import { OwnerUnresolvedError, PayloadShreddedError, PayloadUndecryptableError } from "./errors";
import type { KeyStore } from "./keystore";
import {
  type SenderSubjectOf,
  isSealedSender,
  openSender,
  plaintextSenderOf,
  sealSender,
} from "./senderSeal";
import { defaultSubjectOf } from "./subject";

// ── ADR 0138 — sealing the compaction archive ───────────────────────────────────────────────────
//
// A compaction MOVES events out of the (sealing) event store into the archive. The archive therefore
// has to sit inside the same erasure boundary the log did: each segment's envelopes are sealed as ONE
// envelope under the subject key (default: the executionId, exactly what EncryptingEventStore uses),
// so destroying the key makes the archived copy unreadable together with everything else.
//
// In the clear: the segment's `from`/`through`/`count`/`digest` (index fields, no payload) and the
// workflow id the subject resolves from. The digest is SHA-256 of the canonical plaintext, so it
// stays verifiable after a read decrypts, and reveals nothing guessable about a high-entropy event
// run (ids, timestamps).

const ARCHIVE_AAD_V = "loom-archive-v1";

interface SealedBody {
  /** Marker: this segment was written by an EncryptingArchiveStore. */
  v: typeof ARCHIVE_AAD_V;
  workflowId: string;
  /** The AES-GCM envelope of the segment's envelopes, bound to `executionId|from|through`. */
  box: unknown;
}

const bindOf = (executionId: string, from: number, through: number): string =>
  `${executionId}|${from}|${through}`;

export interface EncryptingArchiveStoreOptions {
  /** The erasure subject; default the executionId (matches `EncryptingEventStore`). */
  subjectOf?: (s: { executionId: string; workflowId: string }) => string;
  /**
   * ADR 0139: a chain's RESERVED streams (`__loom_inbox__:<chain>...`, `__loom_quarantine__:<chain>`) are
   * sealed under the CHAIN OWNER's subject, exactly as `EncryptingEventStore` does, so a shred of the
   * owner takes the archived envelopes with it. The default `subjectOf` ignores the workflow id and needs
   * nothing here; a custom `subjectOf` that reads `workflowId` needs the owner's (its first event's) to
   * resolve the chain's subject, and a reserved-stream segment fails to seal or open without it.
   */
  ownerWorkflowId?: (chainId: string) => Promise<string | undefined>;
  /**
   * ADR 0139 D12: the erasure subject of a message's SENDER (share the event store's). An archived inbox
   * envelope's `payload.sender` is sealed under the SENDER's key inside the segment (which is itself
   * sealed under the chain owner's), so erasing the sender shreds their identity in the archive too;
   * a read whose sender key is gone yields `{ erased: true }` for it and the segment still opens.
   */
  senderSubjectOf?: SenderSubjectOf;
}

/**
 * Wraps any {@link ArchiveStore} so every segment is sealed under the SAME {@link KeyStore} as the
 * event store (ADR 0138). `LogLifecycle.compact` REQUIRES this over an encrypting event store
 * (`PlaintextArchiveError` otherwise): a plaintext archive would hold the decrypted log outside the
 * erasure boundary. The structural markers `keys` and `sealsSegments` are what the kernel and
 * `loom doctor` read.
 */
export class EncryptingArchiveStore implements ArchiveStore {
  /** Structural marker read by the kernel guard: segments are sealed (not just static paths). */
  readonly sealsSegments = true as const;
  readonly deleteExecution?: NonNullable<ArchiveStore["deleteExecution"]>;
  /**
   * PUBLIC so the kernel guard can compare it, by identity, with the event store's `subjectOf`: an
   * archive sealed under a different subject than the log would survive a shred of the log's subject.
   */
  readonly subjectOf: (s: { executionId: string; workflowId: string }) => string;

  private readonly ownerWorkflowId: ((chainId: string) => Promise<string | undefined>) | undefined;
  private readonly senderSubjectOf: SenderSubjectOf | undefined;

  /**
   * The erasure subject of a stream: the stream's own for an execution, the CHAIN OWNER's for a
   * reserved inbox or quarantine stream (ADR 0139). `workflowId` is the segment's first envelope's.
   */
  private async subjectFor(executionId: string, workflowId: string): Promise<string> {
    const chain = archiveChainOf(executionId);
    if (chain === undefined) return this.subjectOf({ executionId, workflowId });
    let owner: string | Error | undefined;
    if (this.ownerWorkflowId !== undefined) {
      try {
        owner = await this.ownerWorkflowId(chain);
      } catch (cause) {
        owner = new OwnerUnresolvedError(chain, "reading the owner's first event failed", cause);
      }
    }
    return this.subjectOf({
      executionId: chain,
      get workflowId(): string {
        if (typeof owner === "string" && owner.length > 0) return owner;
        if (owner instanceof Error) throw owner;
        throw new OwnerUnresolvedError(
          chain,
          "the archive has no ownerWorkflowId to resolve the chain owner's workflow"
        );
      },
    });
  }

  constructor(
    private readonly inner: ArchiveStore,
    /** PUBLIC so the kernel guard can compare it with the event store's KeyStore by identity. */
    readonly keys: KeyStore,
    options: EncryptingArchiveStoreOptions = {}
  ) {
    this.subjectOf = options.subjectOf ?? defaultSubjectOf;
    this.ownerWorkflowId = options.ownerWorkflowId;
    this.senderSubjectOf = options.senderSubjectOf;
    forwardStoreMarkers(this, inner); // the tenant marker (ADR 0138 H3) must survive sealing
    const innerDelete = inner.deleteExecution;
    // Deleting ciphertext only reduces data: forward it (the retention path's whole-execution delete).
    if (innerDelete !== undefined) this.deleteExecution = (id) => innerDelete.call(inner, id);
  }

  async append(executionId: string, segment: ArchiveSegment): Promise<void> {
    if (segment.sealed !== undefined || segment.envelopes.length === 0) {
      throw new TypeError(
        `EncryptingArchiveStore: segment [${segment.from}..${segment.through}] of "${executionId}" has no envelopes to seal`
      );
    }
    const workflowId = segment.envelopes[0]!.workflowId;
    const subject = await this.subjectFor(executionId, workflowId);
    if (subject === "") {
      throw new TypeError(
        `EncryptingArchiveStore: the subject for "${executionId}" resolved to "" and the crypto layer refuses to seal under it. Fix \`subjectOf\`.`
      );
    }
    const key = await this.keys.getOrCreate(subject);
    const envelopes = await this.sealSenders(executionId, segment.envelopes);
    const body: SealedBody = {
      v: ARCHIVE_AAD_V,
      workflowId,
      box: encryptValue(key, envelopes, {
        v: ARCHIVE_AAD_V,
        bind: bindOf(executionId, segment.from, segment.through),
      }),
    };
    await this.inner.append(executionId, {
      from: segment.from,
      through: segment.through,
      count: segment.count,
      digest: segment.digest,
      incarnation: segment.incarnation,
      ...(segment.kind !== undefined && { kind: segment.kind }),
      envelopes: [],
      sealed: body,
    });
  }

  /** ADR 0139 D12: seal each archived inbox envelope's sender under the SENDER's subject (reserved streams only). */
  private async sealSenders(
    executionId: string,
    envelopes: readonly EventEnvelope[]
  ): Promise<EventEnvelope[]> {
    if (this.senderSubjectOf === undefined || archiveChainOf(executionId) === undefined) {
      return [...envelopes];
    }
    return Promise.all(
      envelopes.map(async (e) => {
        if (e.eventType !== "INBOX_MESSAGE") return e;
        const sender = plaintextSenderOf(e.payload);
        const subject = sender === undefined ? undefined : this.senderSubjectOf?.(sender);
        if (sender === undefined || subject === undefined) return e;
        if (subject === "") {
          throw new TypeError(
            'EncryptingArchiveStore: senderSubjectOf resolved to "" and the crypto layer refuses to seal under it.'
          );
        }
        const sealed = sealSender(await this.keys.getOrCreate(subject), subject, sender);
        return { ...e, payload: { ...(e.payload as object), sender: sealed } };
      })
    );
  }

  /** The reverse: open each sealed sender (identity, or the erased marker once its key is gone). */
  private async openSenders(envelopes: EventEnvelope[]): Promise<EventEnvelope[]> {
    if (
      !envelopes.some((e) => isSealedSender((e.payload as { sender?: unknown } | null)?.sender))
    ) {
      return envelopes;
    }
    return Promise.all(
      envelopes.map(async (e) => {
        const sender = (e.payload as { sender?: unknown } | null)?.sender;
        if (!isSealedSender(sender)) return e;
        return {
          ...e,
          payload: { ...(e.payload as object), sender: await openSender(this.keys, sender) },
        };
      })
    );
  }

  headers(executionId: string): Promise<ArchiveSegmentHeader[]> {
    return this.inner.headers(executionId);
  }

  listExecutions(opts?: { cursor?: string; limit?: number }): Promise<ArchiveExecutionPage> {
    return this.inner.listExecutions(opts);
  }

  async read(
    executionId: string,
    range?: { readonly from?: number; readonly through?: number }
  ): Promise<ArchiveSegment[]> {
    const stored = await this.inner.read(executionId, range);
    const out: ArchiveSegment[] = [];
    for (const seg of stored) out.push(await this.open(executionId, seg));
    return out;
  }

  private async open(executionId: string, seg: ArchiveSegment): Promise<ArchiveSegment> {
    const body = seg.sealed as SealedBody | undefined;
    if (body === undefined || body.v !== ARCHIVE_AAD_V || !hasEnvelope(body.box)) {
      // A plaintext segment beside a sealing store: never returned as if sealed (a swapped-in row).
      throw new PayloadUndecryptableError(
        await this.subjectFor(executionId, "").catch(() => executionId),
        executionId,
        new Error("archive segment is not sealed")
      );
    }
    const subject = await this.subjectFor(executionId, body.workflowId);
    const key = await this.keys.get(subject);
    if (key === null) {
      // Proof of destruction when the key store can give it; otherwise this node merely lacks the key.
      if ((await this.keys.wasDestroyed?.(subject)) === true) {
        throw new PayloadShreddedError(subject, executionId);
      }
      throw new KeyUnavailableError(subject, executionId, body.workflowId);
    }
    try {
      const envelopes = await this.openSenders(
        decryptValue(key, body.box, bindOf(executionId, seg.from, seg.through)) as EventEnvelope[]
      );
      return {
        from: seg.from,
        through: seg.through,
        count: seg.count,
        digest: seg.digest,
        incarnation: seg.incarnation,
        ...(seg.kind !== undefined && { kind: seg.kind }),
        envelopes,
      };
    } catch (err) {
      throw new PayloadUndecryptableError(subject, executionId, err);
    }
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
