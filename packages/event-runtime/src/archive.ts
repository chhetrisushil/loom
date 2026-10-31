import { createHash } from "node:crypto";
import { type EventEnvelope, canonicalJson } from "@loom/core";
import {
  ArchiveDigestError,
  type ArchiveExecutionPage,
  type ArchiveSegment,
  type ArchiveSegmentKind,
  type ArchiveStore,
  ArchiveUnserializableError,
} from "./archiveSpi";
import { compareExecutionIds } from "./executionIdOrder";
import {
  INBOX_STREAM_PREFIX,
  QUARANTINE_STREAM_PREFIX,
  RESERVED_LATE_PREFIX,
  archiveChainOf,
  isReservedStream,
} from "./types";

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

// ── ADR 0139 D12 - the sender field of an archived inbox envelope is the one erasable part ──────────

/** `payload.sender` after the sender was erased (sealed under their subject and shredded, or redacted). */
export const SENDER_ERASED = Object.freeze({ erased: true as const });

/**
 * The erased-sender marker carrying a STABLE, NON-IDENTIFYING per-sender reference (ADR 0139 N3): the sealed
 * sender's opaque handle, or a random one a plaintext redaction minted per erased subject. Two messages
 * from one erased sender still share it and two different erased senders do not, so the owner's dedupe
 * (which keyed on the identity before the erasure) keeps telling them apart; it names nobody.
 */
export function senderErasedMarker(ref?: string): { erased: true; ref?: string } {
  return ref === undefined ? { erased: true } : { erased: true, ref };
}

/** Whether a stored `sender` value is the {@link SENDER_ERASED} marker. */
export function isSenderErased(v: unknown): boolean {
  return typeof v === "object" && v !== null && (v as { erased?: unknown }).erased === true;
}

/**
 * The envelope with an inbox message's `payload.sender` masked (`null`). The digest of a RESERVED
 * stream's segment is taken over this form, so the one thing an erasure may change afterwards - the
 * sender's identity, sealed under THEIR subject and shredded with it, or redacted in a plaintext archive
 * (a recorded redaction, ADR 0139 D12) - does not turn into a digest mismatch on the audit read. Every
 * other byte stays covered, and a live envelope is compared with its archived copy by
 * {@link sameReservedEnvelope}, which still tells two DIFFERENT live senders apart.
 */
export function maskSender(e: EventEnvelope): EventEnvelope {
  if (e.eventType !== "INBOX_MESSAGE") return e;
  const p = e.payload as { sender?: unknown } | null | undefined;
  if (p === null || typeof p !== "object" || p.sender === undefined) return e;
  return { ...e, payload: { ...p, sender: null } };
}

/** {@link segmentDigest} over {@link maskSender}-masked envelopes (the digest of a reserved-stream segment). */
export function reservedSegmentDigest(envelopes: readonly EventEnvelope[]): string {
  return segmentDigest(envelopes.map(maskSender));
}

/**
 * ADR 0139 N7 - the digest of the SENDERS of a run of reserved-stream envelopes (SHA-256 over the canonical
 * JSON of each envelope's `payload.sender`, `null` for one without). A plaintext reserved segment carries it
 * beside its (sender-masked) `digest`, so the one field an erasure may redact still has bit-rot detection;
 * a redaction recomputes it in the same atomic replace.
 */
export function senderDigestOf(envelopes: readonly EventEnvelope[]): string {
  const senders = envelopes.map((e) =>
    e.eventType === "INBOX_MESSAGE"
      ? ((e.payload as { sender?: unknown } | null)?.sender ?? null)
      : null
  );
  try {
    return createHash("sha256")
      .update(canonicalJson(JSON.parse(JSON.stringify(senders))))
      .digest("hex");
  } catch (err) {
    throw new ArchiveUnserializableError(err);
  }
}

/** {@link buildSegment} with the reserved-stream digest. */
export function buildReservedSegment(
  envelopes: readonly EventEnvelope[],
  incarnation: string,
  from: number = envelopes[0]!.sequence,
  through: number = envelopes[envelopes.length - 1]!.sequence
): ArchiveSegment {
  return {
    ...buildSegment(envelopes, incarnation, from, through),
    digest: reservedSegmentDigest(envelopes),
    senderDigest: senderDigestOf(envelopes),
  };
}

/** {@link assertSegmentDigest} for a reserved-stream segment. */
export function assertReservedSegmentDigest(executionId: string, segment: ArchiveSegment): void {
  // The sender digest is verified ONLY WHEN PRESENT: a segment written before ARCHIVE_STORE_SPI 1.1.0 (or by
  // an archive that does not persist the field) has none, and still reads - its sender field simply has no
  // bit-rot detection of its own (ADR 0139 D19; pre-1.1.0 compatibility path, not a downgrade to exploit:
  // a writer of the archive could equally rewrite the segment).
  const actual = reservedSegmentDigest(segment.envelopes);
  if (
    segment.senderDigest !== undefined &&
    senderDigestOf(segment.envelopes) !== segment.senderDigest
  ) {
    throw new ArchiveDigestError(
      executionId,
      segment.from,
      segment.through,
      `sender:${segment.senderDigest}`,
      `sender:${senderDigestOf(segment.envelopes)}`
    );
  }
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

/**
 * Are `live` and `archived` the same inbox envelope? Equal masked digests, and the senders either equal
 * or at least one of them erased (an erased sender is the same fact with its identity removed).
 */
export function sameReservedEnvelope(live: EventEnvelope, archived: EventEnvelope): boolean {
  if (segmentDigest([maskSender(live)]) !== segmentDigest([maskSender(archived)])) return false;
  const a = (live.payload as { sender?: unknown } | null)?.sender;
  const b = (archived.payload as { sender?: unknown } | null)?.sender;
  if (isSenderErased(a) || isSenderErased(b)) return true;
  return segmentDigest([{ ...live, payload: a }]) === segmentDigest([{ ...archived, payload: b }]);
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

/**
 * The ids of the reserved streams of `chainId` the archive holds segments for (keyset prefix scans, ADR
 * 0139): the chain's inbox (legacy, per-topic, registry) and quarantine streams, and the late runs split
 * from them. The late keys all sit under one prefix, so their scan walks every late run of every chain
 * (they exist only after a raced send or a node without an archive floor: a handful at most); the listing
 * is paged by 200.
 */
export async function archivedReservedStreams(
  archive: Pick<ArchiveStore, "listExecutions">,
  chainId: string
): Promise<string[]> {
  const found: string[] = [];
  const own = [`${INBOX_STREAM_PREFIX}${chainId}`, `${QUARANTINE_STREAM_PREFIX}${chainId}`];
  const prefixes = [...own, ...own.map((p) => `${RESERVED_LATE_PREFIX}${p}`)];
  for (const prefix of prefixes) {
    // The cursor is EXCLUSIVE and the stream whose id IS the prefix must be listed, so start one
    // character short of it and skip what sorts before the prefix.
    let cursor: string | undefined = prefix.slice(0, -1);
    for (;;) {
      const page: ArchiveExecutionPage = await archive.listExecutions({ cursor, limit: 200 });
      let past = false;
      for (const id of page.executionIds) {
        if (!id.startsWith(prefix)) {
          if (compareExecutionIds(id, prefix) < 0) continue;
          past = true;
          break;
        }
        if (isReservedStream(id) && archiveChainOf(id) === chainId) found.push(id);
      }
      if (past || page.nextCursor === undefined || page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    }
  }
  return found;
}
