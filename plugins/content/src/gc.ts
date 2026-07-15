import type { EventStore } from "@loom/event-runtime";
import { isClaimCheck } from "@loom/middleware";
import type { ContentStore } from "./ContentStore";

// ── K10.5 (ADR 0055) — pinned mark-and-sweep for claim-checked content ────────
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

/** Recursively collect claim-check content addresses out of an event payload. */
function collectClaimCheckRefs(value: unknown, visit: (address: string) => void): void {
  if (isClaimCheck(value)) {
    visit(value.ref.__loomContent); // the envelope is a leaf — digests are projections, not containers
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectClaimCheckRefs(item, visit);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectClaimCheckRefs(item, visit);
  }
}

/**
 * A {@link PinPredicate} for `LogLifecycle` (K10.5): pin any execution whose log
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
   * archive stores. All must support `listExecutions()`: a store that cannot be
   * enumerated cannot be swept safely (its pins would be invisible), so the
   * sweep refuses rather than silently under-pinning.
   */
  eventStores: readonly Pick<EventStore, "read" | "listExecutions">[];
  contentStore: Pick<ContentStore, "delete">;
  /** Event kinds whose cited refs are pinned — retained as long as the citing fact exists. */
  pinnedEventTypes: Iterable<string>;
  /** Reclaim an unpinned ref only when its latest citation is older than this. */
  olderThanMs: number;
  now: number;
}

export interface ContentSweepReport {
  executionsScanned: number;
  refsSeen: number;
  refsPinned: number;
  /** Content addresses whose bytes were physically erased this sweep. */
  reclaimed: string[];
}

/**
 * Mark: walk every event of every execution across the given stores, collecting
 * each claim-check ref's latest citation timestamp, and pinning refs cited from
 * events of the designated kinds. Sweep: physically erase unpinned refs whose
 * latest citation is older than the TTL. Erasure is invisible to replay by the
 * claim-check contract (ADR 0054 — the fold never resolves); `resolveClaimCheck`
 * readers get `null`. Idempotent: `ContentStore.delete` is idempotent and a
 * reclaimed ref simply no longer resolves on the next sweep.
 */
export async function sweepUnpinnedContent(
  options: ContentSweepOptions
): Promise<ContentSweepReport> {
  const pinnedKinds = new Set(options.pinnedEventTypes);
  const lastCited = new Map<string, number>();
  const pinned = new Set<string>();
  let executionsScanned = 0;

  for (const store of options.eventStores) {
    if (store.listExecutions === undefined) {
      throw new TypeError(
        "sweepUnpinnedContent: every event store must support listExecutions() — a store that cannot be enumerated cannot be swept safely"
      );
    }
    for (const executionId of await store.listExecutions()) {
      executionsScanned++;
      for (const event of await store.read(executionId)) {
        collectClaimCheckRefs(event.payload, (address) => {
          const prior = lastCited.get(address);
          if (prior === undefined || event.timestamp > prior) {
            lastCited.set(address, event.timestamp);
          }
          if (pinnedKinds.has(event.eventType)) pinned.add(address);
        });
      }
    }
  }

  const reclaimed: string[] = [];
  for (const [address, citedAt] of lastCited) {
    if (pinned.has(address)) continue;
    if (options.now - citedAt < options.olderThanMs) continue;
    await options.contentStore.delete({ __loomContent: address });
    reclaimed.push(address);
  }
  return { executionsScanned, refsSeen: lastCited.size, refsPinned: pinned.size, reclaimed };
}
