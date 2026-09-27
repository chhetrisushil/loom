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
// Only a ref held INSIDE a claim-check envelope is TTL-reclaimable (ADR 0055 D4).
// A bare ref is load-bearing: `ContentResolvingEventStore.read` resolves every
// bare ref in a payload and throws `ContentMissingError` when its blob is gone,
// so erasing one bricks the execution (resume, replay, fork, export). The raw
// log cannot say which bare refs a resolving store will resolve, so every bare
// ref is retained while any scanned event cites it.

/**
 * Collect content addresses out of an event payload. Any object carrying a
 * string `__loomContent` is a ref leaf — this covers bare ADR 0046
 * `ContentRef`s (e.g. a finding's `evidence` list, an externalized field) AND
 * ADR 0054 claim-check envelopes (whose `ref` field is such an object, found by
 * descent). `inEnvelope` is true for a leaf below an object whose
 * `__loomClaimCheck === true` — the one context where erasure is replay-invisible.
 *
 * Iterative with cycle detection: the sweep is a retention job over
 * app-controlled payloads, so a pathologically deep (or, from an in-memory
 * store, cyclic) value must not stack-overflow the pass (audit W8).
 */
function collectContentRefs(
  value: unknown,
  visit: (address: string, inEnvelope: boolean) => void
): void {
  const stack: [unknown, boolean][] = [[value, false]];
  // The cycle guard is keyed on (object, context): a bare visit dominates an envelope
  // visit (it marks everything below as load-bearing), but NOT the other way round — an
  // object an in-memory payload aliases at an envelope site AND a bare site must still be
  // seen bare. So each object is expanded at most twice: still O(payload), still finite.
  const seenBare = new WeakSet<object>();
  const seenInEnvelope = new WeakSet<object>();
  while (stack.length > 0) {
    const [current, inEnvelope] = stack.pop() as [unknown, boolean];
    if (typeof current !== "object" || current === null) continue;
    const inside =
      inEnvelope || (current as { __loomClaimCheck?: unknown }).__loomClaimCheck === true;
    if (seenBare.has(current)) continue;
    if (inside) {
      if (seenInEnvelope.has(current)) continue;
      seenInEnvelope.add(current);
    } else {
      seenBare.add(current);
    }
    const address = (current as { __loomContent?: unknown }).__loomContent;
    if (typeof address === "string") {
      visit(address, inside);
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push([item, inside]);
    } else {
      for (const item of Object.values(current)) stack.push([item, inside]);
    }
  }
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
   */
  eventStores: readonly (Pick<EventStore, "read"> & ExecutionEnumerable)[];
  contentStore: Pick<ContentStore, "delete">;
  /** Event kinds whose cited refs are pinned — retained as long as the citing fact exists. */
  pinnedEventTypes: Iterable<string>;
  /** Reclaim an unpinned ref only when its latest citation is older than this. */
  olderThanMs: number;
  now: number;
  /**
   * DX-2 — report what WOULD be reclaimed without deleting anything (the
   * `loom sweep content` operator default; `--apply` turns it off).
   */
  dryRun?: boolean;
}

export interface ContentSweepReport {
  executionsScanned: number;
  refsSeen: number;
  refsPinned: number;
  /**
   * ADR 0055 D4 — refs cited at least once OUTSIDE a claim-check envelope. These are
   * load-bearing and are never reclaimed while any scanned event cites them.
   */
  refsLoadBearing: number;
  /** Content addresses erased this sweep — or, under `dryRun`, that WOULD be. */
  reclaimed: string[];
}

/**
 * Mark: walk every event of every execution across the given stores, collecting
 * each ref's latest citation timestamp, pinning refs cited from events of the
 * designated kinds, and marking refs cited anywhere OUTSIDE a claim-check
 * envelope as load-bearing. Sweep: physically erase refs that are neither pinned
 * nor load-bearing and whose latest citation is older than the TTL — i.e. only
 * envelope-only refs. Their erasure is invisible to replay by the claim-check
 * contract (ADR 0054 — the fold never resolves); `resolveClaimCheck` readers get
 * `null`. A bare ref is never reclaimed while cited (ADR 0055 D4): the resolving
 * store would throw `ContentMissingError` on the next read. Idempotent:
 * `ContentStore.delete` is idempotent and a reclaimed ref simply no longer
 * resolves on the next sweep.
 */
export async function sweepUnpinnedContent(
  options: ContentSweepOptions
): Promise<ContentSweepReport> {
  const pinnedKinds = new Set(options.pinnedEventTypes);
  const lastCited = new Map<string, number>();
  const pinned = new Set<string>();
  const loadBearing = new Set<string>();
  let executionsScanned = 0;

  for (const store of options.eventStores) {
    if (store.listExecutions === undefined && store.listExecutionsPage === undefined) {
      throw new TypeError(
        "sweepUnpinnedContent: every event store must support listExecutionsPage() or listExecutions() — a store that cannot be enumerated cannot be swept safely"
      );
    }
    for await (const executionId of iterateExecutionIds(store)) {
      executionsScanned++;
      for (const event of await store.read(executionId)) {
        collectContentRefs(event.payload, (address, inEnvelope) => {
          const prior = lastCited.get(address);
          if (prior === undefined || event.timestamp > prior) {
            lastCited.set(address, event.timestamp);
          }
          if (pinnedKinds.has(event.eventType)) pinned.add(address);
          if (!inEnvelope) loadBearing.add(address);
        });
      }
    }
  }

  const reclaimed: string[] = [];
  for (const [address, citedAt] of lastCited) {
    if (pinned.has(address) || loadBearing.has(address)) continue;
    if (options.now - citedAt < options.olderThanMs) continue;
    if (options.dryRun !== true) {
      await options.contentStore.delete({ __loomContent: address });
    }
    reclaimed.push(address);
  }
  return {
    executionsScanned,
    refsSeen: lastCited.size,
    refsPinned: pinned.size,
    refsLoadBearing: loadBearing.size,
    reclaimed,
  };
}
