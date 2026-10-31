import { createHash } from "node:crypto";
import { type EventEnvelope, canonicalJson } from "@loom/core";
import { ArchiveDigestError, type ArchiveSegment } from "./archiveSpi";

/**
 * The digest of a run of envelopes: SHA-256 (hex) over their canonical JSON (sorted keys, so a
 * backend that reorders object keys on a JSON round trip, such as Postgres `jsonb`, still agrees).
 */
export function segmentDigest(envelopes: readonly EventEnvelope[]): string {
  return createHash("sha256").update(canonicalJson(envelopes)).digest("hex");
}

/** Build a segment from the envelopes a compaction removes. `envelopes` must be non-empty and ascending. */
export function buildSegment(
  envelopes: readonly EventEnvelope[],
  from: number = envelopes[0]!.sequence,
  through: number = envelopes[envelopes.length - 1]!.sequence
): ArchiveSegment {
  return { from, through, count: envelopes.length, digest: segmentDigest(envelopes), envelopes };
}

/** Throws {@link ArchiveDigestError} when `segment`'s envelopes do not hash to its digest. */
export function assertSegmentDigest(executionId: string, segment: ArchiveSegment): void {
  const actual = segmentDigest(segment.envelopes);
  if (actual !== segment.digest || segment.envelopes.length !== segment.count) {
    throw new ArchiveDigestError(
      executionId,
      segment.from,
      segment.through,
      segment.digest,
      actual
    );
  }
}
