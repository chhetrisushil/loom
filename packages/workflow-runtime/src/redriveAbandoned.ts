import type { EventEnvelope } from "@loom/core";
import { readRangeOf } from "@loom/event-runtime";
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
// The routine decides nothing about WHETHER the execution is abandoned: BOTH callers prove it with
// the same evidence, the host's `isAbandoned` predicate or an EXISTING lease that has expired (never
// an absent one; no normal driver holds a lease, so "I acquired it" proves nothing). Neither may
// call this on weaker evidence.

// Bounded: at most SEALED_CAP executions are remembered per runtime; the oldest is evicted (recency
// order). An evicted execution is simply asked again - one extra refusal, then it is back in the map
// - so the bound costs a retry, never correctness.
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
  /**
   * The wake-row poll's guard (ADR 0130 D10): act only while the log head still equals this
   * sequence (the head at the replay refusal), and take the fence CONDITIONALLY on it, so exactly
   * one contender wins and any driver that appended makes this back off (`skipped`, nothing
   * written). The fence is observed first (`appendIfUnchanged(id, null)`), then taken with
   * `acquireFenceIf({ fence: observed, parkSeq: head })`: a rival acquirer or an answering event
   * makes it stale. A store without those primitives falls back to a head re-check and the
   * unconditional acquire (the documented residual).
   */
  ifHeadAt?: number;
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
    if (options.ifHeadAt !== undefined && fresh.sequence !== options.ifHeadAt) {
      return { outcome: "skipped" }; // something appended since the refusal: not ours to re-drive
    }
    let fence: number | undefined;
    if (options.fenced) {
      if (options.ifHeadAt === undefined) {
        fence = await runtime.acquireFence(executionId, runtime.systemOptions());
      } else {
        const got = await acquireFenceAtHead(runtime, executionId, options.ifHeadAt);
        if (got === "lost") return { outcome: "skipped" };
        fence = got;
      }
    }
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

/**
 * The conditional fence of the wake-row re-drive: `"lost"` when the head moved or a rival acquired
 * first (nothing written, the loser backs off), else the token (`undefined` for a store that does
 * not fence).
 */
async function acquireFenceAtHead(
  runtime: WorkflowRuntime,
  executionId: string,
  head: number
): Promise<number | "lost" | undefined> {
  const store = runtime.events;
  if (store.appendIfUnchanged === undefined || store.acquireFenceIf === undefined) {
    // No conditional primitive: head re-check (done by the caller) + the unconditional acquire.
    return runtime.acquireFence(executionId, runtime.systemOptions());
  }
  const seen = await store.appendIfUnchanged(executionId, null);
  if (seen.appended || seen.head !== head) return "lost";
  const got = await store.acquireFenceIf(executionId, { fence: seen.fence, parkSeq: head });
  if ("stale" in got) return "lost";
  return got.fence;
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
export async function unproductiveRecoveries(
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
