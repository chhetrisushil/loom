import type { EventEnvelope } from "@loom/core";
import {
  ArchiveConflictError,
  ArchiveIncarnationError,
  type ArchiveSegmentHeader,
  type ArchiveStore,
  type EventStore,
  InMemoryArchiveStore,
  InMemoryAsyncEventStore,
  assertReservedSegmentDigest,
  assertSegmentDigest,
  buildReservedSegment,
  buildSegment,
  decoratedInnerOf,
  inboxChainOf,
  readRangeOf,
  reservedLateKey,
  reservedLateOrigin,
  sameReservedEnvelope,
  segmentDigest,
} from "@loom/event-runtime";
import {
  ArchiveGapError,
  ArchiveTenantMismatchError,
  PlaintextArchiveError,
  plaintextArchiveReason,
  tenantScopeOf,
} from "./checkpointGuard";
import { INBOX_FLOOR_KIND } from "./inbox";

// ── ADR 0138 — moving envelopes into the archive before anything removes them ────────────────────

/**
 * The digest of each archived envelope of `events`, by sequence (digest-verified segments). Reads
 * only the segments overlapping each run of consecutive sequences, so a lone sequence 0 does not drag
 * every segment between it and the rest.
 */
async function archivedBySequence(
  executionId: string,
  archive: ArchiveStore,
  events: readonly EventEnvelope[],
  reserved = false
): Promise<Map<number, EventEnvelope>> {
  const held = new Map<number, EventEnvelope>();
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
      if (reserved) assertReservedSegmentDigest(executionId, seg);
      else assertSegmentDigest(executionId, seg);
      if (seg.kind === "legacy-checkpoint") continue; // a checkpoint, not the events it summarizes
      for (const e of seg.envelopes) held.set(e.sequence, e);
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
    const missing = already.filter((e) => {
      const h = held.get(e.sequence);
      return h === undefined || segmentDigest([h]) !== segmentDigest([e]);
    });
    if (missing.length > 0)
      throw new ArchiveGapError(
        executionId,
        missing.map((e) => e.sequence),
        op
      );
  }
  const fresh = removed.filter((e) => e.sequence > lastThrough);
  if (fresh.length === 0) return;
  // A segment starts at its first removed event, never below it (ADR 0139 B2): abutting the previous
  // segment would claim the range between them, which nothing may have held (a compaction by a node
  // that did not archive, a reserved-stream trim before the archive existed). That gap then reads as
  // unarchived, which is the truth.
  await archive.append(executionId, buildSegment(fresh, incarnation, fresh[0]!.sequence, through));
}

/** Does the archive hold exactly `e` (a reserved-stream envelope) at its sequence? */
function isHeld(held: ReadonlyMap<number, EventEnvelope>, e: EventEnvelope): boolean {
  const h = held.get(e.sequence);
  return h !== undefined && sameReservedEnvelope(e, h);
}

/** Split ascending `envelopes` into maximal runs of consecutive sequences. */
function consecutiveRuns(envelopes: readonly EventEnvelope[]): EventEnvelope[][] {
  const runs: EventEnvelope[][] = [];
  for (const e of envelopes) {
    const run = runs[runs.length - 1];
    if (run !== undefined && e.sequence === run[run.length - 1]!.sequence + 1) run.push(e);
    else runs.push([e]);
  }
  return runs;
}

/**
 * Append `envelopes` (ascending, all above `lastThrough`) to the archive key `key` as one segment per
 * run of consecutive sequences, each covering EXACTLY its run (ADR 0139 B2): a segment's range is a
 * claim that nothing in it is missing, so it never reaches across a sequence the stream did not hold.
 * The one exception is a run that starts on an {@link INBOX_FLOOR_KIND} marker right after the archive's
 * last segment: a seeded floor (a fork, a re-open, a re-created stream) skips sequences by design, and
 * the range up to the marker never held a message. Returns the last sequence archived.
 */
async function appendRuns(
  archive: ArchiveStore,
  key: string,
  incarnation: string,
  envelopes: readonly EventEnvelope[],
  lastThrough: number
): Promise<number> {
  let prev = lastThrough;
  for (const [i, run] of consecutiveRuns(envelopes).entries()) {
    const first = run[0]!;
    const from =
      i === 0 && prev >= 0 && first.eventType === INBOX_FLOOR_KIND ? prev + 1 : first.sequence;
    const through = run[run.length - 1]!.sequence;
    await archive.append(key, buildReservedSegment(run, incarnation, from, through));
    prev = through;
  }
  return prev;
}

// ── ADR 0139 — reserved streams (the inbox, its topic streams, the quarantine copies) ─────────────

/** Whether `store` (through any decorators) bottoms out in the in-memory event store. */
function isInMemoryStack(store: unknown): boolean {
  let cur: unknown = store;
  for (let i = 0; i < 16 && typeof cur === "object" && cur !== null; i++) {
    if (cur instanceof InMemoryAsyncEventStore) return true;
    cur = decoratedInnerOf(cur) ?? (cur as { inner?: unknown }).inner;
  }
  return false;
}

/** The first layer of `store`'s decorator stack that offers `member` as a function. */
function findSealer(store: unknown): ((inner: ArchiveStore) => ArchiveStore) | undefined {
  let cur: unknown = store;
  for (let i = 0; i < 16 && typeof cur === "object" && cur !== null; i++) {
    const f = (cur as { sealArchive?: unknown }).sealArchive;
    if (typeof f === "function") return (f as (a: ArchiveStore) => ArchiveStore).bind(cur);
    cur = decoratedInnerOf(cur) ?? (cur as { inner?: unknown }).inner;
  }
  return undefined;
}

/**
 * ADR 0139 M1 - the inbox archive a runtime defaults to when the app gave none: an IN-MEMORY event store
 * (nothing durable to lose, so a volatile archive loses nothing the log would have kept) gets an in-memory
 * archive, sealed under the log's KeyStore when the log seals (the sealing event store offers
 * `sealArchive`). `undefined` for a durable store, for a tenant-scoped one, and for a sealing store that
 * cannot seal an archive: the caller then refuses at construction.
 */
export function defaultInboxArchive(store: EventStore): ArchiveStore | undefined {
  if (!isInMemoryStack(store) || tenantScopeOf(store) !== undefined) return undefined;
  let archive: ArchiveStore = new InMemoryArchiveStore();
  if (plaintextArchiveReason(store, archive) === undefined) return archive;
  const seal = findSealer(store);
  if (seal === undefined) return undefined;
  archive = seal(archive);
  return plaintextArchiveReason(store, archive) === undefined ? archive : undefined;
}

/**
 * The FALLBACK incarnation of a RESERVED stream (ADR 0139 D2): a constant of the stream id, used only when
 * the chain's owner has no bootstrap envelope to derive it from (see {@link reservedIncarnationOf}).
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
 * The incarnation of a RESERVED stream's archive run (ADR 0139 D2, amended): the {@link segmentDigest} of
 * the CHAIN OWNER's bootstrap envelope (sequence 0 of the execution named by the chain id), exactly as
 * ADR 0138 H2 binds a compaction segment to its log. A reserved stream has no bootstrap of its own, but
 * its owner does, and it differs between two lives of the chain id (a retention delete that kept the
 * archive, then the id reused), so a segment of the previous run is refused ({@link
 * ArchiveIncarnationError}) instead of read as this run's history. A late-run key resolves to the same
 * owner as its stream. When the owner has no bootstrap (an orphan stream) it falls back to
 * {@link reservedIncarnation}, a constant of the stream: the byte-for-byte comparison of every move still
 * stands. One point read of the owner's sequence 0 per call.
 */
export async function reservedIncarnationOf(
  store: Pick<EventStore, "read" | "readFrom" | "readRange">,
  streamKey: string,
  /**
   * ADR 0139 N2: with the archive given, an owner that is GONE (a retention delete that KEPT the archive)
   * resolves to the incarnation the archive's own segments for the stream already carry, so a read after a
   * kept retention still opens them and a straggler is still moved. A REUSED chain id has a bootstrap
   * again, which differs, so the previous run's segments are still refused.
   */
  archive?: Pick<ArchiveStore, "headers">
): Promise<string> {
  const origin = reservedLateOrigin(streamKey)?.streamId ?? streamKey;
  const chain = inboxChainOf(origin);
  const bootstrap = chain === undefined ? undefined : (await readRangeOf(store, chain, 0, 0))[0];
  if (bootstrap !== undefined) return segmentDigest([bootstrap]);
  const archived = archive === undefined ? undefined : (await archive.headers(origin))[0];
  return archived?.incarnation ?? reservedIncarnation(origin);
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

  /** ADR 0139 N2: chain -> the incarnation read from its owner BEFORE the owner was deleted (a kept retention). */
  private readonly pinned = new Map<string, string>();

  /**
   * Pin `incarnation` as the chain's: the retention path derives it from the owner's bootstrap before it
   * deletes the owner, so the chain's live streams still move under the run they belong to.
   */
  pin(chainId: string, incarnation: string): void {
    this.pinned.set(chainId, incarnation);
  }

  private incarnationFor(streamId: string): Promise<string> {
    const origin = reservedLateOrigin(streamId)?.streamId ?? streamId;
    const chain = inboxChainOf(origin);
    const pinned = chain === undefined ? undefined : this.pinned.get(chain);
    return pinned !== undefined
      ? Promise.resolve(pinned)
      : reservedIncarnationOf(this.store, streamId, this.archive);
  }

  /**
   * Forget the remembered last archived sequence of `streamId` (ADR 0139 N1): the key was rewritten or
   * deleted by an erasure, so the next move re-reads the headers.
   */
  invalidate(streamId: string): void {
    this.known.delete(streamId);
  }

  /**
   * The archive's last archived sequence per stream and the incarnation it was checked against,
   * remembered so a trim costs no header read (bounded).
   */
  private readonly known = new Map<string, { through: number; incarnation: string }>();
  private static readonly KNOWN_MAX = 4096;

  private remember(streamId: string, through: number, incarnation: string): void {
    if (this.known.size >= ReservedStreamArchive.KNOWN_MAX && !this.known.has(streamId)) {
      this.known.clear();
    }
    this.known.set(streamId, { through, incarnation });
  }

  /** The stream's archive state from the headers (always fresh), with the foreign-incarnation guard. */
  private async lastThroughOf(streamId: string, incarnation: string): Promise<number> {
    const headers = await this.archive.headers(streamId);
    const foreign = headers.find((h) => h.incarnation !== incarnation);
    if (foreign !== undefined) {
      throw new ArchiveIncarnationError(streamId, foreign.incarnation, incarnation);
    }
    const lastThrough = headers.length > 0 ? headers[headers.length - 1]!.through : -1;
    this.remember(streamId, lastThrough, incarnation);
    return lastThrough;
  }

  /** {@link ArchiveFloor}: the first sequence of `streamId` the archive has not used, if it holds any. */
  readonly floorOf = async (streamId: string): Promise<number | undefined> => {
    const lastThrough = await this.lastThroughOf(streamId, await this.incarnationFor(streamId));
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
      // The owner's bootstrap is read on EVERY move (one point read): a cached incarnation could outlive
      // a retention delete and an id reuse, and the move would extend the previous run's archive.
      const incarnation = await this.incarnationFor(streamId);
      const cached = this.known.get(streamId);
      const lastThrough =
        attempt === 0 && cached !== undefined && cached.incarnation === incarnation
          ? cached.through
          : await this.lastThroughOf(streamId, incarnation);
      const events = await readRangeOf(this.store, streamId, lastThrough < 0 ? 0 : 1, through);
      try {
        await this.move(streamId, lastThrough, events, "trim", incarnation);
        return;
      } catch (err) {
        if (!(err instanceof ArchiveConflictError) || attempt > 0) throw err;
        this.known.delete(streamId); // stale: re-read the headers and try again, once
      }
    }
  }

  /**
   * Archive the WHOLE stream (a delete is about to remove it) and return the highest sequence archived
   * (`undefined` when the stream holds nothing). The caller deletes THROUGH that sequence
   * (`EventStore.deleteThrough`), never the whole stream: a message appended after the read above lands
   * above it and survives (ADR 0139 D8). Every envelope, sequence 0 included, is compared byte-for-byte
   * with what the archive holds at that sequence; one it does not hold (a re-created stream's own 0,
   * stamped with the clock) is a straggler and goes to a late run (D4), never dropped.
   */
  async moveAll(streamId: string): Promise<number | undefined> {
    this.check(streamId);
    const all = await this.store.read(streamId);
    if (all.length === 0) return undefined;
    const incarnation = await this.incarnationFor(streamId);
    const lastThrough = await this.lastThroughOf(streamId, incarnation);
    const through = all[all.length - 1]!.sequence;
    await this.move(streamId, lastThrough, all, "delete", incarnation);
    this.known.delete(streamId); // the stream is about to be re-created from scratch
    return through;
  }

  private async move(
    streamId: string,
    lastThrough: number,
    events: readonly EventEnvelope[],
    op: "trim" | "delete",
    incarnation: string
  ): Promise<void> {
    if (events.length === 0) return;
    let stragglers: EventEnvelope[] = [];
    let rest = events;
    if (lastThrough >= 0) {
      const already = events.filter((e) => e.sequence <= lastThrough);
      if (already.length > 0) {
        const held = await archivedBySequence(streamId, this.archive, already, true);
        stragglers = already.filter((e) => !isHeld(held, e));
        rest = events.filter((e) => e.sequence > lastThrough);
      }
    }
    if (rest.length > 0) {
      const last = await appendRuns(this.archive, streamId, incarnation, rest, lastThrough);
      this.remember(streamId, last, incarnation);
    }
    if (stragglers.length > 0) await this.moveLate(streamId, stragglers, op, incarnation);
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
    op: "trim" | "delete",
    incarnation: string
  ): Promise<void> {
    for (let n = 1; n <= ReservedStreamArchive.MAX_LATE_RUNS; n++) {
      const key = reservedLateKey(streamId, n);
      const headers = await this.archive.headers(key);
      const foreign = headers.find((h) => h.incarnation !== incarnation);
      if (foreign !== undefined) {
        throw new ArchiveIncarnationError(key, foreign.incarnation, incarnation);
      }
      const lastThrough = headers.length > 0 ? headers[headers.length - 1]!.through : -1;
      const already = stragglers.filter((e) => e.sequence <= lastThrough);
      if (already.length > 0) {
        // An earlier attempt may have archived these (a crash before the removal): all held byte-for-byte
        // is a repeat, anything else means this key's run is taken by other envelopes - try the next.
        const held = await archivedBySequence(key, this.archive, already, true);
        if (already.some((e) => !isHeld(held, e))) continue;
      }
      const rest = stragglers.filter((e) => e.sequence > lastThrough);
      if (rest.length > 0) await appendRuns(this.archive, key, incarnation, rest, lastThrough);
      return;
    }
    throw new ArchiveGapError(
      streamId,
      stragglers.map((e) => e.sequence),
      op
    );
  }
}
