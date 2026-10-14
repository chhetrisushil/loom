import type { EventStore, ExecutionEnumerable } from "@loom/event-runtime";
import { iterateExecutionIds } from "@loom/event-runtime";
import type { ContentStore } from "./ContentStore";
import { isContentTouchingSnapshotStore } from "./ContentTouchingSnapshotStore";
import { visitCitedAddresses } from "./citations";

// ── K10.6 (ADR 0055) — pinned mark-and-sweep for claim-checked content ────────
//
// Blob reclamation was the ADR 0046 deferred gap: `deleteExecution`/
// `truncatePrefix` reclaim events but never blobs. This sweep closes it for
// claim-checked results (ADR 0054), with the retention rule the perpetual-agents
// series fixed jointly: *findings and their evidence are permanent; runs are
// archivable; raw telemetry is disposable.* Pins are DERIVED from the log on
// every sweep (mark-and-sweep, not a persisted refcount): the log is the source
// of truth, there is no mutable index to corrupt or resurrect, and archived
// executions keep pinning simply by being scanned — pass the archive store
// alongside the live one. Keyed by content address, so a blob cited by a
// finding in an archived month-1 run survives any number of rotations.
//
// Only a claim-check envelope's own `ref` is TTL-reclaimable (ADR 0055 D4).
// A bare ref is load-bearing: `ContentResolvingEventStore.read` resolves every
// bare ref in a payload and throws `ContentMissingError` when its blob is gone,
// so erasing one bricks the execution (resume, replay, fork, export). The raw
// log cannot say which bare refs a resolving store will resolve, so every bare
// ref is retained while any scanned event cites it.

/**
 * The highest sequence missing below the log's tip, or -1 when it is contiguous from 0. The
 * same test `LogLifecycle` uses to find a compaction checkpoint (ADR 0106). One backward pass.
 */
function highestMissingSequence(events: readonly { sequence: number }[]): number {
  for (let i = events.length - 1; i > 0; i--) {
    const at = events[i]!.sequence;
    if (at - events[i - 1]!.sequence > 1) return at - 1;
  }
  return events.length > 0 && events[0]!.sequence !== 0 ? events[0]!.sequence - 1 : -1;
}

/**
 * A {@link PinPredicate} for `LogLifecycle` (K10.6): pin any execution whose log
 * carries at least one event of the designated kinds — e.g. the app's finding
 * events. Use when no archive is configured and reclaiming the run would destroy
 * the only copy of its durable conclusions.
 */
export function pinByEventKinds(
  eventStore: Pick<EventStore, "read">,
  kinds: Iterable<string>
): (executionId: string) => Promise<boolean> {
  const pinnedKinds = new Set(kinds);
  return async (executionId) =>
    (await eventStore.read(executionId)).some((event) => pinnedKinds.has(event.eventType));
}

/** Everything but the `dryRun` / `reclaimOrphans` pair, which {@link ContentSweepOptions} ties together. */
export interface ContentSweepBase {
  /**
   * Every log store whose events may cite content — the live store AND any
   * archive stores. All must be enumerable (`listExecutionsPage()` preferred —
   * SP-2, bounded memory — or `listExecutions()`): a store that cannot be
   * enumerated cannot be swept safely (its pins would be invisible), so the
   * sweep refuses rather than silently under-pinning.
   *
   * List the LIVE store BEFORE its archive. Retention copies an execution to the archive and
   * then deletes it from the live store. Scanned live-first, an execution that moves during
   * the sweep is seen in one store or the other. Scanned archive-first, it can be missed by
   * both, and its blobs then look like orphans.
   */
  eventStores: readonly (Pick<EventStore, "read"> & ExecutionEnumerable)[];
  /**
   * ADR 0055 D6 — where compaction checkpoints live: the live snapshot store AND EACH
   * ARCHIVE'S snapshot store. `LogLifecycle.compact` checkpoints the fold and truncates the
   * prefix, so a ref the prefix cited survives only in snapshot state.
   *
   * Which logs were compacted (ADR 0106, superseding "no sequence-1 event"): compaction
   * removes its checkpoint's slot and, when it keeps pinned-kind events, never the tip. So a
   * gap-free log with more than the bootstrap was never compacted (no snapshot read); a
   * gapped log's checkpoint sits at its highest missing sequence `gap`; a bootstrap-only log
   * was compacted through its tip. For each compacted execution the sweep pins every ref in:
   *  - the COMPACTION CHECKPOINT: the lowest snapshot in `[gap, tip]` — exactly `gap` for a
   *    compaction's own, the fork seed (`metadata.forkSequence`, one `loadAt`) for a child
   *    forked from a compacted parent — or, for a bootstrap-only log, its latest snapshot.
   *    ANY snapshot at or above `gap` covers a lost checkpoint, matching `LogLifecycle.compact`,
   *    which accepts a base at or above the gap; below `gap` nothing does. `fork()` from any point after it loads that
   *    checkpoint, so its refs stay reachable even after a later snapshot overwrote them.
   *  - the LATEST snapshot, which resume loads.
   *
   * Snapshots in between hold only checkpoint- or suffix-derived refs, and the suffix is
   * scanned as log. Anything below the checkpoint is unreachable. The refs are PINNED because
   * compaction folded away the event kinds, so the sweep cannot tell telemetry from evidence.
   * They are released when retention deletes the execution, which deletes its snapshots too.
   *
   * `reclaimOrphans` REFUSES, before erasing anything:
   *  - without this option, when any scanned store can `truncatePrefix`;
   *  - when an execution looks compacted but no checkpoint is found. That covers a gap with no
   *    snapshot in `[gap, tip]`, and a sequence-0-only log with no snapshot, which is either
   *    compacted at its tip or a run that never got past its bootstrap. The two are
   *    indistinguishable, so both refuse.
   */
  snapshotStores?: readonly SnapshotLookup[];
  /**
   * The blob store. With `deleteIfUntouchedSince` (SPI 1.3.0) every erase is conditional on
   * the blob's touch time, which closes the re-cite race for a re-cite THROUGH `put` (ADR 0055
   * D5); without it the sweep falls back to `delete` and reports `raceSafe: false`. A citation
   * copied WITHOUT a `put` (a fork's `copyPrefix`, a ref an `append` keeps) is protected by SPI
   * 1.4.0 `touch`, which `reclaimOrphans` requires; see `reclaimOrphans`. `listPage` enables it.
   */
  contentStore: Pick<
    ContentStore,
    "delete" | "deleteIfUntouchedSince" | "listPage" | "touchClock" | "touch"
  >;
  /** Event kinds whose cited refs are pinned — retained as long as the citing fact exists. */
  pinnedEventTypes: Iterable<string>;
  /** Reclaim an unpinned ref only when its latest citation is older than this. */
  olderThanMs: number;
  /**
   * LOG time, in epoch ms: the instant the TTL is measured back from, compared against event
   * `timestamp`s (`now − latest citation ≥ olderThanMs`). It is NOT the store's clock. A
   * simulated or replayed log may run far from the store's wall clock; the race guard uses
   * `touchedBefore` for that reason.
   */
  now: number;
  /**
   * STORE time, in epoch ms, on the clock the content store stamps touch times with: the
   * cutoff for the conditional delete and for orphan eligibility (ADR 0055 D5). Default: the
   * store's `touchClock()` read ONCE at the sweep's start, minus `olderThanMs`. A store with
   * `deleteIfUntouchedSince` but no `touchClock` requires it explicitly.
   */
  touchedBefore?: number;
  /**
   * DX-2 — report what WOULD be reclaimed without deleting anything (the
   * `loom sweep content` operator default; `--apply` turns it off).
   */
  dryRun?: boolean;
  /**
   * ADR 0055 D7 — external root sets: content addresses held OUTSIDE the scanned logs (an app
   * table such as a Postgres `experience_refs`). Every yielded address is pinned through both
   * passes. Read once per sweep, after the mark phase. An app that records a new root for
   * bytes the store already holds must `put` them (the put is the touch the conditional
   * delete sees), exactly as a flow does.
   */
  roots?: () => AsyncIterable<string>;
  /**
   * ADR 0055 D6 — also reclaim ORPHANS: blobs no scanned event and no root cites (their
   * execution was deleted with no archive, a crash between `put` and the append, a truncated
   * prefix), once untouched for the TTL. Requires the store's `listPage` and
   * `deleteIfUntouchedSince`; refuses otherwise.
   *
   * ACKNOWLEDGEMENT REQUIRED (ADR 0055 amendment, fail-closed): to ERASE, pass
   * `{ completeScan: true }` (plus `snapshotsTouchContent: true` when `snapshotStores` is given, below). A bare `true` (or any other value) throws
   * {@link ReclaimOrphansAckError} before anything is read or erased. A `dryRun` erases nothing
   * and is how you check completeness, so under `dryRun: true` any truthy value (`true` included)
   * is accepted; see {@link ContentSweepOptions} for the typing. The acknowledgement is your
   * assertion that `eventStores`, `snapshotStores` and `roots` together cover EVERY place that
   * cites content, scanned in the right ORDER: each live store BEFORE its archive (ADR 0055
   * "Scan order"). `[archive, live]` can miss an execution that retention moves mid-sweep, and
   * its blobs then look like orphans.
   *
   * HAZARD the sweep cannot detect, which is why the assertion exists: a citing store that was
   * NOT passed in `eventStores` or `snapshotStores`. Every blob only that store cites is an
   * orphan to this pass, and it is erased while still cited. Pass every archive
   * (`retention.archive`) and each archive's snapshot store, and every app table through `roots`.
   * Run with `dryRun: true` first and read the list.
   *
   * CONCURRENCY (ADR 0055 D6 amendment 2): D5's conditional delete only sees a touch. A `put`
   * touches; a citation that enters a log WITHOUT one does not by itself:
   * `ContentResolvingEventStore.copyPrefix` (a fork) copies refs verbatim, and an `append`
   * keeps refs already inside its payload (recalled memory, `scriptRef`, refs passed between
   * steps). SPI 1.4.0 `touch` closes that: those two paths touch the refs they carry, so a fork
   * made mid-sweep makes `deleteIfUntouchedSince` refuse. To ERASE, the content store MUST
   * implement `touch` or the sweep throws {@link ReclaimOrphansTouchError} (a `dryRun` need not).
   * The log must be written through a `ContentResolvingEventStore` over that store: a writer
   * that copies refs some other way is outside the guarantee.
   *
   * SNAPSHOTS (second path): a fork of a COMPACTED parent saves a seed snapshot whose state
   * cites refs that exist nowhere else (the prefix was truncated). `ContentResolvingEventStore`
   * cannot see it; only a snapshot store wrapped in `ContentTouchingSnapshotStore`
   * (outside any `EncryptingSnapshotStore`, over the same content store) touches those refs.
   * loom never builds either store for the host, so the wrapping is the host's and is not PROVEN
   * from here (a sweep, and the CLI, read a RAW store over the tables a wrapped one wrote, so an
   * unbranded store is no evidence the writer was unwrapped): an ERASING pass given `snapshotStores` must also pass
   * `{ completeScan: true, snapshotsTouchContent: true }` or it throws
   * {@link ReclaimOrphansSnapshotAckError}. Without `snapshotStores` it is not needed (such a
   * pass already refuses a store that can `truncatePrefix`, and a fork of an uncompacted parent
   * copies every event, so its seed cites nothing the copied events do not). A `dryRun` is exempt.
   * The flag stays an assertion about the WRITER and is ALWAYS required, even when every store
   * passed is a `ContentTouchingSnapshotStore` (it vouches for itself, not for the other stores the
   * runtime saves to). Best-effort detection only WARNS: the report counts branded and unbranded
   * stores (`snapshotStoresTouching` / `snapshotStoresUnbranded`), and a pass that is handed a MIX
   * (some branded, some not: a host wrapped some writers and likely forgot others) emits one
   * `LOOM_CONTENT_SNAPSHOT_UNWRAPPED` process warning. It never refuses, so the CLI's raw SQLite
   * stores are not rejected; it never relaxes the flag either (fail-closed).
   *
   * THE GUARANTEE IS D5'S, NOT THE TOUCH'S. The cutoff is `touchClock() - olderThanMs`. The
   * touch BEFORE a write is what makes a sweep whose cutoff is later refuse; so the race is
   * closed while a write's touch-to-commit window is shorter than the margin
   * `store-now - cutoff` (the TTL, or the distance of an explicit `touchedBefore` from the
   * store's clock). The touch AFTER the write is a best-effort extension of that window (it
   * is not retried and an error is reported through `onTouchError`, not raised); do not
   * count on it. With a zero or tiny margin the window is unbounded: a fork whose before-touch
   * is older than the cutoff and which commits after the scan has passed the child is erased
   * under. So an ERASING orphan pass refuses `olderThanMs <= 0` and any cutoff closer to the
   * store's clock than {@link MIN_ORPHAN_ERASE_MARGIN_MS} with {@link ReclaimOrphansMarginError},
   * and a store with no `touchClock()` (the margin cannot be measured) with
   * {@link ReclaimOrphansClockError}; a `dryRun` is unaffected. Pick a margin well above your longest write (a fork's copy of a
   * long prefix included).
   */
  reclaimOrphans?: ReclaimOrphansAck | boolean;
}

/**
 * Sweep options. `reclaimOrphans` and `dryRun` are tied by a union so the type says what the
 * runtime enforces: a sweep that can ERASE (`dryRun` absent or `false`) accepts only the
 * acknowledgement object (or `false`), so a bare `true` is a compile error there; a
 * `dryRun: true` sweep also accepts a plain `true`, because it erases nothing and is how a host
 * checks completeness. (A `dryRun` typed as a plain `boolean` falls in the first arm, which is
 * the safe one.)
 */
export type ContentSweepOptions = Omit<ContentSweepBase, "dryRun" | "reclaimOrphans"> &
  (
    | { dryRun?: false; reclaimOrphans?: ReclaimOrphansAck | false }
    | { dryRun: true; reclaimOrphans?: ReclaimOrphansAck | boolean }
  );

/**
 * The caller's assertion that a `reclaimOrphans` sweep sees every citing store. The literal
 * `true` type makes `{ completeScan: false }` a compile error; the runtime check also refuses
 * untyped callers.
 */
export interface ReclaimOrphansAck {
  completeScan: true;
  /**
   * Required (checked at runtime) whenever an ERASING pass is given `snapshotStores`: the
   * caller's assertion that every snapshot store the runtime SAVES to is wrapped in
   * `ContentTouchingSnapshotStore` (outside any `EncryptingSnapshotStore`). Without it a
   * fork of a compacted parent saves a seed snapshot citing refs that live nowhere else, and
   * a sweep can erase them under the live child. See {@link ReclaimOrphansSnapshotAckError}.
   */
  snapshotsTouchContent?: true;
}

/** A safe description of a rejected value: BigInt and circular values make `JSON.stringify` throw. */
function describeReceived(received: unknown): string {
  try {
    return JSON.stringify(received) ?? String(received);
  } catch {
    try {
      return `an unserializable ${typeof received} (${Object.prototype.toString.call(received)})`;
    } catch {
      return `an unserializable ${typeof received}`;
    }
  }
}

/** `reclaimOrphans` was set without `{ completeScan: true }`. Nothing was read or erased. */
export class ReclaimOrphansAckError extends TypeError {
  constructor(received: unknown) {
    super(
      `sweepUnpinnedContent: reclaimOrphans must be { completeScan: true } to erase (received ${describeReceived(received)}). Orphan reclamation erases every blob that no scanned log, snapshot or root cites, so a citing store you forgot to pass loses its blobs while they are still cited. Set { completeScan: true } only when eventStores, snapshotStores and roots cover ALL of them (every retention archive and its snapshot store included), AND scanned in order: each live store BEFORE its archive, or an execution retention moves mid-sweep can be missed by both. A dryRun does not need the acknowledgement. Migration: reclaimOrphans: true -> reclaimOrphans: { completeScan: true }.`
    );
    this.name = "ReclaimOrphansAckError";
  }
}

/**
 * An ERASING `reclaimOrphans` pass was given `snapshotStores` without
 * `{ snapshotsTouchContent: true }`. Nothing was read or erased. A compacted parent's prefix refs
 * live only in snapshot state, and a fork copies that state into its seed snapshot with no `put`
 * and no event; only a snapshot store wrapped in `ContentTouchingSnapshotStore` touches them.
 * The sweep cannot see how the writing runtime's snapshot store was built, so, like D6's
 * archive assertion, the host states it. A `dryRun` is exempt. With no `snapshotStores` the
 * acknowledgement is not needed: the pass then refuses any store that can `truncatePrefix`, and
 * a fork of an UNcompacted parent copies every event (refs touched by `copyPrefix`), so its seed
 * state cites nothing the copied events do not.
 */
export class ReclaimOrphansSnapshotAckError extends TypeError {
  constructor() {
    super(
      "sweepUnpinnedContent: an erasing reclaimOrphans pass given snapshotStores needs { completeScan: true, snapshotsTouchContent: true }. A fork of a compacted parent saves a seed snapshot that cites refs found nowhere else; only a snapshot store wrapped in ContentTouchingSnapshotStore (outside any EncryptingSnapshotStore, over the same content store the log uses) touches them, so a sweep racing the fork erases blobs a live child cites (replay then throws ContentMissingError). Wrap every snapshot store the runtime saves to, then pass snapshotsTouchContent: true, or run with dryRun: true."
    );
    this.name = "ReclaimOrphansSnapshotAckError";
  }
}

/**
 * `reclaimOrphans` was asked to ERASE through a content store without SPI 1.4.0 `touch`.
 * Nothing was read or erased. Without `touch`, a citation that enters a log with no `put` (a
 * fork's `copyPrefix`, a ref an `append` carries) cannot make the conditional delete refuse, so
 * an orphan sweep concurrent with a fork or a delete can erase a blob a live log still cites
 * (replay then throws `ContentMissingError`). This is a deletion safety boundary: it refuses
 * rather than documenting the hazard. A `dryRun` is unaffected.
 */
export class ReclaimOrphansTouchError extends TypeError {
  constructor() {
    super(
      "sweepUnpinnedContent: reclaimOrphans needs a content store with touch() (ContentStore SPI 1.4.0) to ERASE. Without it a fork (copyPrefix) or an append that carries an existing ref cannot mark the blob re-cited, so an orphan sweep racing a fork or a delete can erase a blob a live log still cites. Add touch() to the store (SqliteContentStore and InMemoryContentStore have it; a CachingContentStore forwards it), or run with dryRun: true."
    );
    this.name = "ReclaimOrphansTouchError";
  }
}

/**
 * The smallest margin, in ms, between the content store's clock and the guard cutoff that an
 * ERASING orphan pass accepts (ADR 0055 D6 amendment 2). A write's touch-to-commit window must
 * be shorter than the margin for the touch to protect it; 60 s is far above an append and
 * above a fork's prefix copy at any realistic size, and an operator who needs a bigger one
 * simply passes a larger TTL.
 */
export const MIN_ORPHAN_ERASE_MARGIN_MS = 60_000;

/**
 * An ERASING `reclaimOrphans` pass was configured with a zero/negative `olderThanMs`, or a
 * cutoff (`touchedBefore`) closer to the content store's clock than
 * {@link MIN_ORPHAN_ERASE_MARGIN_MS}. Nothing was read or erased. With no margin the
 * touch-before-write has no window to protect: a write can touch, the sweep read a later cutoff,
 * and the write commit after the scan, so a blob a live log cites is erased.
 */
export class ReclaimOrphansMarginError extends TypeError {
  constructor(readonly marginMs: number) {
    super(
      `sweepUnpinnedContent: an erasing reclaimOrphans pass needs a guard margin of at least ${MIN_ORPHAN_ERASE_MARGIN_MS}ms between the content store's clock and the cutoff (received ${marginMs}ms: olderThanMs, or touchedBefore's distance from the store's clock). The touch that protects a fork or an append only covers a write whose touch-to-commit window is shorter than that margin; with olderThanMs <= 0 the window is unbounded. Raise olderThanMs / lower touchedBefore, or run with dryRun: true.`
    );
    this.name = "ReclaimOrphansMarginError";
  }
}

/**
 * An ERASING `reclaimOrphans` pass over a content store with `deleteIfUntouchedSince` but no
 * `touchClock()`. Nothing was read or erased. Without the store's clock the sweep cannot measure
 * the margin between "now" and the cutoff (`touchedBefore` is an unchecked caller value, so
 * `touchedBefore: Date.now()` would pass any `olderThanMs`), and the touch-to-commit window is
 * then unbounded. A `dryRun` is exempt.
 */
export class ReclaimOrphansClockError extends TypeError {
  constructor() {
    super(
      "sweepUnpinnedContent: an erasing reclaimOrphans pass needs a content store with touchClock() so the guard margin can be measured (a store with deleteIfUntouchedSince but no touchClock cannot prove touchedBefore is far enough behind its clock). Add touchClock() to the store, or run with dryRun: true."
    );
    this.name = "ReclaimOrphansClockError";
  }
}

/** Structural view of a snapshot store: just `loadLatest` (no snapshot-runtime dependency). */
export interface SnapshotLookup {
  loadLatest(executionId: string): Promise<{ sequence: number; state: unknown } | null>;
  /** Exact-sequence load; used for a forked child's seed (optional — falls back to a walk). */
  loadAt?(
    executionId: string,
    sequence: number
  ): Promise<{ sequence: number; state: unknown } | null>;
  loadLatestBefore(
    executionId: string,
    sequence: number
  ): Promise<{ sequence: number; state: unknown } | null>;
}

let warnedUnwrapped = false;
/** Test-only: re-arm the once-per-process warning below. Not exported from the package index. */
export function resetSnapshotUnwrappedWarning(): void {
  warnedUnwrapped = false;
}
/**
 * One process warning for a MIXED set of snapshot stores, ONCE per process (like
 * `LOOM_CONTENT_TOUCH`): a scheduled sweep over the same mixed set would otherwise warn every run.
 * Never throws (best effort, advisory).
 */
function emitUnwrappedWarning(touching: number, unbranded: number): void {
  if (warnedUnwrapped) return;
  warnedUnwrapped = true;
  const proc = (globalThis as { process?: { emitWarning?: (m: string, o?: object) => void } })
    .process;
  try {
    proc?.emitWarning?.(
      `sweepUnpinnedContent: ${unbranded} of ${touching + unbranded} snapshot stores are not a ContentTouchingSnapshotStore while ${touching} are. If an unbranded one is a store the runtime SAVES to, a fork of a compacted parent can lose blobs to this erasing orphan pass; if it is only a raw reader over a wrapped writer's tables, ignore this.`,
      { code: "LOOM_CONTENT_SNAPSHOT_UNWRAPPED" }
    );
  } catch {
    // advisory only
  }
}

/** Orphan-pass page size (ADR 0055 D6): bounded memory per page. */
const ORPHAN_PAGE_LIMIT = 500;

export interface ContentSweepReport {
  executionsScanned: number;
  refsSeen: number;
  refsPinned: number;
  /**
   * ADR 0055 D4 — refs cited at least once anywhere but as a claim-check envelope's
   * `ref` (a digest counts as anywhere). These are
   * load-bearing and are never reclaimed while any scanned event cites them.
   */
  refsLoadBearing: number;
  /** Content addresses erased this sweep — or, under `dryRun`, that WOULD be. */
  reclaimed: string[];
  /**
   * ADR 0055 D5 — every erase was conditional on the blob's touch time
   * (`deleteIfUntouchedSince`), so a `put` that re-cited a blob during the sweep kept it.
   * `false` = the store lacks it and the sweep used plain `delete`: such a re-cite is lost.
   */
  raceSafe: boolean;
  /** ADR 0055 D6 — orphans erased (or, under `dryRun`, that WOULD be); `[]` unless `reclaimOrphans`. */
  orphansReclaimed: string[];
  /**
   * Of `snapshotStores`, how many are a `ContentTouchingSnapshotStore` (branded). Informational:
   * an unbranded store may be a raw reader over tables a wrapped writer filled.
   */
  snapshotStoresTouching: number;
  /** Of `snapshotStores`, how many are NOT branded. See `snapshotStoresTouching`. */
  snapshotStoresUnbranded: number;
  /**
   * Executions whose scanned snapshot `state` is a top-level `__loomEnc` envelope (an
   * `EncryptingSnapshotStore({ sealState })` read RAW): the refs it cites are invisible to this
   * scan. An erasing pass throws {@link SealedSnapshotScanError} instead; a `dryRun` lists them.
   */
  sealedSnapshots: string[];
}

/**
 * An erasing sweep read a snapshot whose `state` is one sealed envelope (a `sealState`
 * `EncryptingSnapshotStore` given as its RAW inner store). The scan cannot see the refs inside, so
 * it would treat live blobs as unreferenced and erase them. Nothing was erased.
 */
export class SealedSnapshotScanError extends TypeError {
  constructor(readonly executionIds: readonly string[]) {
    const shown = executionIds.slice(0, 5).join(", ");
    const more = executionIds.length > 5 ? ` (+${executionIds.length - 5} more)` : "";
    super(
      `sweepUnpinnedContent: ${executionIds.length} scanned snapshot(s) hold a sealed (whole-state encrypted) state (${shown}${more}), so the refs they cite are invisible and an erasing pass would delete live blobs: pass the decrypting snapshot store (the EncryptingSnapshotStore itself, not its inner store) in snapshotStores, or run with dryRun: true. Nothing was erased.`
    );
    this.name = "SealedSnapshotScanError";
    Object.setPrototypeOf(this, SealedSnapshotScanError.prototype);
  }
}

/**
 * Mark: walk every event of every execution across the given stores, collecting
 * each ref's latest citation timestamp, pinning refs cited from events of the
 * designated kinds, and marking refs cited anywhere other than as a
 * claim-check envelope's `ref` (a `digest` included) as load-bearing. Sweep:
 * physically erase refs that are neither pinned nor load-bearing and whose
 * latest citation is older than the TTL — i.e. only refs cited solely as an
 * envelope's `ref`. Their erasure is invisible to replay by the claim-check
 * contract (ADR 0054 — the fold never resolves); `resolveClaimCheck` readers get
 * `null`. A bare ref is never reclaimed while cited (ADR 0055 D4): the resolving
 * store would throw `ContentMissingError` on the next read. Idempotent:
 * `ContentStore.delete` is idempotent and a reclaimed ref simply no longer
 * resolves on the next sweep.
 *
 * Race-safe (ADR 0055 D5) when the store has `deleteIfUntouchedSince`: every erase is
 * conditional on the blob being untouched since `now − olderThanMs`, so a `put` that re-cites
 * old bytes between the scan and its own append keeps the blob. That holds while a flow's
 * put→append window is shorter than the TTL. A citation copied without a `put` (a fork's
 * `copyPrefix`, a ref kept inside an `append` payload) is covered by SPI 1.4.0 `touch`, which
 * `reclaimOrphans` requires; see `reclaimOrphans`. `roots` (D7) pins addresses held outside the
 * log; `reclaimOrphans` (D6) also erases stored blobs nothing scanned cites. Cost:
 * O(events + blobs), all membership tests are Set/Map lookups.
 */
export async function sweepUnpinnedContent(
  options: ContentSweepOptions
): Promise<ContentSweepReport> {
  const store = options.contentStore;
  const requested = options.reclaimOrphans as unknown;
  if (requested !== undefined && requested !== false) {
    // A dry run erases nothing, so it needs no acknowledgement (any truthy value turns the
    // orphan pass on); the sweep that would ERASE must carry it.
    if (
      options.dryRun === true
        ? !requested
        : typeof requested !== "object" ||
          requested === null ||
          (requested as { completeScan?: unknown }).completeScan !== true
    ) {
      throw new ReclaimOrphansAckError(requested);
    }
  }
  const orphans = requested !== undefined && requested !== false;
  if (orphans && store.listPage === undefined) {
    throw new TypeError(
      "sweepUnpinnedContent: reclaimOrphans needs a content store with listPage() (ContentStore SPI 1.3.0) — orphans cannot be found without enumerating the store"
    );
  }
  if (orphans && store.deleteIfUntouchedSince === undefined) {
    throw new TypeError(
      "sweepUnpinnedContent: reclaimOrphans needs a content store with deleteIfUntouchedSince() (ContentStore SPI 1.3.0) — a plain delete of a listed orphan loses a blob re-put since the listing"
    );
  }
  if (orphans && options.dryRun !== true && store.touch === undefined) {
    throw new ReclaimOrphansTouchError();
  }
  if (
    orphans &&
    options.dryRun !== true &&
    options.snapshotStores !== undefined &&
    (requested as { snapshotsTouchContent?: unknown }).snapshotsTouchContent !== true
  ) {
    throw new ReclaimOrphansSnapshotAckError();
  }
  if (orphans && options.dryRun !== true && store.touchClock === undefined) {
    throw new ReclaimOrphansClockError();
  }
  if (
    orphans &&
    options.snapshotStores === undefined &&
    options.eventStores.some(
      (s) => typeof (s as { truncatePrefix?: unknown }).truncatePrefix === "function"
    )
  ) {
    throw new TypeError(
      "sweepUnpinnedContent: reclaimOrphans over an event store that can truncatePrefix needs snapshotStores — a compacted prefix's refs live only in its snapshot, and without it they look like orphans"
    );
  }
  const snapshotList = options.snapshotStores ?? [];
  const snapshotStoresTouching = snapshotList.filter(isContentTouchingSnapshotStore).length;
  const snapshotStoresUnbranded = snapshotList.length - snapshotStoresTouching;
  if (
    orphans &&
    options.dryRun !== true &&
    snapshotStoresTouching > 0 &&
    snapshotStoresUnbranded > 0
  ) {
    emitUnwrappedWarning(snapshotStoresTouching, snapshotStoresUnbranded);
  }
  // ADR 0055 D5 — the guard cutoff is on the STORE's clock, read once at the START: a blob
  // touched after it (a re-citing put the scan could not see yet) is refused. The TTL on the
  // log (`now`) is a different clock and never feeds it.
  const raceSafe = store.deleteIfUntouchedSince !== undefined;
  let cutoff = Number.NEGATIVE_INFINITY;
  if (raceSafe) {
    if (options.touchedBefore !== undefined) {
      cutoff = options.touchedBefore;
    } else if (store.touchClock !== undefined) {
      cutoff = (await store.touchClock()) - options.olderThanMs;
    } else {
      throw new TypeError(
        "sweepUnpinnedContent: the content store has deleteIfUntouchedSince() but no touchClock() — pass touchedBefore (a cutoff on the store's clock) explicitly"
      );
    }
  }
  const dryRun = options.dryRun === true;
  if (orphans && !dryRun) {
    // The touch protects a write only while its touch-to-commit window is shorter than the
    // margin between the store's clock and the cutoff (module note; ADR 0055 D6 amendment 2).
    if (!(options.olderThanMs > 0)) throw new ReclaimOrphansMarginError(options.olderThanMs);
    const margin = (await store.touchClock!()) - cutoff;
    if (!(margin >= MIN_ORPHAN_ERASE_MARGIN_MS)) throw new ReclaimOrphansMarginError(margin);
  }
  /** Erase one address; `true` iff it is gone because of this sweep (or would be). */
  const erase = async (address: string): Promise<boolean> => {
    if (dryRun) return true;
    const ref = { __loomContent: address };
    if (store.deleteIfUntouchedSince !== undefined) {
      return store.deleteIfUntouchedSince(ref, cutoff);
    }
    await store.delete(ref);
    return true;
  };

  // Mark memory is O(distinct cited addresses): one Map entry per address plus the Sets.
  const pinnedKinds = new Set(options.pinnedEventTypes);
  const lastCited = new Map<string, number>();
  const pinned = new Set<string>();
  const loadBearing = new Set<string>();
  let executionsScanned = 0;
  const uncovered: string[] = [];
  const sealedSnapshots: string[] = [];

  for (const eventStore of options.eventStores) {
    if (eventStore.listExecutions === undefined && eventStore.listExecutionsPage === undefined) {
      throw new TypeError(
        "sweepUnpinnedContent: every event store must support listExecutionsPage() or listExecutions() — a store that cannot be enumerated cannot be swept safely"
      );
    }
    for await (const executionId of iterateExecutionIds(eventStore)) {
      executionsScanned++;
      const events = await eventStore.read(executionId);
      for (const event of events) {
        visitCitedAddresses(event.payload, (address, inEnvelope) => {
          const prior = lastCited.get(address);
          if (prior === undefined || event.timestamp > prior) {
            lastCited.set(address, event.timestamp);
          }
          if (pinnedKinds.has(event.eventType)) pinned.add(address);
          if (!inEnvelope) loadBearing.add(address);
        });
      }
      // Did compaction touch this log, and where is its checkpoint (ADR 0106)? Compaction
      // removes its checkpoint's own slot and, whenever it keeps pinned-kind events, never
      // the tip (the tip rule). So a gap-free log with more than the bootstrap was never
      // compacted and costs no snapshot read; a gapped log's checkpoint sits at its highest
      // missing sequence `gap`; and a bootstrap-only log was compacted through its tip (or
      // never got past its bootstrap), its checkpoint above the tip.
      if (events.length === 0) continue;
      const tipSequence = events[events.length - 1]!.sequence;
      const gap = highestMissingSequence(events);
      const bootstrapOnly = events.length === 1;
      if (gap < 0 && !bootstrapOnly) continue;
      if (options.snapshotStores === undefined) {
        if (gap >= 0) uncovered.push(executionId); // a gap is log evidence
        continue;
      }
      const pin = (snapshot: { state: unknown }): void => {
        const st = snapshot.state;
        if (typeof st === "object" && st !== null && "__loomEnc" in st) {
          if (!sealedSnapshots.includes(executionId)) sealedSnapshots.push(executionId);
        }
        visitCitedAddresses(snapshot.state, (address) => {
          if (!lastCited.has(address)) lastCited.set(address, Number.POSITIVE_INFINITY);
          pinned.add(address);
        });
      };
      let covered = false;
      for (const snapshots of options.snapshotStores) {
        const latest = await snapshots.loadLatest(executionId);
        if (latest !== null && latest.sequence >= 1) pin(latest);
        if (bootstrapOnly) {
          // Compacted at the tip: the checkpoint IS the latest snapshot.
          if (latest !== null && latest.sequence >= 1) covered = true;
          continue;
        }
        // The checkpoint: the LOWEST snapshot in [gap, tip] — any snapshot at or above the gap
        // covers a lost checkpoint, exactly as `compact` accepts a base at or above it. A
        // compaction's own sits exactly at `gap` (one read). A child forked from a compacted
        // parent copies the gap, and its lowest snapshot is its fork seed, whose sequence the
        // copied envelopes record (`metadata.forkSequence`): one exact read. Only a log with
        // neither walks the snapshots down from the tip.
        let checkpoint = await snapshots.loadLatestBefore(executionId, gap);
        const forkSequence = (events[0]!.metadata as { forkSequence?: unknown } | undefined)
          ?.forkSequence;
        if (
          (checkpoint === null || checkpoint.sequence !== gap) &&
          typeof forkSequence === "number" &&
          forkSequence >= gap
        ) {
          const seed =
            snapshots.loadAt !== undefined
              ? await snapshots.loadAt(executionId, forkSequence)
              : await snapshots.loadLatestBefore(executionId, forkSequence);
          checkpoint = seed !== null && seed.sequence === forkSequence ? seed : checkpoint;
        }
        if (checkpoint === null || checkpoint.sequence < gap) {
          checkpoint = null;
          let s = await snapshots.loadLatestBefore(executionId, tipSequence);
          while (s !== null && s.sequence >= gap) {
            checkpoint = s;
            s =
              s.sequence > gap
                ? await snapshots.loadLatestBefore(executionId, s.sequence - 1)
                : null;
          }
        }
        if (checkpoint !== null) {
          pin(checkpoint);
          covered = true;
        }
      }
      if (!covered) uncovered.push(executionId);
    }
  }
  if (!dryRun && sealedSnapshots.length > 0) throw new SealedSnapshotScanError(sealedSnapshots);
  if (orphans && uncovered.length > 0) {
    const shown = uncovered.slice(0, 5).join(", ");
    const more = uncovered.length > 5 ? ` (+${uncovered.length - 5} more)` : "";
    throw new TypeError(
      `sweepUnpinnedContent: ${uncovered.length} execution(s) look compacted but no checkpoint in snapshotStores covers them (${shown}${more}) — their prefix refs cannot be seen, so reclaimOrphans refuses before erasing anything. A run that never got past its bootstrap looks the same: let it progress, or pass the snapshot store its checkpoint went to (each archive's too)`
    );
  }

  // ADR 0055 D7 — external root sets pin like a pinned event kind does.
  const roots = new Set<string>();
  if (options.roots !== undefined) {
    for await (const address of options.roots()) roots.add(address);
  }

  const reclaimed: string[] = [];
  for (const [address, citedAt] of lastCited) {
    if (pinned.has(address) || loadBearing.has(address) || roots.has(address)) continue;
    if (options.now - citedAt < options.olderThanMs) continue;
    if (await erase(address)) reclaimed.push(address);
  }

  // ADR 0055 D6 — orphans: stored, untouched since the cutoff, and cited by nothing scanned.
  // `pinned` and `loadBearing` are subsets of `lastCited`, so two Set lookups decide.
  // Keyset paging on address: erasing entries of a page never skips a later one.
  const orphansReclaimed: string[] = [];
  if (orphans) {
    let cursor: string | undefined;
    do {
      const page = await store.listPage!({
        ...(cursor !== undefined && { cursor }),
        limit: ORPHAN_PAGE_LIMIT,
        touchedBefore: cutoff,
      });
      for (const { address, touchedAt } of page.entries) {
        // 0 = UNKNOWN: the column default a pre-1.3.0 writer leaves during a mixed rollout.
        if (!(touchedAt > 0)) continue;
        if (lastCited.has(address) || roots.has(address)) continue;
        if (await erase(address)) orphansReclaimed.push(address);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }

  return {
    executionsScanned,
    refsSeen: lastCited.size,
    refsPinned: pinned.size,
    refsLoadBearing: loadBearing.size,
    reclaimed,
    raceSafe,
    orphansReclaimed,
    snapshotStoresTouching,
    snapshotStoresUnbranded,
    sealedSnapshots,
  };
}
