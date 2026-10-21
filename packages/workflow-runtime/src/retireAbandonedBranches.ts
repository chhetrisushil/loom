import type { BranchRegistry } from "@loom/event-runtime";
import type { WorkflowRuntime } from "./WorkflowRuntime";

// ── Retiring branches nobody ever answered ────────────────────────────────────
//
// Forking is nearly free, which is the point — and it has a cost nobody pays until
// something needs the parent's log to go away.
//
// `LogLifecycle.applyRetention` refuses to reclaim an execution while a live descendant
// branch still has events (R5.3, and correctly: the fork's copied prefix aliases the
// parent's). It also refuses to reclaim anything that is not TERMINAL. A branch that was
// forked, simulated and then never answered is suspended forever — so it is never
// reclaimed, so its parent is never reclaimed either. `blocked-by-branch`, every sweep,
// permanently. The retention policy quietly stops applying to exactly the executions that
// did the most work.
//
// The lever is not deletion. It is that an abandoned branch should become TERMINAL, which
// `cancel()` already does durably, fenced, and auditably: `EXECUTION_CANCELLED` records
// that the branch was abandoned and why, rather than erasing that it existed. Ordinary
// retention then collects the branch on its own TTL, and the parent unblocks behind it.
//
// What this pass will NOT do is decide which branches are abandoned. A branch suspended on
// a human gate is not garbage — it is someone's open question, and only the application
// knows whether that person is still coming. So `isAbandoned` is REQUIRED with no default,
// for the same reason `recoverAbandoned`'s is: `true` would retire live work, and `false`
// would be a pass that collects nothing while reading as coverage.

/** A forked branch that is still non-terminal, offered to the caller's predicate. */
export interface BranchCandidate {
  executionId: string;
  parentExecutionId: string;
  /** The sequence this branch forked at. */
  forkSequence: number;
  /** `"running"`, `"pending"` or `"suspended"` — terminal branches never reach the predicate. */
  status: string;
  /** The gate it is parked on, when suspended. The usual basis for "is anyone coming?". */
  suspendedOn?: string;
  /** Absolute wake time, when the gate carries a deadline. */
  wakeAt?: number;
  /** Wall-clock ms of the newest folded event. */
  updatedAt: number;
}

export interface RetireAbandonedBranchesOptions {
  /**
   * Decide whether a branch is abandoned. **Required, with no default** — see the note
   * above. Return `true` to retire it (a durable `EXECUTION_CANCELLED`), `false` to leave
   * it exactly as it is.
   */
  isAbandoned: (candidate: BranchCandidate) => boolean | Promise<boolean>;
  /** Recorded as the cancellation reason. Defaults to a generic abandonment note. */
  reason?: (candidate: BranchCandidate) => unknown;
  /** Stop after retiring this many. Default: no limit. */
  limit?: number;
  /** Called for every branch the pass selected, in both modes. */
  onCandidate?: (candidate: BranchCandidate) => void;
  /** Select and report, cancelling nothing — through this function, not beside it. */
  dryRun?: boolean;
}

export interface RetireAbandonedBranchesSummary {
  /** Direct children of the parent, from the lineage DAG. */
  scanned: number;
  /** Non-terminal children — the only ones the predicate ever saw. */
  candidates: number;
  retired: number;
  /** Claimed by the predicate but the cancel failed; left untouched. */
  failed: number;
  /** Still non-terminal after the pass: the branches that are genuinely someone's open question. */
  remaining: BranchCandidate[];
}

/**
 * Retire the abandoned branches of one execution, so retention can reach it.
 *
 * Parent-centric on purpose: this is driven by a parent that will not reclaim, so the set
 * it considers is bounded by that parent's direct children rather than a global scan. Run
 * it when a sweep reports `blocked-by-branch`, or ahead of one.
 *
 * Retiring a branch does not delete anything. It makes the branch terminal; the branch's
 * own retention TTL still has to elapse before its events go, and only then does the parent
 * stop being blocked. That ordering is deliberate — the alternatives-considered audit trail
 * survives exactly as long as the retention policy says it should.
 */
export async function retireAbandonedBranches(
  runtime: WorkflowRuntime,
  registry: BranchRegistry,
  parentExecutionId: string,
  options: RetireAbandonedBranchesOptions
): Promise<RetireAbandonedBranchesSummary> {
  if (typeof options.isAbandoned !== "function") {
    throw new Error(
      "retireAbandonedBranches: `isAbandoned` is required — a branch parked on a human gate " +
        "is someone's open question, not garbage, and only the application knows whether that " +
        "person is still coming. See recoverAbandoned for the same rule."
    );
  }
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  let selected = 0;
  const summary: RetireAbandonedBranchesSummary = {
    scanned: 0,
    candidates: 0,
    retired: 0,
    failed: 0,
    remaining: [],
  };

  for (const child of await registry.children(parentExecutionId)) {
    summary.scanned++;
    const state = await runtime.loadState(child.executionId, runtime.systemOptions());
    if (state === null) continue; // already reclaimed
    if (state.status !== "running" && state.status !== "pending" && state.status !== "suspended") {
      continue; // already terminal — retention can have it
    }
    summary.candidates++;

    const candidate: BranchCandidate = {
      executionId: child.executionId,
      parentExecutionId: child.parentExecutionId,
      forkSequence: child.forkSequence,
      status: state.status,
      ...(state.suspendedOn?.on !== undefined && { suspendedOn: state.suspendedOn.on }),
      ...(state.suspendedOn?.wakeAt !== undefined && { wakeAt: state.suspendedOn.wakeAt }),
      updatedAt: state.updatedAt,
    };

    // A dry run retires nothing, so `retired` never reaches the limit; count selections
    // separately rather than bounding on `remaining`, which holds the REJECTED branches.
    if ((options.dryRun === true ? selected : summary.retired) >= limit) {
      summary.remaining.push(candidate);
      continue;
    }
    if (!(await options.isAbandoned(candidate))) {
      summary.remaining.push(candidate);
      continue;
    }
    selected++;
    options.onCandidate?.(candidate);
    if (options.dryRun === true) continue;
    try {
      const cancelled = await runtime.cancel(
        child.executionId,
        options.reason?.(candidate) ??
          `branch abandoned: forked from ${parentExecutionId} at ${child.forkSequence}`,
        runtime.systemOptions()
      );
      // `false`: the branch reached a terminal state on its own (it completed, failed, or was already
      // cancelled), which is not a retirement by this pass. It is neither failed nor remaining.
      if (cancelled) summary.retired++;
    } catch {
      summary.failed++;
      summary.remaining.push(candidate);
    }
  }
  return summary;
}
