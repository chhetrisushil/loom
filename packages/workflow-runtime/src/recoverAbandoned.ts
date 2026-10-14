import type { ExecutionState } from "@loom/core";
import {
  type ExecutionEnumerable,
  type LeaseStore,
  inboxChainOf,
  isReservedStream,
  iterateExecutionIds,
} from "@loom/event-runtime";
import type { TimerDispatcher } from "./TimerService";
import { redriveDelayMs } from "./TimerService";
import type { WorkflowRuntime } from "./WorkflowRuntime";
import { judgeLease } from "./leaseEvidence";
import { isHeuristicOwner } from "./leaseKeeper";
import { type HeldLease, defaultRenewEvery, renewWhileHeld } from "./leaseRenewal";
import {
  isSealedBackedOff,
  noteSealedRefusal,
  redriveAbandoned,
  unproductiveRecoveries,
} from "./redriveAbandoned";
import { isSealedUnreadable } from "./sealGuard";

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
  /** Messages the sweep expired by TTL (ADR 0110 D10a). */
  inboxExpired?: number;
  /** ADR 0110 D1 — inbox streams of a terminal owner that this pass deleted (crash orphans). */
  inboxReclaimed?: number;
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

  const expiredChains = new Set<string>();
  // ADR 0130 D11 (S7d): the owner of each expired lease the scan listed (lease mode), to tell a
  // `"continue"` node's heuristic lease from true evidence.
  const expiredOwners = new Map<string, string>();
  for await (const executionId of candidateIds(options, expiredOwners)) {
    // A dry run recovers nothing, so `recovered` would never reach the limit and the scan
    // would run to the end of the store. Bound the mode that is actually counting.
    if ((options.dryRun === true ? summary.candidates : summary.recovered) >= limit) break;
    // A reserved control stream (retention trail, an inbox stream) is no execution: folded it
    // reads `pending`, and re-driving it would be refused (ADR 0110: inbox streams are common).
    if (isReservedStream(executionId)) {
      // ADR 0110 D1 — an inbox stream whose owner is terminal is an orphan (a crash between a
      // sender's append and its re-read): reclaim it.
      if (options.dryRun !== true && (await runtime.reclaimInbox(executionId))) {
        summary.inboxReclaimed = (summary.inboxReclaimed ?? 0) + 1;
      } else if (options.dryRun !== true && runtime.inboxTtlOn) {
        // ADR 0110 D10a — the safety net for a lost expiry row (a sender that died between its append
        // and its row): one pass re-arms it. A chain id that maps to no execution (a fork's) is skipped.
        try {
          // One pass per CHAIN: its legacy, per-topic and registry streams all name it (ADR 0110 D10b).
          const chainId = inboxChainOf(executionId);
          if (chainId === undefined || expiredChains.has(chainId)) continue;
          expiredChains.add(chainId);
          const r = await runtime.expireInbox(chainId);
          if (r.expired > 0) summary.inboxExpired = (summary.inboxExpired ?? 0) + r.expired;
        } catch (err) {
          options.onError?.(executionId, err);
        }
      }
      continue;
    }
    summary.scanned++;

    if (sealedBackedOff(runtime, executionId)) continue; // ADR 0130: this node cannot open it
    let state: ExecutionState | null;
    try {
      state = await runtime.loadState(executionId, runtime.systemOptions());
    } catch (err) {
      // ADR 0130 residuals D7 - a stream this node cannot open (a marker it cannot open, a key it
      // does not hold): not recoverable HERE, and no reason to abort the pass. Back off, report
      // (first then every 16th), and leave it for a capable node.
      if (!isSealedUnreadable(err)) throw err;
      sealedRefusalBackoff(runtime, executionId, err, options);
      summary.failed++;
      continue;
    }
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
    // Defence in depth (ADR 0130 D11 review): THIS node is driving it (or starting it). Whatever a
    // heuristic or a lease says, re-driving what we drive ourselves is a double-enter - the keeper
    // answers TRUE for a lease its own owner already holds, so the claim below would not stop it.
    // Only with heartbeat leases: a keeper-less sweep keeps its documented power to supersede a hung
    // in-process run (fenced), which the placement/recovery contract relies on.
    if (runtime.leaseKeeper !== undefined && runtime.drivesLocally(executionId)) continue;

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
    // ADR 0130 D11 (S7d), lease mode: an expired lease of a `"continue"` node proves nothing; with no
    // predicate to vouch for it the execution is left alone (a predicate, when given, WAS asked above).
    if (options.isAbandoned === undefined && isHeuristicOwner(expiredOwners.get(executionId) ?? ""))
      continue;
    // The lease VETO (ADR 0130 D11 section 4) and the fail-closed read: a heuristic never preempts a
    // driver that heartbeats, and a lease store that errors is not "no lease". Only a runtime with a
    // heartbeat keeper (or lease mode) has leases to read; unwired it is today's pass, byte for byte.
    if (
      options.dryRun !== true &&
      (runtime.leaseKeeper !== undefined || options.leases !== undefined)
    ) {
      try {
        const j = await judgeLease(runtime, executionId, options.leases?.store);
        if (j.kind === "live" || j.kind === "quiet") continue;
      } catch (err) {
        summary.failed++;
        options.onError?.(executionId, err);
        continue;
      }
    }

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
    if (sealedBackedOff(runtime, executionId)) continue; // ADR 0130: this node cannot open it
    options.onCandidate?.(executionId);

    // A dry run stops HERE, before the claim: acquiring a lease is a write, and it would
    // fence a real recovery pass out of the very execution it was about to take.
    if (options.dryRun === true) continue;

    // Take ownership before re-driving, so two passes racing the same orphan do not both pay
    // for it. Losing the race means someone else is already on it.
    let held: HeldLease | undefined;
    // ADR 0130 D11 (S7c): a runtime with a heartbeat keeper claims through it (shared owner, one timer).
    let hold: { release(): Promise<void>; forget(): void } | undefined;
    if (runtime.leaseKeeper !== undefined) {
      // Lease BEFORE fence (D11 section 1): a conditional takeover below must never fence out a
      // driver that heartbeats. S7d: every keeper runtime claims, not only lease mode.
      let got: Awaited<ReturnType<typeof runtime.acquireDriverLease>>;
      try {
        got = await runtime.acquireDriverLease(executionId);
      } catch (err) {
        summary.failed++; // fail closed: a lease that cannot be confirmed is not "free"
        options.onError?.(executionId, err);
        continue;
      }
      if (got === null) continue;
      hold = got;
    } else if (options.leases !== undefined) {
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

    // A won claim whose attempt then fails FORGETS the lease (row left to expire, an expired lease is the
    // retry's evidence) instead of releasing it (absent proves nothing).
    let wonClaim = false;
    let redriven = false;
    try {
      // The shared routine (also the TimerService wake-row re-drive, ADR 0130 D10): re-checks the
      // status, fences, dispatches or resumes, settles, and classifies a sealed refusal.
      const r = await redriveAbandoned(runtime, executionId, {
        source: "sweep",
        // ADR 0130 D11 section 4 step 4: with heartbeat leases the takeover is conditional on the head.
        ...(runtime.leaseKeeper !== undefined && {
          conditional: true,
          onClaimed: async () => {
            wonClaim = true;
          },
        }),
        ...(options.fenced !== undefined && { fenced: options.fenced }),
        ...(options.dispatcher !== undefined && { dispatcher: options.dispatcher }),
        // ADR 0130 D11 (S7c): a dispatched re-drive is driven by the WORKER, which holds its own lease.
        // The claim is kept across this sweep's own fence acquisition and released only before the
        // dispatch (a lease B takes in a gap before the fence would be fenced out).
        ...(options.dispatcher !== undefined &&
          hold !== undefined && {
            beforeDispatch: async () => {
              const h = hold;
              hold = undefined;
              await h?.release();
            },
          }),
      });
      if (r.outcome === "skipped") continue;
      if (r.outcome === "refused") {
        // ADR 0130 - not recovered. Report (rate-limited) and skip the execution on this node for a
        // back-off window so the sweep does not re-drive it every pass.
        sealedRefusalBackoff(runtime, executionId, r.error, options);
        summary.failed++;
        continue;
      }
      redriven = true;
      summary.recovered++;
      options.onRecovered?.(executionId);
    } catch (err) {
      // ADR 0130 residuals D7 - a refusal from any read inside the re-drive (this node cannot open
      // the stream): back off like the sealed-answer refusal, do not retry every pass.
      if (isSealedUnreadable(err)) sealedRefusalBackoff(runtime, executionId, err, options);
      // Left in place; the next pass retries (at-least-once).
      summary.failed++;
      options.onError?.(executionId, err);
    } finally {
      // Stop renewing whatever happened: the re-drive has settled, failed, or thrown, and a
      // claim outliving the work it covers blocks whoever legitimately takes it next.
      held?.stop();
      if (hold !== undefined) {
        if (wonClaim && !redriven) hold.forget();
        else await hold.release();
      }
    }
  }

  return summary;
}

/**
 * What to consider. With a lease store the candidate set is exactly the expired leases —
 * narrower and cheaper than walking every execution, and the reason the predicate can go.
 */
async function* candidateIds(
  options: RecoverAbandonedOptions,
  owners: Map<string, string>
): AsyncGenerator<string> {
  if (options.leases !== undefined) {
    for (const lease of await options.leases.store.expired(
      // The store's OWN clock (L28): it stamped `expiresAt` in acquire/renew, so it must judge it.
      undefined,
      options.pageSize ?? 1000
    )) {
      owners.set(lease.executionId, lease.owner);
      yield lease.executionId;
    }
    return;
  }
  // Guarded above: without leases, `source` is required.
  yield* iterateExecutionIds(options.source as ExecutionEnumerable, options.pageSize);
}

// ADR 0130 - the per-runtime sealed back-off is SHARED with the TimerService wake-row re-drive
// (redriveAbandoned.ts), so a refusal seen by either path suppresses the other for the window. Both
// judge it on ONE clock, the runtime's (`runtime.clock`): the poll's own injectable `now` is not
// used for this map, or a back-off stamped on one clock would be read on another.
function sealedBackedOff(runtime: WorkflowRuntime, executionId: string): boolean {
  return isSealedBackedOff(runtime, executionId, runtime.clock());
}

function sealedRefusalBackoff(
  runtime: WorkflowRuntime,
  executionId: string,
  err: Error,
  options: RecoverAbandonedOptions
): void {
  const report = noteSealedRefusal(runtime, executionId, runtime.clock(), (attempt) =>
    redriveDelayMs(attempt, { baseMs: 1000, capMs: 60_000, random: () => 1 })
  );
  if (report) options.onError?.(executionId, err);
}
