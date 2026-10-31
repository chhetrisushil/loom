import { createHash } from "node:crypto";
import { type EventEnvelope, canonicalJson } from "@loom/core";
import {
  ArchiveDigestError,
  type ArchiveExecutionPage,
  type ArchiveSegment,
  type ArchiveSegmentKind,
  ArchiveUnserializableError,
} from "./archiveSpi";
import { compareExecutionIds } from "./executionIdOrder";

/**
 * The JSON form of the envelopes, which is what every backend stores and returns (a `Date` becomes
 * its ISO string, `toJSON` runs, `undefined` members drop). Digesting the round-tripped value makes
 * the digest the same on the write side and on a read that came back through any JSON store, and a
 * value that cannot be JSON (circular, BigInt, a nesting JSON cannot hold) a typed refusal at
 * archive time instead of a `TypeError` mid-compaction or a false digest mismatch on audit.
 */
function jsonForm(envelopes: readonly EventEnvelope[]): unknown {
  try {
    return JSON.parse(JSON.stringify(envelopes));
  } catch (err) {
    throw new ArchiveUnserializableError(err);
  }
}

/**
 * The digest of a run of envelopes: SHA-256 (hex) over their canonical JSON (sorted keys, so a
 * backend that reorders object keys on a JSON round trip, such as Postgres `jsonb`, still agrees).
 */
export function segmentDigest(envelopes: readonly EventEnvelope[]): string {
  const form = jsonForm(envelopes);
  try {
    return createHash("sha256").update(canonicalJson(form)).digest("hex");
  } catch (err) {
    throw new ArchiveUnserializableError(err);
  }
}

/** Build a segment from the envelopes a compaction removes. `envelopes` must be non-empty and ascending. */
export function buildSegment(
  envelopes: readonly EventEnvelope[],
  incarnation: string,
  from: number = envelopes[0]!.sequence,
  through: number = envelopes[envelopes.length - 1]!.sequence,
  kind?: ArchiveSegmentKind
): ArchiveSegment {
  return {
    from,
    through,
    count: envelopes.length,
    digest: segmentDigest(envelopes),
    incarnation,
    ...(kind !== undefined && kind !== "events" && { kind }),
    envelopes,
  };
}

/** One page of ids from an ascending list, keyset by exclusive cursor (shared by the backends' tests and memory store). */
export function pageIds(
  sorted: readonly string[],
  opts: { cursor?: string; limit?: number } = {}
): ArchiveExecutionPage {
  const limit = opts.limit ?? 500;
  const start =
    opts.cursor === undefined
      ? 0
      : sorted.findIndex((id) => compareExecutionIds(id, opts.cursor!) > 0);
  if (start === -1) return { executionIds: [] };
  const page = sorted.slice(start, start + limit);
  const more = start + limit < sorted.length;
  return more ? { executionIds: page, nextCursor: page[page.length - 1]! } : { executionIds: page };
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
