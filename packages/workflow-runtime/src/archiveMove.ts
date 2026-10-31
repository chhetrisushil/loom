import type { EventEnvelope } from "@loom/core";
import {
  ArchiveConflictError,
  ArchiveIncarnationError,
  type ArchiveSegmentHeader,
  type ArchiveStore,
  type EventStore,
  assertSegmentDigest,
  buildSegment,
  compareExecutionIds,
  isReservedStream,
  readRangeOf,
  reservedLateKey,
  segmentDigest,
} from "@loom/event-runtime";
import {
  ArchiveGapError,
  ArchiveTenantMismatchError,
  PlaintextArchiveError,
  plaintextArchiveReason,
  tenantScopeOf,
} from "./checkpointGuard";

// ── ADR 0138 — moving envelopes into the archive before anything removes them ────────────────────

/**
 * The digest of each archived envelope of `events`, by sequence (digest-verified segments). Reads
 * only the segments overlapping each run of consecutive sequences, so a lone sequence 0 does not drag
 * every segment between it and the rest.
 */
async function archivedBySequence(
  executionId: string,
  archive: ArchiveStore,
  events: readonly EventEnvelope[]
): Promise<Map<number, string>> {
  const held = new Map<number, string>();
  const runs: EventEnvelope[][] = [];
  for (const e of events) {
    const run = runs[runs.length - 1];
    if (run !== undefined && e.sequence === run[run.length - 1]!.sequence + 1) run.push(e);
    else runs.push([e]);
  }
  for (const run of runs) {
    const segments = await archive.read(executionId, {
      from: run[0]!.sequence,
      through: run[run.length - 1]!.sequence,
    });
    for (const seg of segments) {
      assertSegmentDigest(executionId, seg);
      if (seg.kind === "legacy-checkpoint") continue; // a checkpoint, not the events it summarizes
      for (const e of seg.envelopes) held.set(e.sequence, segmentDigest([e]));
    }
  }
  return held;
}

/**
 * Append `removed` (the exact envelopes a removal is about to take out of the log) to the archive as
 * ONE segment abutting the archive's last, and return nothing. Tolerant of an earlier attempt that
 * archived but crashed before removing: anything at or below the archive's last `through` must
 * already be there, byte-for-byte (verified, fail closed with {@link ArchiveGapError}); only the rest
 * is appended. `headers` are the archive's current headers for `executionId`. A repeat is a no-op.
 */
export async function appendMoved(
  archive: ArchiveStore,
  executionId: string,
  incarnation: string,
  headers: readonly ArchiveSegmentHeader[],
  removed: readonly EventEnvelope[],
  through: number,
  op: "compact" | "trim" | "delete" = "compact"
): Promise<void> {
  if (removed.length === 0) return;
  const lastThrough = headers.length > 0 ? headers[headers.length - 1]!.through : -1;
  const already = removed.filter((e) => e.sequence <= lastThrough);
  if (already.length > 0) {
    const held = await archivedBySequence(executionId, archive, already);
    const missing = already.filter((e) => held.get(e.sequence) !== segmentDigest([e]));
    if (missing.length > 0)
      throw new ArchiveGapError(
        executionId,
        missing.map((e) => e.sequence),
        op
      );
  }
  const fresh = removed.filter((e) => e.sequence > lastThrough);
  if (fresh.length === 0) return;
  // The first segment starts at its first removed event; later ones abut the previous segment.
  await archive.append(
    executionId,
    buildSegment(
      fresh,
      incarnation,
      lastThrough >= 0 ? lastThrough + 1 : fresh[0]!.sequence,
      through
    )
  );
}

// ── ADR 0139 — reserved streams (the inbox, its topic streams, the quarantine copies) ─────────────

/**
 * The incarnation of a RESERVED stream (ADR 0139 D2). A reserved stream has no per-run bootstrap
 * envelope to digest (a topic stream starts at `INBOX_TOPIC_SEQ_BASE` with a message, the legacy
 * stream's sequence 0 is a message, the quarantine's a payload-free anchor), so it is derived from the
 * stream id: a constant of the stream. A leftover from another run of the same stream id is then not
 * told apart by the header but by the byte-for-byte check every move makes ({@link ArchiveGapError}).
 */
export function reservedIncarnation(streamId: string): string {
  return segmentDigest([
    {
      id: `${streamId}-incarnation`,
      workflowId: "__loom_reserved__",
      executionId: streamId,
      eventType: "RESERVED_STREAM_INCARNATION",
      sequence: 0,
      timestamp: 0,
      payload: { stream: streamId },
    },
  ]);
}

/**
 * ADR 0139 — moves the envelopes a reserved-stream trim or delete would remove into the archive
 * first, inside the log's erasure and tenant boundary, failing closed. One instance per runtime.
 */
export class ReservedStreamArchive {
  private checked = false;

  constructor(
    readonly archive: ArchiveStore,
    private readonly store: EventStore,
    private readonly tenant?: string
  ) {}

  /** The erasure and tenant guards of `compact` (ADR 0138 D4, D12, D17), once. */
  private check(streamId: string): void {
    if (this.checked) return;
    const reason = plaintextArchiveReason(this.store, this.archive);
    if (reason !== undefined) throw new PlaintextArchiveError(reason, streamId);
    const eventTenant = tenantScopeOf(this.store);
    const archiveTenant = tenantScopeOf(this.archive);
    if (
      eventTenant !== archiveTenant ||
      (this.tenant !== undefined && eventTenant !== this.tenant)
    ) {
      throw new ArchiveTenantMismatchError(streamId, eventTenant, archiveTenant, this.tenant);
    }
    this.checked = true;
  }

  /** The archive's last archived sequence per stream, remembered so a trim costs no header read (bounded). */
  private readonly known = new Map<string, number>();
  private static readonly KNOWN_MAX = 4096;

  private remember(streamId: string, lastThrough: number): void {
    if (this.known.size >= ReservedStreamArchive.KNOWN_MAX && !this.known.has(streamId)) {
      this.known.clear();
    }
    this.known.set(streamId, lastThrough);
  }

  /** The stream's archive state from the headers (always fresh), with the foreign-incarnation guard. */
  private async lastThroughOf(streamId: string): Promise<number> {
    const headers = await this.archive.headers(streamId);
    const incarnation = reservedIncarnation(streamId);
    const foreign = headers.find((h) => h.incarnation !== incarnation);
    if (foreign !== undefined) {
      throw new ArchiveIncarnationError(streamId, foreign.incarnation, incarnation);
    }
    const lastThrough = headers.length > 0 ? headers[headers.length - 1]!.through : -1;
    this.remember(streamId, lastThrough);
    return lastThrough;
  }

  /** {@link ArchiveFloor}: the first sequence of `streamId` the archive has not used, if it holds any. */
  readonly floorOf = async (streamId: string): Promise<number | undefined> => {
    const lastThrough = await this.lastThroughOf(streamId);
    return lastThrough < 0 ? undefined : lastThrough + 1;
  };

  /**
   * Archive every envelope of `streamId` a truncation through `through` removes (sequences 1..through;
   * sequence 0, which a truncation keeps, is archived with the FIRST segment so the archive is a
   * complete copy of what was ever trimmed). Reads only what is still in the log (`readRange`). The
   * archive's last sequence is remembered per stream, so a steady-state trim costs one ranged read and
   * one append; a stale memory (another node archived first) surfaces as the archive's own
   * {@link ArchiveConflictError}, answered once with a fresh header read.
   */
  async moveThrough(streamId: string, through: number): Promise<void> {
    this.check(streamId);
    for (let attempt = 0; ; attempt++) {
      const lastThrough =
        attempt === 0 && this.known.has(streamId)
          ? (this.known.get(streamId) as number)
          : await this.lastThroughOf(streamId);
      const events = await readRangeOf(this.store, streamId, lastThrough < 0 ? 0 : 1, through);
      try {
        await this.move(streamId, lastThrough, events, through, "trim");
        return;
      } catch (err) {
        if (!(err instanceof ArchiveConflictError) || attempt > 0) throw err;
        this.known.delete(streamId); // stale: re-read the headers and try again, once
      }
    }
  }

  /**
   * Archive the WHOLE stream (a delete is about to remove it). The stream's sequence 0, if present, is
   * verified against the archive (or archived, when nothing was).
   */
  async moveAll(streamId: string): Promise<void> {
    this.check(streamId);
    const all = await this.store.read(streamId);
    if (all.length === 0) return;
    const lastThrough = await this.lastThroughOf(streamId);
    // Sequence 0 is archived once, with the stream's first segment; a re-created stream's own 0 (the
    // quarantine's payload-free anchor, stamped with the clock) is not a fact to keep a second time.
    const events = lastThrough >= 0 ? all.filter((e) => e.sequence !== 0) : all;
    await this.move(streamId, lastThrough, events, all[all.length - 1]!.sequence, "delete");
    this.known.delete(streamId); // the stream is about to be re-created from scratch
  }

  private async move(
    streamId: string,
    lastThrough: number,
    events: readonly EventEnvelope[],
    through: number,
    op: "trim" | "delete"
  ): Promise<void> {
    if (events.length === 0) return;
    const incarnation = reservedIncarnation(streamId);
    let stragglers: EventEnvelope[] = [];
    let rest = events;
    if (lastThrough >= 0) {
      const already = events.filter((e) => e.sequence <= lastThrough);
      if (already.length > 0) {
        const held = await archivedBySequence(streamId, this.archive, already);
        stragglers = already.filter((e) => held.get(e.sequence) !== segmentDigest([e]));
        rest = events.filter((e) => e.sequence > lastThrough);
      }
    }
    if (rest.length > 0) {
      await this.archive.append(
        streamId,
        buildSegment(
          rest,
          incarnation,
          lastThrough >= 0 ? lastThrough + 1 : rest[0]!.sequence,
          through
        )
      );
      this.remember(streamId, through);
    }
    if (stragglers.length > 0) await this.moveLate(streamId, stragglers, op);
  }

  /** The most late runs a stream may have before the move gives up (fail closed). */
  private static readonly MAX_LATE_RUNS = 64;

  /**
   * Archive `stragglers` (ascending) under the first late key of `streamId` that can take them: a run is
   * append-only like any, so a straggler at or below a late run's last sequence tries the next key. An
   * exact repeat (a crash between this append and the removal) is recognised and is a no-op.
   */
  private async moveLate(
    streamId: string,
    stragglers: readonly EventEnvelope[],
    op: "trim" | "delete"
  ): Promise<void> {
    const first = stragglers[0]!.sequence;
    const last = stragglers[stragglers.length - 1]!.sequence;
    const digest = segmentDigest(stragglers);
    for (let n = 1; n <= ReservedStreamArchive.MAX_LATE_RUNS; n++) {
      const key = reservedLateKey(streamId, n);
      const headers = await this.archive.headers(key);
      const incarnation = reservedIncarnation(key);
      const foreign = headers.find((h) => h.incarnation !== incarnation);
      if (foreign !== undefined) {
        throw new ArchiveIncarnationError(key, foreign.incarnation, incarnation);
      }
      if (headers.some((h) => h.through === last && h.digest === digest)) return; // already moved
      const lastThrough = headers.length > 0 ? headers[headers.length - 1]!.through : -1;
      if (first <= lastThrough) continue;
      await this.archive.append(
        key,
        buildSegment(stragglers, incarnation, lastThrough >= 0 ? lastThrough + 1 : first, last)
      );
      return;
    }
    throw new ArchiveGapError(
      streamId,
      stragglers.map((e) => e.sequence),
      op
    );
  }
}

/** The ids of the reserved streams of `chainId` the archive holds segments for (a keyset prefix scan). */
export async function archivedReservedStreams(
  archive: Pick<ArchiveStore, "listExecutions">,
  prefixes: readonly string[],
  chainId: string,
  chainOf: (streamId: string) => string | undefined
): Promise<string[]> {
  const found: string[] = [];
  for (const prefix of prefixes) {
    // The cursor is EXCLUSIVE and the stream whose id IS the prefix must be listed, so start one
    // character short of it and skip what sorts before the prefix.
    let cursor: string | undefined = prefix.slice(0, -1);
    for (;;) {
      const page: Awaited<ReturnType<ArchiveStore["listExecutions"]>> =
        await archive.listExecutions({ cursor, limit: 200 });
      let past = false;
      for (const id of page.executionIds) {
        if (!id.startsWith(prefix)) {
          if (compareExecutionIds(id, prefix) < 0) continue;
          past = true;
          break;
        }
        if (isReservedStream(id) && chainOf(id) === chainId) found.push(id);
      }
      if (past || page.nextCursor === undefined || page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    }
  }
  return found;
}
