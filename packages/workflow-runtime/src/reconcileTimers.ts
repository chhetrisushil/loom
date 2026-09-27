import {
  type ExecutionEnumerable,
  type TimerStore,
  iterateExecutionIds,
} from "@loom/event-runtime";
import type { CensusStateReader } from "./orphanCensus";

// ── ADR 0105 — re-arm timed parks whose timer row is gone ─────────────────────
//
// A timed park (`ctx.sleep`, `suspend({ timeout })` with a timer store wired) is two records:
// `suspendedOn.wakeAt` in the log, and a row in the TimerStore that makes the wake findable.
// `TimerService` retires a row when its execution no longer waits on it — "resumed by other
// means, terminal, unknown". Before EVENT_SCHEMA 1.21.0 a parallel sibling's STEP_FAILED after
// the park folded the execution to "failed", so the service retired that row as OBSOLETE. After
// the fold was fixed the execution reads `suspended` again, with a past `wakeAt` and no row:
// nothing will ever wake it.
//
// This pass puts the rows back. It needs no comparison with the store: `TimerStore.schedule` is
// idempotent per (executionId, wakeAt), so re-asserting the row of every execution that is
// suspended on a wake time is a no-op for a healthy one and a repair for a stranded one. A row
// re-asserted for a wake that is already due fires on the service's next poll, and the service's
// own still-waiting guard makes any duplicate a no-op. Run it once after upgrading (it is safe
// to run any time), then let `TimerService` do the rest.

export interface ReconcileTimersOptions {
  /** The store to enumerate. Needs `listExecutionsPage` or `listExecutions`. */
  source: ExecutionEnumerable;
  /** The TimerStore your `TimerService` polls. */
  timers: TimerStore;
  /** Count, schedule nothing. */
  dryRun?: boolean;
  pageSize?: number;
  /** Called for every timed park whose row was (or, dry, would be) re-asserted. */
  onTimedPark?: (executionId: string, wakeAt: number) => void;
}

export interface ReconcileTimersSummary {
  /** Executions enumerated. */
  scanned: number;
  /** Those suspended on a wake time — every one has had its timer row re-asserted. */
  timedParks: number;
  /** Rows written (0 on a dry run). Idempotent, so this is re-asserted, not necessarily new. */
  scheduled: number;
}

/**
 * Re-assert the timer row of every execution suspended on a `wakeAt`. Idempotent; the only
 * writes are `TimerStore.schedule` calls, which the store dedupes per (executionId, wakeAt).
 */
export async function reconcileTimers(
  reader: CensusStateReader,
  options: ReconcileTimersOptions
): Promise<ReconcileTimersSummary> {
  const summary: ReconcileTimersSummary = { scanned: 0, timedParks: 0, scheduled: 0 };
  for await (const executionId of iterateExecutionIds(options.source, options.pageSize)) {
    summary.scanned++;
    const state = await reader.loadState(executionId);
    const wakeAt = state?.suspendedOn?.wakeAt;
    if (state?.status !== "suspended" || typeof wakeAt !== "number") continue;
    summary.timedParks++;
    options.onTimedPark?.(executionId, wakeAt);
    if (options.dryRun === true) continue;
    await options.timers.schedule({ executionId, wakeAt });
    summary.scheduled++;
  }
  return summary;
}
