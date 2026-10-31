import type { EventEnvelope } from "@loom/core";
import {
  type ArchiveSegment,
  type ArchiveSegmentHeader,
  type ArchiveStore,
  KeyUnavailableError,
} from "@loom/event-runtime";
import { decryptValue, encryptValue, hasEnvelope } from "./crypto";
import { PayloadShreddedError, PayloadUndecryptableError } from "./errors";
import type { KeyStore } from "./keystore";

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
  private readonly subjectOf: (s: { executionId: string; workflowId: string }) => string;

  constructor(
    private readonly inner: ArchiveStore,
    /** PUBLIC so the kernel guard can compare it with the event store's KeyStore by identity. */
    readonly keys: KeyStore,
    options: EncryptingArchiveStoreOptions = {}
  ) {
    this.subjectOf = options.subjectOf ?? ((s) => s.executionId);
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
    const subject = this.subjectOf({ executionId, workflowId });
    if (subject === "") {
      throw new TypeError(
        `EncryptingArchiveStore: the subject for "${executionId}" resolved to "" and the crypto layer refuses to seal under it. Fix \`subjectOf\`.`
      );
    }
    const key = await this.keys.getOrCreate(subject);
    const body: SealedBody = {
      v: ARCHIVE_AAD_V,
      workflowId,
      box: encryptValue(key, segment.envelopes, {
        v: ARCHIVE_AAD_V,
        bind: bindOf(executionId, segment.from, segment.through),
      }),
    };
    await this.inner.append(executionId, {
      from: segment.from,
      through: segment.through,
      count: segment.count,
      digest: segment.digest,
      envelopes: [],
      sealed: body,
    });
  }

  headers(executionId: string): Promise<ArchiveSegmentHeader[]> {
    return this.inner.headers(executionId);
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
        this.subjectOf({ executionId, workflowId: "" }),
        executionId,
        new Error("archive segment is not sealed")
      );
    }
    const subject = this.subjectOf({ executionId, workflowId: body.workflowId });
    const key = await this.keys.get(subject);
    if (key === null) {
      // Proof of destruction when the key store can give it; otherwise this node merely lacks the key.
      if ((await this.keys.wasDestroyed?.(subject)) === true) {
        throw new PayloadShreddedError(subject, executionId);
      }
      throw new KeyUnavailableError(subject, executionId, body.workflowId);
    }
    try {
      const envelopes = decryptValue(
        key,
        body.box,
        bindOf(executionId, seg.from, seg.through)
      ) as EventEnvelope[];
      return {
        from: seg.from,
        through: seg.through,
        count: seg.count,
        digest: seg.digest,
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
