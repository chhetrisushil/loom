import type { EventEnvelope } from "@loom/core";
import {
  type ExecutionEnumerable,
  type LeaseStore,
  isReservedStream,
  iterateExecutionIds,
  readRangeOf,
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
  /**
   * ADR 0105 — skip an execution whose last `maxRecoveries` re-drives made NO progress. The
   * count is CONSECUTIVE: the `EXECUTION_RECOVERED` events at the tail of the log since its
   * last sign of progress (`STEP_COMPLETED`, `EXECUTION_SUSPENDED` or `EXECUTION_RESUMED`), so a
   * healthy long-lived execution recovered many times over its life, each time moving on, is
   * never stranded — only one that crashes its re-drive the same way every time (a poison
   * step, an error text its store refuses) is. Read from the log, so the bound holds across
   * passes, processes and nodes.
   *
   * Checked only for an execution the predicate (or an expired lease) already claimed, and
   * before this pass claims a lease, so a live execution is never reported and nothing needs
   * releasing. Skipped executions are counted in `exhausted` and reported through
   * `onExhausted`; they stay `running` for an operator (cancel, or fix and re-drive), and are
   * reported again by the next pass. Must be ≥ 1. Default: unbounded, as before.
   *
   * Cost: a backward read of the log's tail in pages, stopping at the first progress event or
   * the bound — O(tail since progress), not O(log). A store without `readRange` gets one bounded
   * `readFrom` of the last `maxRecoveries × 256` events instead (it can only undercount). Compaction (`truncatePrefix`) can only
   * shorten the tail it sees, so it can undercount (re-drive once more), never overcount.
   */
  maxRecoveries?: number;
  /** Called for each claimed candidate skipped because it reached `maxRecoveries`. */
  onExhausted?: (executionId: string, recoveries: number) => void;
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
  /** Claimed candidates skipped: `maxRecoveries` consecutive re-drives made no progress. */
  exhausted: number;
  /**
   * ADR 0110 D5 — parked executions whose inbox notify path delivered a message (a wake a crashed
   * sender or owner never completed). Present only when at least one was woken.
   */
  inboxWoken?: number;
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
    exhausted: 0,
  };
  const maxRecoveries = options.maxRecoveries;
  if (maxRecoveries !== undefined && (!Number.isSafeInteger(maxRecoveries) || maxRecoveries < 1)) {
    // 0 would skip every candidate: a pass that recovers nothing while reading as if it ran.
    throw new Error("recoverAbandoned: `maxRecoveries` must be an integer ≥ 1");
  }

  for await (const executionId of candidateIds(options)) {
    // A dry run recovers nothing, so `recovered` would never reach the limit and the scan
    // would run to the end of the store. Bound the mode that is actually counting.
    if ((options.dryRun === true ? summary.candidates : summary.recovered) >= limit) break;
    // A reserved control stream (retention trail, an inbox stream) is no execution: folded it
    // reads `pending`, and re-driving it would be refused (ADR 0110: inbox streams are common).
    if (isReservedStream(executionId)) continue;
    summary.scanned++;

    const state = await runtime.loadState(executionId, runtime.systemOptions());
    if (state === null) continue;
    // ADR 0110 D5 — a PARKED execution with an inbox wait: any node's pass runs the notify path, so
    // a wake lost with a crashed sender or owner is not lost for good. Idempotent and fenced.
    if (
      state.status === "suspended" &&
      options.dryRun !== true &&
      options.source !== undefined &&
      runtime.hasInboxWake(state)
    ) {
      try {
        const woke = await runtime.notifyInboxDetailed(executionId);
        if (woke.handle !== undefined) {
          summary.inboxWoken = (summary.inboxWoken ?? 0) + 1;
          await Promise.race([
            woke.handle.waitForSuspend().catch(() => undefined),
            woke.handle.waitForCompletion().catch(() => undefined),
          ]);
        }
      } catch (err) {
        options.onError?.(executionId, err);
      }
      continue;
    }
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

    if (maxRecoveries !== undefined) {
      const recoveries = await unproductiveRecoveries(
        runtime,
        executionId,
        state.sequence,
        maxRecoveries
      );
      if (recoveries >= maxRecoveries) {
        summary.exhausted++;
        options.onExhausted?.(executionId, recoveries);
        continue;
      }
    }
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
      const fresh = await runtime.loadState(executionId, runtime.systemOptions());
      if (fresh === null || (fresh.status !== "running" && fresh.status !== "pending")) continue;

      const fence = options.fenced
        ? await runtime.acquireFence(executionId, runtime.systemOptions())
        : undefined;
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
        const handle = await runtime.resume(executionId, resumeEvent, {
          ...(fence !== undefined && { fence }),
          ...runtime.systemOptions(),
        });
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
    for (const lease of await options.leases.store.expired(
      // The store's OWN clock (L28): it stamped `expiresAt` in acquire/renew, so it must judge it.
      undefined,
      options.pageSize ?? 1000
    )) {
      yield lease.executionId;
    }
    return;
  }
  // Guarded above: without leases, `source` is required.
  yield* iterateExecutionIds(options.source as ExecutionEnumerable, options.pageSize);
}

/** A re-drive that got somewhere: a step finished, or the flow reached (or passed) a gate. */
const PROGRESS = new Set(["STEP_COMPLETED", "EXECUTION_SUSPENDED", "EXECUTION_RESUMED"]);
const TAIL_PAGE = 256;

/**
 * `EXECUTION_RECOVERED` events since the log's last progress event, counted up to `cap` (enough
 * to decide). With `readRange` it reads the tail backwards in pages from `head`, so the cost is
 * the events since progress, not the log. A store without `readRange` would turn each page into
 * a `readFrom` to the END of the log (quadratic in the tail), so it gets ONE bounded read
 * instead: the last `cap × TAIL_PAGE` events. A re-drive that writes more than `TAIL_PAGE`
 * events between recoveries can then be undercounted — one more re-drive, never a false skip.
 */
async function unproductiveRecoveries(
  runtime: WorkflowRuntime,
  executionId: string,
  head: number,
  cap: number
): Promise<number> {
  const store = runtime.events;
  let n = 0;
  // Returns the count once decided, or undefined to keep reading.
  const scan = (page: readonly EventEnvelope[]): number | undefined => {
    for (let i = page.length - 1; i >= 0; i--) {
      const type = (page[i] as EventEnvelope).eventType;
      if (PROGRESS.has(type)) return n;
      if (type === EXECUTION_RECOVERED && ++n >= cap) return n;
    }
    return undefined;
  };
  if (store.readRange === undefined) {
    const window = await store.readFrom(executionId, Math.max(0, head - cap * TAIL_PAGE + 1));
    return scan(window) ?? n;
  }
  for (let hi = head; hi >= 0; hi -= TAIL_PAGE) {
    const page = await readRangeOf(store, executionId, Math.max(0, hi - TAIL_PAGE + 1), hi);
    if (page.length === 0) break; // below a truncated prefix
    const decided = scan(page);
    if (decided !== undefined) return decided;
  }
  return n;
}
