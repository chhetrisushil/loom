import { type ExecutionEnumerable, iterateExecutionIds } from "@loom/event-runtime";
import type { WorkflowRuntime } from "./WorkflowRuntime";
import { EXECUTION_RECOVERED } from "./types";

// ── Recovering executions whose supervisor died ───────────────────────────────
//
// [ADR 0004](../../../docs/adr/0004-failure-recovery.md) already recovers a dead or wedged
// WORKER: the dispatcher's `executeTimeoutMs` turns a hung attempt into a failed one,
// redispatches, and the worker resumes idempotently from durable state. That path is not
// replaced here and should be preferred — it needs no policy from the caller.
//
// What it cannot cover is the SUPERVISOR itself dying. Detection lives in the dispatcher's
// process memory (an awaited deadline), so if the process holding it is killed, nothing
// survives that knows an execution was in flight. The execution stays `running` in the log
// with no owner, and no amount of reading that log reveals it — because a healthy execution
// running on another node looks exactly the same.
//
// That ambiguity is the whole problem, and Loom cannot resolve it: only the deployment knows
// whether a given node is alive. So this pass does everything EXCEPT decide, and takes the
// decision from the caller as `isAbandoned`. It is a maintenance pass you schedule (a cron,
// a Kubernetes Job, a leader-elected ticker), not a service that runs itself — the same
// shape as every other maintenance pass over `iterateExecutionIds`.

/**
 * An execution that is `running`/`pending` in the durable log. Whether that means "healthy,
 * owned by a live node" or "orphaned by a dead one" is exactly what {@link
 * RecoverAbandonedOptions.isAbandoned} must decide.
 */
export interface AbandonedCandidate {
  executionId: string;
  workflowId: string;
  /** Only ever `"running"` or `"pending"` — terminal and suspended states never reach the predicate. */
  status: string;
  /** Wall-clock ms of the newest folded event. The usual basis for a staleness rule. */
  updatedAt: number;
  startedAt: number;
  /** Sequence of the newest folded event — useful to confirm progress between passes. */
  sequence: number;
}

export interface RecoverAbandonedOptions {
  /** The store to enumerate. Needs `listExecutionsPage` or `listExecutions`. */
  source: ExecutionEnumerable;
  /**
   * REQUIRED — decide whether a `running`/`pending` execution is genuinely orphaned.
   *
   * There is deliberately no default, and an absent predicate is a refusal rather than
   * "recover everything": a `running` execution that is healthy on another node is
   * indistinguishable, in the log, from one whose supervisor died. Defaulting to `true`
   * would preempt live work; defaulting to `false` would be a pass that silently never
   * recovers anything while reading as if it does.
   *
   * **Returning `true` for a live execution preempts it.** With fencing wired that is safe
   * for the log — the old worker's next write loses (K9.4) — but its in-flight effect may
   * still land, so the interrupted step can run twice. That is the same at-least-once
   * tradeoff ADR 0004 already accepts for a genuine crash; the difference is that a wrong
   * predicate pays it for a step that was never interrupted. Prefer a generous staleness
   * threshold, or a real liveness signal from your orchestrator.
   */
  isAbandoned: (candidate: AbandonedCandidate) => boolean | Promise<boolean>;
  /** Stop after this many successful recoveries. Default: unlimited. */
  limit?: number;
  /** Enumeration page size. Default 1000. */
  pageSize?: number;
  /**
   * K9.4 — acquire a newer fencing token before resuming, so a predecessor that is not
   * actually dead loses at the store instead of double-writing. Requires a fencing store.
   * Default `false`, matching {@link TimerService}.
   */
  fenced?: boolean;
  onRecovered?: (executionId: string) => void;
  onError?: (executionId: string, err: unknown) => void;
}

export interface RecoverAbandonedSummary {
  /** Executions enumerated. */
  scanned: number;
  /** Those that were `running`/`pending`, i.e. that the predicate was asked about. */
  candidates: number;
  /** Those the predicate claimed, and which resumed without throwing. */
  recovered: number;
  /** Those the predicate claimed but whose resume threw (left for the next pass). */
  failed: number;
}

/**
 * One recovery pass: enumerate, ask `isAbandoned` about every `running`/`pending`
 * execution, and resume the ones it claims — using the same `EXECUTION_RECOVERED` path the
 * worker uses under redispatch (ADR 0004), so completed steps are served from the log and
 * only the interrupted tail re-executes.
 *
 * Idempotent and at-least-once: a resume that throws leaves the execution untouched for the
 * next pass, and status is re-checked immediately before acting, so an execution that
 * completed or suspended between enumeration and decision is skipped rather than re-driven.
 *
 * @example
 * // A cron-driven pass. "No event for 15 minutes" is a policy YOU own.
 * const STALE_MS = 15 * 60_000;
 * await recoverAbandoned(runtime, {
 *   source: eventStore,
 *   isAbandoned: (c) => Date.now() - c.updatedAt > STALE_MS,
 *   fenced: true,
 * });
 */
export async function recoverAbandoned(
  runtime: WorkflowRuntime,
  options: RecoverAbandonedOptions
): Promise<RecoverAbandonedSummary> {
  if (typeof options.isAbandoned !== "function") {
    throw new Error(
      "recoverAbandoned: `isAbandoned` is required — a running execution owned by a live " +
        "node is indistinguishable from an orphaned one in the log, so only the deployment " +
        "can decide. See ADR 0004."
    );
  }
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const summary: RecoverAbandonedSummary = {
    scanned: 0,
    candidates: 0,
    recovered: 0,
    failed: 0,
  };

  for await (const executionId of iterateExecutionIds(options.source, options.pageSize)) {
    if (summary.recovered >= limit) break;
    summary.scanned++;

    const state = await runtime.loadState(executionId);
    if (state === null) continue;
    if (state.status !== "running" && state.status !== "pending") continue;
    summary.candidates++;

    const claimed = await options.isAbandoned({
      executionId,
      workflowId: state.workflowId,
      status: state.status,
      updatedAt: state.updatedAt,
      startedAt: state.startedAt,
      sequence: state.sequence,
    });
    if (!claimed) continue;

    try {
      // Re-check immediately before acting: the predicate may have awaited, and the
      // execution may have completed or suspended in the meantime. Re-driving a settled
      // execution is not corrupting (the worker's own recovery branch returns it as-is),
      // but it is pointless work and a misleading `recovered` count.
      const fresh = await runtime.loadState(executionId);
      if (fresh === null || (fresh.status !== "running" && fresh.status !== "pending")) continue;

      const fence = options.fenced ? await runtime.acquireFence(executionId) : undefined;
      const handle = await runtime.resume(
        executionId,
        { eventType: EXECUTION_RECOVERED, payload: {} },
        fence !== undefined ? { fence } : undefined
      );
      // Settle before moving on, so the pass applies backpressure instead of stampeding
      // every orphan into the runtime at once.
      await Promise.race([
        handle.waitForSuspend().catch(() => undefined),
        handle.waitForCompletion().catch(() => undefined),
      ]);
      summary.recovered++;
      options.onRecovered?.(executionId);
    } catch (err) {
      // Left in place; the next pass retries (at-least-once).
      summary.failed++;
      options.onError?.(executionId, err);
    }
  }

  return summary;
}
