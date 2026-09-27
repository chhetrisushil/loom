import type { EventStore, ExecutionEnumerable } from "@loom/event-runtime";
import { iterateExecutionIds } from "@loom/event-runtime";
import type { ContentStore } from "./ContentStore";

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
 * The structural claim-check test, identical to `isClaimCheck` in `@loom/middleware`
 * (kept structural so this plugin takes no middleware dependency): the flag AND a string
 * `ref.__loomContent`. An app object that merely carries the flag is app data.
 */
function envelopeRef(value: object): string | undefined {
  if ((value as { __loomClaimCheck?: unknown }).__loomClaimCheck !== true) return undefined;
  const address = (value as { ref?: { __loomContent?: unknown } | null }).ref?.__loomContent;
  return typeof address === "string" ? address : undefined;
}

/**
 * Collect content addresses out of an event payload. Any object carrying a
 * string `__loomContent` is a ref leaf — this covers bare ADR 0046
 * `ContentRef`s (e.g. a finding's `evidence` list, an externalized field) AND
 * the `ref` of an ADR 0054 claim-check envelope. `inEnvelope` is true ONLY for
 * an envelope's own `ref` — the offloaded value, the one citation whose erasure
 * is replay-invisible (ADR 0055 D4). Every other envelope field (`digest` above
 * all: orchestration branches on it) is recorded, replay-visible data and is
 * walked in the envelope's own context like any other payload.
 *
 * Because the enveloped context never descends (the `ref` is a leaf), one
 * WeakSet cycle guard suffices: an object aliased at a bare site and as an
 * envelope's `ref` is still visited bare, since the envelope reports its ref
 * directly rather than through the guard.
 *
 * Iterative with cycle detection: the sweep is a retention job over
 * app-controlled payloads, so a pathologically deep (or, from an in-memory
 * store, cyclic) value must not stack-overflow the pass (audit W8).
 */
function collectContentRefs(
  value: unknown,
  visit: (address: string, inEnvelope: boolean) => void
): void {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== "object" || current === null) continue;
    if (seen.has(current)) continue;
    seen.add(current);
    const address = (current as { __loomContent?: unknown }).__loomContent;
    if (typeof address === "string") {
      visit(address, false);
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    const offloaded = envelopeRef(current);
    if (offloaded !== undefined) visit(offloaded, true);
    for (const [key, item] of Object.entries(current)) {
      if (offloaded !== undefined && key === "ref") continue;
      stack.push(item);
    }
  }
}

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

export interface ContentSweepOptions {
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
   * ARCHIVE'S snapshot store. `LogLifecycle.compact` checkpoints the fold at the tip and
   * truncates the prefix, so a ref the prefix cited survives only in snapshot state.
   *
   * For every execution whose log has no sequence-1 event, the sweep pins every ref in:
   *  - the COMPACTION CHECKPOINT, the snapshot at exactly `events[1].sequence − 1` (or, for a
   *    run compacted at its tip so only sequence 0 remains, its latest snapshot). `fork()`
   *    from any point after it loads that checkpoint, so its refs stay reachable even after a
   *    later snapshot overwrote them in state.
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
   *    snapshot at `events[1].sequence − 1`, and a sequence-0-only log with no snapshot, which
   *    is either compacted at its tip or a run that never got past its bootstrap. The two are
   *    indistinguishable, so both refuse.
   */
  snapshotStores?: readonly SnapshotLookup[];
  /**
   * The blob store. With `deleteIfUntouchedSince` (SPI 1.3.0) every erase is conditional on
   * the blob's touch time, which closes the re-cite race (ADR 0055 D5); without it the sweep
   * falls back to `delete` and reports `raceSafe: false`. `listPage` enables `reclaimOrphans`.
   */
  contentStore: Pick<ContentStore, "delete" | "deleteIfUntouchedSince" | "listPage" | "touchClock">;
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
   * HAZARD the sweep cannot detect: a citing store that was NOT passed in `eventStores`. Pass
   * every archive (`retention.archive`) — an archived finding's evidence is otherwise an
   * orphan, and this pass erases it.
   */
  reclaimOrphans?: boolean;
}

/** Structural view of a snapshot store: just `loadLatest` (no snapshot-runtime dependency). */
export interface SnapshotLookup {
  loadLatest(executionId: string): Promise<{ sequence: number; state: unknown } | null>;
  loadLatestBefore(
    executionId: string,
    sequence: number
  ): Promise<{ sequence: number; state: unknown } | null>;
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
 * put→append window is shorter than the TTL. `roots` (D7) pins addresses held outside the
 * log; `reclaimOrphans` (D6) also erases stored blobs nothing scanned cites. Cost:
 * O(events + blobs), all membership tests are Set/Map lookups.
 */
export async function sweepUnpinnedContent(
  options: ContentSweepOptions
): Promise<ContentSweepReport> {
  const store = options.contentStore;
  const orphans = options.reclaimOrphans === true;
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
        collectContentRefs(event.payload, (address, inEnvelope) => {
          const prior = lastCited.get(address);
          if (prior === undefined || event.timestamp > prior) {
            lastCited.set(address, event.timestamp);
          }
          if (pinnedKinds.has(event.eventType)) pinned.add(address);
          if (!inEnvelope) loadBearing.add(address);
        });
      }
      // Did compaction touch this log, and where is its checkpoint (ADR 0106)? Compaction
      // removes its checkpoint's own slot and keeps every event above it, plus the app's
      // pinned-kind events below it. So the checkpoint sits either at `gap` (the highest
      // sequence missing below the tip) or, when everything above `gap` is a pinned kind, may
      // lie above the tip (compacted at the tip). A contiguous log with any non-pinned event
      // after the bootstrap was never compacted and costs no snapshot read.
      if (events.length === 0) continue;
      const tipSequence = events[events.length - 1]!.sequence;
      const gap = highestMissingSequence(events);
      let onlyPinnedAbove = true;
      for (let i = events.length - 1; i > 0 && events[i]!.sequence > gap; i--) {
        if (!pinnedKinds.has(events[i]!.eventType)) {
          onlyPinnedAbove = false;
          break;
        }
      }
      if (gap < 0 && !onlyPinnedAbove) continue;
      if (options.snapshotStores === undefined) {
        if (gap >= 0) uncovered.push(executionId); // a gap is log evidence
        continue;
      }
      const pin = (snapshot: { state: unknown }): void =>
        collectContentRefs(snapshot.state, (address) => {
          if (!lastCited.has(address)) lastCited.set(address, Number.POSITIVE_INFINITY);
          pinned.add(address);
        });
      let covered = false;
      for (const snapshots of options.snapshotStores) {
        const latest = await snapshots.loadLatest(executionId);
        if (latest !== null && latest.sequence >= 1) pin(latest);
        // Compacted at the tip: the checkpoint IS the latest snapshot, above every event.
        if (onlyPinnedAbove && latest !== null && latest.sequence > tipSequence) covered = true;
        if (gap >= 0) {
          const checkpoint = await snapshots.loadLatestBefore(executionId, gap);
          if (checkpoint !== null && checkpoint.sequence === gap) {
            pin(checkpoint);
            covered = true;
          }
        }
      }
      if (!covered) uncovered.push(executionId);
    }
  }
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
  };
}
