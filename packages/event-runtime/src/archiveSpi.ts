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
 * 1.0.0: `append` / `headers` / `read` / optional `deleteExecution` / `close`.
 */
export const ARCHIVE_STORE_SPI_VERSION = "1.0.0";

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
  read(
    executionId: string,
    range?: { readonly from?: number; readonly through?: number }
  ): Promise<ArchiveSegment[]>;
  /** OPTIONAL. The whole-execution delete of the retention path (`LogLifecycle.applyRetention`). */
  deleteExecution?(executionId: string): Promise<void>;
  close(): Promise<void>;
}

/** The names of the OPTIONAL {@link ArchiveStore} methods, for the decorator plan. */
export const OPTIONAL_ARCHIVE_STORE_METHODS = ["deleteExecution"] as const;

/** A segment that overlaps or rewinds past what the archive already holds (nothing was written). */
export class ArchiveConflictError extends Error {
  readonly retryable = false;
  constructor(
    readonly executionId: string,
    readonly attempted: ArchiveSegmentHeader,
    readonly lastThrough: number
  ) {
    super(
      `archive "${executionId}": segment [${attempted.from}..${attempted.through}] does not start after the archive's last sequence ${lastThrough}, and is not an exact repeat of an archived segment. Segments are append-only and contiguous; nothing was written.`
    );
    this.name = "ArchiveConflictError";
    Object.setPrototypeOf(this, ArchiveConflictError.prototype);
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
});

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
