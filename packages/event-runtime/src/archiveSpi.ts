import type { EventEnvelope } from "@loom/core";

// ── ADR 0138 — the compaction archive SPI ────────────────────────────────────────────────────────
//
// `LogLifecycle.compact` removes the prefix of a log below its checkpoint. Under ADR 0138 it MOVES
// that prefix: the removed envelopes are appended here first, then truncated. Nothing in loom
// deletes a fact the log held, so an auditor can recover `archive ∪ surviving log == original log`.
//
// The archive is deliberately NOT an EventStore and NOT the content store: `readRange` of the log
// never sees it (replay and resume cannot read it), no sweep enumerates it, and per-subject erasure
// is a property of ONE store (a sealing wrapper over the same KeyStore as the event store).

/**
 * SPI version of {@link ArchiveStore} (ADR 0138). Pinned by `runArchiveStoreConformance`.
 *
 * 1.0.0: `append` / `headers` / `read` / `listExecutions` (paged) / optional `deleteExecution` /
 * `close`; every segment header carries the log `incarnation` it belongs to and an optional `kind`.
 *
 * 1.1.0 (ADR 0139 N1/N7, additive): the optional `replaceSegments(key, expected, next)`, an ATOMIC
 * compare-and-swap of a key's whole segment list (a concurrent `append` makes it fail with
 * {@link ArchiveConflictError}; nothing is written), and the optional header field `senderDigest`
 * (a digest of the senders of a PLAINTEXT reserved-stream segment, which the digest itself masks). A
 * 1.0.0 store conforms; the erasure that needs `replaceSegments` refuses an archive without it.
 */
export const ARCHIVE_STORE_SPI_VERSION = "1.1.0";

/**
 * What a segment holds. Absent / `"events"`: the exact envelopes a compaction removed. `"legacy-checkpoint"`:
 * ONE synthetic envelope carrying a checkpoint (snapshot) written before the archive existed, byte-exact:
 * its folded state is the only copy of the settled steps' inputs the pre-0138 compactions removed.
 */
export type ArchiveSegmentKind = "events" | "legacy-checkpoint";

/** The `eventType` of the synthetic envelope inside a `"legacy-checkpoint"` segment. */
export const ARCHIVE_LEGACY_CHECKPOINT_EVENT = "ARCHIVE_LEGACY_CHECKPOINT";

/** What a segment says about itself without its envelopes. */
export interface ArchiveSegmentHeader {
  /** The lowest sequence this segment covers (inclusive). */
  readonly from: number;
  /** The highest sequence it covers (inclusive): the compaction checkpoint's sequence. */
  readonly through: number;
  /** How many envelopes it holds (sequences inside `[from, through]` a compaction kept are absent). */
  readonly count: number;
  /** {@link segmentDigest} of the envelopes, in order. Stored and returned verbatim. */
  readonly digest: string;
  /**
   * The incarnation of the log this segment came from: the {@link segmentDigest} of its bootstrap
   * event (sequence 0, which survives every compaction; the id alone is `<executionId>-0` and says
   * nothing). A segment of another incarnation under the same execution id (an id REUSED after a
   * delete) is refused with {@link ArchiveIncarnationError}, never inherited. Two runs whose
   * bootstrap envelopes are byte-identical (same input, same millisecond) are not told apart here;
   * their later events then disagree, which the compaction and the audit read catch byte-for-byte.
   */
  readonly incarnation: string;
  /** Absent means `"events"`. Stored and returned verbatim. */
  readonly kind?: ArchiveSegmentKind;
  /**
   * SPI 1.1.0 (ADR 0139 N7), PLAINTEXT reserved-stream segments only: the sender digest of the
   * envelopes' senders. The segment `digest` masks `payload.sender` (an erasure may redact it), so
   * without this the sender field would have no bit-rot detection; a redaction recomputes it in the same
   * atomic {@link ArchiveStore.replaceSegments}. Stored and returned verbatim; absent on every other segment
   * (a sealing archive authenticates the sender with AEAD instead and never stores it).
   */
  readonly senderDigest?: string;
}

/** One contiguous range of removed envelopes. */
export interface ArchiveSegment extends ArchiveSegmentHeader {
  /** The exact envelopes the log held, ascending by sequence. */
  readonly envelopes: readonly EventEnvelope[];
  /**
   * Opaque sealed form. A sealing decorator (`EncryptingArchiveStore`) stores its ciphertext here
   * and an EMPTY `envelopes`; a plain backend persists it verbatim and never looks inside.
   */
  readonly sealed?: unknown;
}

/**
 * Where compaction puts the events it removes (ADR 0138). Append-only: there is no per-segment
 * delete, only {@link ArchiveStore.deleteExecution} for the existing whole-execution retention path.
 *
 * Contract (pinned by the conformance kit):
 *  - `append` is IDEMPOTENT for an identical segment (same `from`, `through`, `digest`): a crash
 *    between "archive" and "truncate" is retried by re-compaction, and the retry must not fail.
 *  - Any other segment must start strictly after the last one's `through`; an overlap or a rewind
 *    rejects with {@link ArchiveConflictError} and writes NOTHING.
 *  - `headers` and `read` return segments in ascending `from`. `read` returns every segment that
 *    overlaps the range, WHOLE (the caller trims), exactly what was appended.
 *  - An unknown execution reads as `[]`.
 */
export interface ArchiveStore {
  append(executionId: string, segment: ArchiveSegment): Promise<void>;
  /** The segment headers, ascending. Cheap: no envelopes are read. */
  headers(executionId: string): Promise<ArchiveSegmentHeader[]>;
  /**
   * One page of the execution ids that hold at least one segment, ascending in code point order,
   * keyset-paged like `EventStore.listExecutionsPage`: pass the previous page's `nextCursor`
   * (exclusive); no `nextCursor` means the end. Lets a sweep enumerate what the archive cites.
   */
  listExecutions(opts?: { cursor?: string; limit?: number }): Promise<ArchiveExecutionPage>;
  read(
    executionId: string,
    range?: { readonly from?: number; readonly through?: number }
  ): Promise<ArchiveSegment[]>;
  /** OPTIONAL. The whole-execution delete of the retention path (`LogLifecycle.applyRetention`). */
  deleteExecution?(executionId: string): Promise<void>;
  /**
   * OPTIONAL (SPI 1.1.0, ADR 0139 N1). Atomically replace ALL of `executionId`'s segments with `next`, IF
   * its current headers are exactly `expected` (ascending, as {@link ArchiveStore.headers} returned
   * them, `senderDigest` included): one compare-and-swap, so a concurrent writer (a trim on another node
   * appending a segment after the caller read) makes it reject with {@link ArchiveConflictError} and
   * write NOTHING, and the caller re-reads and retries. Used by erasure to redact a sender in place; the
   * `next` segments must be ascending and non-overlapping, and of the incarnation `expected` holds.
   */
  replaceSegments?(
    executionId: string,
    expected: readonly ArchiveSegmentHeader[],
    next: readonly ArchiveSegment[]
  ): Promise<void>;
  close(): Promise<void>;
}

/** One page of {@link ArchiveStore.listExecutions}. */
export interface ArchiveExecutionPage {
  readonly executionIds: string[];
  readonly nextCursor?: string;
}

/** The names of the OPTIONAL {@link ArchiveStore} methods, for the decorator plan. */
export const OPTIONAL_ARCHIVE_STORE_METHODS = ["deleteExecution", "replaceSegments"] as const;

/** A segment that overlaps or rewinds past what the archive already holds (nothing was written). */
export class ArchiveConflictError extends Error {
  readonly retryable = false;
  constructor(
    readonly executionId: string,
    readonly attempted: ArchiveSegmentHeader,
    readonly lastThrough: number,
    /** Set by {@link ArchiveStore.replaceSegments}: why the compare-and-swap failed. */
    readonly replaceReason?: string
  ) {
    super(
      replaceReason !== undefined
        ? `archive "${executionId}": replaceSegments refused - ${replaceReason}. Nothing was written; re-read the headers and retry.`
        : `archive "${executionId}": segment [${attempted.from}..${attempted.through}] does not start after the archive's last sequence ${lastThrough}, and is not an exact repeat of an archived segment. Segments are append-only and contiguous; nothing was written.`
    );
    this.name = "ArchiveConflictError";
    Object.setPrototypeOf(this, ArchiveConflictError.prototype);
  }
}

/**
 * The archive holds segments of another incarnation of this execution id (the id was deleted and
 * REUSED): appending to or reading them as this run's history would mix two runs. Nothing was
 * written. Never retryable.
 */
export class ArchiveIncarnationError extends Error {
  readonly retryable = false;
  constructor(
    readonly executionId: string,
    readonly archived: string,
    readonly current: string
  ) {
    super(
      `archive "${executionId}": the archive holds segments of a DIFFERENT run (incarnation ${archived}) than the log's (${current}) — the execution id was reused after its earlier run was deleted. The old run's archive was not removed with it, so it is not this run's history and is neither read as such nor extended. Remove the previous run's segments with the retention path (ArchiveStore.deleteExecution), or use a fresh execution id.`
    );
    this.name = "ArchiveIncarnationError";
    Object.setPrototypeOf(this, ArchiveIncarnationError.prototype);
  }
}

/** A segment's envelopes cannot be serialized to JSON (circular, BigInt, too deep): it cannot be archived or verified. */
export class ArchiveUnserializableError extends Error {
  readonly retryable = false;
  constructor(cause: unknown) {
    super(
      `archive: the envelopes cannot be serialized to JSON (${cause instanceof Error ? cause.message : String(cause)}) — an archived event must be plain JSON data, byte-exact.`,
      { cause }
    );
    this.name = "ArchiveUnserializableError";
    Object.setPrototypeOf(this, ArchiveUnserializableError.prototype);
  }
}

/** The envelopes of a segment do not hash to the digest it recorded: the archive was altered. */
export class ArchiveDigestError extends Error {
  readonly retryable = false;
  constructor(
    readonly executionId: string,
    readonly from: number,
    readonly through: number,
    readonly expected: string,
    readonly actual: string
  ) {
    super(
      `archive "${executionId}": segment [${from}..${through}] does not match its recorded digest (expected ${expected}, computed ${actual}) — the archived events were altered or corrupted.`
    );
    this.name = "ArchiveDigestError";
    Object.setPrototypeOf(this, ArchiveDigestError.prototype);
  }
}

export const headerOf = (s: ArchiveSegmentHeader): ArchiveSegmentHeader => ({
  from: s.from,
  through: s.through,
  count: s.count,
  digest: s.digest,
  incarnation: s.incarnation,
  ...(s.kind !== undefined && { kind: s.kind }),
  ...(s.senderDigest !== undefined && { senderDigest: s.senderDigest }),
});

const sameHeader = (a: ArchiveSegmentHeader, b: ArchiveSegmentHeader): boolean =>
  a.from === b.from &&
  a.through === b.through &&
  a.count === b.count &&
  a.digest === b.digest &&
  a.incarnation === b.incarnation &&
  (a.kind ?? "events") === (b.kind ?? "events") &&
  (a.senderDigest ?? null) === (b.senderDigest ?? null);

/**
 * The shared `replaceSegments` rule for a backend, given the headers stored now: throws
 * {@link ArchiveConflictError} unless they are exactly `expected`, and a `RangeError` for a `next` list
 * that is not ascending, non-overlapping and well-formed. Nothing is written by this check.
 */
export function assertReplaceable(
  executionId: string,
  stored: readonly ArchiveSegmentHeader[],
  expected: readonly ArchiveSegmentHeader[],
  next: readonly ArchiveSegmentHeader[]
): void {
  const attempted =
    next[0] ?? expected[0] ?? stored[0] ?? ({ from: 0, through: 0 } as ArchiveSegmentHeader);
  const last = stored[stored.length - 1]?.through ?? -1;
  if (stored.length !== expected.length) {
    throw new ArchiveConflictError(
      executionId,
      attempted,
      last,
      `the key now holds ${stored.length} segment(s), the caller read ${expected.length}`
    );
  }
  for (let i = 0; i < stored.length; i++) {
    if (!sameHeader(stored[i]!, expected[i]!)) {
      throw new ArchiveConflictError(
        executionId,
        attempted,
        last,
        `segment ${i} [${stored[i]!.from}..${stored[i]!.through}] changed since the caller read it`
      );
    }
  }
  let prev = Number.NEGATIVE_INFINITY;
  for (const h of next) {
    if (!Number.isSafeInteger(h.from) || !Number.isSafeInteger(h.through) || h.from > h.through) {
      throw new RangeError(`archive segment [${h.from}..${h.through}] is malformed`);
    }
    if (h.from <= prev) {
      throw new RangeError(
        `replaceSegments: segments must be ascending and non-overlapping ([${h.from}..${h.through}] follows ${prev})`
      );
    }
    prev = h.through;
  }
  const incarnation = expected[0]?.incarnation;
  if (incarnation !== undefined) {
    for (const h of next) {
      if (h.incarnation !== incarnation) {
        throw new ArchiveIncarnationError(executionId, incarnation, h.incarnation);
      }
    }
  }
}

/**
 * The shared `append` rule for a backend, given the headers already stored (ascending): `"noop"`
 * for an exact repeat of a stored segment, `"append"` when the segment starts after the last one,
 * else throws {@link ArchiveConflictError}.
 */
export function classifyAppend(
  executionId: string,
  stored: readonly ArchiveSegmentHeader[],
  segment: ArchiveSegmentHeader
): "append" | "noop" {
  if (!Number.isSafeInteger(segment.from) || !Number.isSafeInteger(segment.through)) {
    throw new RangeError("archive segment bounds must be safe integers");
  }
  if (segment.from > segment.through) {
    throw new RangeError(`archive segment [${segment.from}..${segment.through}] is inverted`);
  }
  for (const h of stored) {
    if (h.incarnation !== segment.incarnation) {
      throw new ArchiveIncarnationError(executionId, h.incarnation, segment.incarnation);
    }
  }
  for (const h of stored) {
    if (h.from === segment.from && h.through === segment.through && h.digest === segment.digest) {
      return "noop";
    }
  }
  const last = stored[stored.length - 1];
  if (last !== undefined && segment.from <= last.through) {
    throw new ArchiveConflictError(executionId, segment, last.through);
  }
  return "append";
}
