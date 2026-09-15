import {
  type ExecutionEnumerable,
  type LeaseStore,
  iterateExecutionIds,
} from "@loom/event-runtime";
import type { TimerDispatcher } from "./TimerService";
import type { WorkflowRuntime } from "./WorkflowRuntime";
import { type HeldLease, defaultRenewEvery, renewWhileHeld } from "./leaseRenewal";
import { placementOf } from "./placement";
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
  source?: ExecutionEnumerable;
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
  isAbandoned?: (candidate: AbandonedCandidate) => boolean | Promise<boolean>;
  /**
   * #380 — recover from EVIDENCE instead of a predicate.
   *
   * With a lease store, an orphan is no longer indistinguishable from a healthy execution:
   * an expired lease is a node that stopped saying it was alive. So `isAbandoned` becomes
   * OPTIONAL — pass it anyway to narrow further, and it is still asked — and the scan narrows
   * from "every execution" to "every expired lease", which is the set you actually wanted.
   *
   * The pass also CLAIMS each execution before re-driving it, so two recovery passes racing
   * the same orphan do not both pay for it.
   */
  leases?: {
    store: LeaseStore;
    /** This node's identity, recorded as the new owner while it recovers. */
    owner: string;
    /** How long to hold ownership while re-driving, renewed for as long as it takes. Default 60s. */
    ttlMs?: number;
    /** How often to renew while holding. Default `ttlMs / 3`. */
    renewEveryMs?: number;
  };
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
  /**
   * Called for every execution the pass SELECTED, in both modes — the dry run's answer, and
   * in a live run the record of what it was about to touch.
   */
  onCandidate?: (executionId: string) => void;
  /**
   * Select and report, changing nothing: no lease claimed, no execution re-driven.
   *
   * The preview deliberately runs through THIS function rather than beside it. A preview
   * computed alongside a pass is a preview that can disagree with it — `loom retention`
   * shipped exactly that bug, where the CLI's own dry run skipped a guard the real pass
   * applied, so it promised an outcome the run would not deliver.
   */
  dryRun?: boolean;
  onRecovered?: (executionId: string) => void;
  onError?: (executionId: string, err: unknown) => void;
  /**
   * #392 — re-drive through a placement seam rather than in this process. With a dispatcher,
   * each claimed execution is dispatched to the lane it was started in; without one, it is
   * resumed here, exactly as before.
   */
  dispatcher?: TimerDispatcher;
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
  if (options.leases === undefined && typeof options.isAbandoned !== "function") {
    throw new Error(
      "recoverAbandoned: `isAbandoned` is required — a running execution owned by a live " +
        "node is indistinguishable from an orphaned one in the log, so only the deployment " +
        "can decide. See ADR 0004. Wire `leases` instead and an expired lease answers it (#380)."
    );
  }
  if (options.leases === undefined && options.source === undefined) {
    throw new Error(
      "recoverAbandoned: pass `source` to enumerate executions, or `leases` to enumerate " +
        "expired leases — there is nothing to scan otherwise."
    );
  }
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const summary: RecoverAbandonedSummary = {
    scanned: 0,
    candidates: 0,
    recovered: 0,
    failed: 0,
  };

  for await (const executionId of candidateIds(options)) {
    // A dry run recovers nothing, so `recovered` would never reach the limit and the scan
    // would run to the end of the store. Bound the mode that is actually counting.
    if ((options.dryRun === true ? summary.candidates : summary.recovered) >= limit) break;
    summary.scanned++;

    const state = await runtime.loadState(executionId);
    if (state === null) continue;
    if (state.status !== "running" && state.status !== "pending") continue;
    summary.candidates++;

    // With leases, reaching here IS the evidence: this id came from `expired()`. A predicate
    // may still narrow it, and is asked when given — so it never becomes a lie.
    const claimed =
      options.isAbandoned === undefined
        ? true
        : await options.isAbandoned({
            executionId,
            workflowId: state.workflowId,
            status: state.status,
            updatedAt: state.updatedAt,
            startedAt: state.startedAt,
            sequence: state.sequence,
          });
    if (!claimed) continue;
    options.onCandidate?.(executionId);

    // A dry run stops HERE, before the claim: acquiring a lease is a write, and it would
    // fence a real recovery pass out of the very execution it was about to take.
    if (options.dryRun === true) continue;

    // Take ownership before re-driving, so two passes racing the same orphan do not both pay
    // for it. Losing the race means someone else is already on it.
    let held: HeldLease | undefined;
    if (options.leases !== undefined) {
      const ttlMs = options.leases.ttlMs ?? 60_000;
      const lease = await options.leases.store.acquire(executionId, options.leases.owner, ttlMs);
      if (lease === null) continue;
      // Held across the re-drive below, which awaits the recovered execution settling. An
      // unrenewed claim would expire under this very pass and invite the NEXT one to fence
      // us out of the recovery we are performing.
      held = renewWhileHeld(
        options.leases.store,
        executionId,
        options.leases.owner,
        ttlMs,
        options.leases.renewEveryMs ?? defaultRenewEvery(ttlMs),
        (err) => options.onError?.(executionId, err)
      );
    }

    try {
      // Re-check immediately before acting: the predicate may have awaited, and the
      // execution may have completed or suspended in the meantime. Re-driving a settled
      // execution is not corrupting (the worker's own recovery branch returns it as-is),
      // but it is pointless work and a misleading `recovered` count.
      const fresh = await runtime.loadState(executionId);
      if (fresh === null || (fresh.status !== "running" && fresh.status !== "pending")) continue;

      const fence = options.fenced ? await runtime.acquireFence(executionId) : undefined;
      const resumeEvent = { eventType: EXECUTION_RECOVERED, payload: {} };

      if (options.dispatcher !== undefined) {
        // #392 — re-drive where the execution belongs, not on whichever node happens to be
        // running the recovery pass. The recorded target is a HINT, and that matters more
        // here than anywhere else: a node is often recovering an execution precisely
        // BECAUSE its original lane went away, so the placement policy gets the last word
        // and an unregistered target falls back rather than stranding the orphan.
        const target = await placementOf(runtime.events, executionId);
        await options.dispatcher.dispatch(
          {
            executionId,
            workflowId: fresh.workflowId,
            flowId: fresh.workflowId,
            resumeEvent,
            ...(fence !== undefined && { metadata: { fence } }),
          },
          target !== undefined ? { target } : undefined
        );
      } else {
        const handle = await runtime.resume(
          executionId,
          resumeEvent,
          fence !== undefined ? { fence } : undefined
        );
        // Settle before moving on, so the pass applies backpressure instead of stampeding
        // every orphan into the runtime at once.
        await Promise.race([
          handle.waitForSuspend().catch(() => undefined),
          handle.waitForCompletion().catch(() => undefined),
        ]);
      }
      summary.recovered++;
      options.onRecovered?.(executionId);
    } catch (err) {
      // Left in place; the next pass retries (at-least-once).
      summary.failed++;
      options.onError?.(executionId, err);
    } finally {
      // Stop renewing whatever happened: the re-drive has settled, failed, or thrown, and a
      // claim outliving the work it covers blocks whoever legitimately takes it next.
      held?.stop();
    }
  }

  return summary;
}

/**
 * What to consider. With a lease store the candidate set is exactly the expired leases —
 * narrower and cheaper than walking every execution, and the reason the predicate can go.
 */
async function* candidateIds(options: RecoverAbandonedOptions): AsyncGenerator<string> {
  if (options.leases !== undefined) {
    for (const lease of await options.leases.store.expired(Date.now(), options.pageSize ?? 1000)) {
      yield lease.executionId;
    }
    return;
  }
  // Guarded above: without leases, `source` is required.
  yield* iterateExecutionIds(options.source as ExecutionEnumerable, options.pageSize);
}
