import type { TimerDispatcher } from "./TimerService";
import type { WorkflowRuntime } from "./WorkflowRuntime";
import { placementOf } from "./placement";
import { isSealedUnreadable } from "./sealGuard";
import { EXECUTION_RECOVERED, FlowReplayDivergenceError } from "./types";

// ── One re-drive of a `running` execution, shared by its two recoverers ────────────────────────
//
// `recoverAbandoned` (the sweep) and the `TimerService` poll (the inbox wake row of ADR 0130 D10)
// both re-drive an execution that is `running` with nobody driving it. They share THIS routine, so
// the fence acquire, the placement dispatch, the settle, the diverged-run policy and the sealed
// refusal accounting are not implemented twice, and they share ONE sealed back-off per runtime, so a
// refusal seen by either suppresses the other for the window (a node that cannot open the stream
// is not asked again by the other path).
//
// The routine decides nothing about WHETHER the execution is abandoned: the sweep proves it with
// `isAbandoned` / an expired lease, the poll with the lease it claimed before firing. Neither may
// call this on evidence weaker than that; a live lease holder is never superseded.

const SEALED_CAP = 1024;

interface BackoffEntry {
  attempt: number;
  nextTryAt: number;
}
const sealedBackoffs = new WeakMap<WorkflowRuntime, Map<string, BackoffEntry>>();

/** The delay schedule a caller back-off uses (the poll's `redriveBackoff`, or the sweep's fixed one). */
export interface SealedBackoffSchedule {
  baseMs?: number;
  capMs?: number;
  random?: () => number;
}

/** Is this node still backing off an execution it refused as sealed-unreadable? */
export function isSealedBackedOff(
  runtime: WorkflowRuntime,
  executionId: string,
  now: number
): boolean {
  const e = sealedBackoffs.get(runtime)?.get(executionId);
  return e !== undefined && e.nextTryAt > now;
}

/**
 * Record a sealed refusal: exponential back-off with NO attempt cap (a node that can open the
 * stream still needs the row/execution), bounded map (oldest evicted). Returns whether this refusal
 * should be reported (the first, then only every 16th).
 */
export function noteSealedRefusal(
  runtime: WorkflowRuntime,
  executionId: string,
  now: number,
  delayMs: (attempt: number) => number
): boolean {
  let m = sealedBackoffs.get(runtime);
  if (m === undefined) {
    m = new Map();
    sealedBackoffs.set(runtime, m);
  }
  const attempt = (m.get(executionId)?.attempt ?? 0) + 1;
  m.delete(executionId); // re-insert at the end: eviction order = recency
  if (m.size >= SEALED_CAP) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
  m.set(executionId, { attempt, nextTryAt: now + Math.max(1, delayMs(attempt)) });
  return attempt === 1 || attempt % 16 === 0;
}

/** A refusal-free outcome clears the back-off (the node can open it now). */
export function clearSealedBackoff(runtime: WorkflowRuntime, executionId: string): void {
  sealedBackoffs.get(runtime)?.delete(executionId);
}

export type RedriveOutcome =
  /** The execution was re-driven and the attempt settled (suspended, completed or failed on its own terms). */
  | { outcome: "recovered" }
  /** It was no longer `running`/`pending` when re-checked: nothing was touched. */
  | { outcome: "skipped" }
  /** This node cannot open what the replay needs (ADR 0130): NOT recovered, nothing appended. */
  | { outcome: "refused"; error: Error };

export interface RedriveOptions {
  /** Who is asking; informational (both callers share the accounting, they differ only here). */
  source: "sweep" | "wake";
  /** Acquire a newer fencing token before resuming (K9.4). */
  fenced?: boolean;
  /** Re-drive through a placement seam instead of in this process (#392). */
  dispatcher?: TimerDispatcher;
}

/**
 * Re-drive ONE abandoned `running`/`pending` execution with the `EXECUTION_RECOVERED` path the
 * worker uses under redispatch (ADR 0004): completed steps are served from the log and only the
 * interrupted tail re-executes. Re-checks the status immediately before acting. Throws for any
 * failure other than a sealed refusal (a diverged run, a store error); the caller owns lease claim,
 * back-off bookkeeping and reporting.
 */
export async function redriveAbandoned(
  runtime: WorkflowRuntime,
  executionId: string,
  options: RedriveOptions
): Promise<RedriveOutcome> {
  try {
    // Re-check immediately before acting: the caller may have awaited, and the execution may have
    // completed or suspended in the meantime. Re-driving a settled execution is not corrupting,
    // but it is pointless work and a misleading `recovered` count. A marked stream this node
    // cannot open is refused HERE, by this read, before any fence is acquired: nothing is written.
    const fresh = await runtime.loadState(executionId, runtime.systemOptions());
    if (fresh === null || (fresh.status !== "running" && fresh.status !== "pending")) {
      return { outcome: "skipped" };
    }
    const fence = options.fenced
      ? await runtime.acquireFence(executionId, runtime.systemOptions())
      : undefined;
    const resumeEvent = { eventType: EXECUTION_RECOVERED, payload: {} };

    if (options.dispatcher !== undefined) {
      // #392 - re-drive where the execution belongs, not on whichever node runs the pass. The
      // recorded target is a HINT: the placement policy gets the last word.
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
      return { outcome: "recovered" };
    }
    const handle = await runtime.resume(executionId, resumeEvent, {
      ...(fence !== undefined && { fence }),
      ...runtime.systemOptions(),
    });
    // Settle before moving on, so the caller applies backpressure instead of stampeding.
    const refused = await Promise.race([
      handle.waitForSuspend().then(
        () => undefined,
        (e: unknown) => e
      ),
      handle.waitForCompletion().then(
        () => undefined,
        (e: unknown) => e
      ),
    ]);
    // ADR 0113 - a re-drive refused as diverged (`divergence: "fail"`) is PARKED on a reserved gate;
    // surface it as a failure rather than counting a re-drive that went nowhere as recovered.
    if (refused instanceof FlowReplayDivergenceError) throw refused;
    // ADR 0130 - refused because THIS node cannot open a recorded sealed answer: not recovered.
    if (isSealedUnreadable(refused)) return { outcome: "refused", error: refused };
    return { outcome: "recovered" };
  } catch (err) {
    // ADR 0130 residuals D7 - a refusal from any read inside the re-drive (a stream this node
    // cannot open) is a refusal, not a failure.
    if (isSealedUnreadable(err)) return { outcome: "refused", error: err };
    throw err;
  }
}
