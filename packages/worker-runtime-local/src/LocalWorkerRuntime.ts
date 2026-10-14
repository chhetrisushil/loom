import type { ExecutionState } from "@loom/core";
import type {
  ExecutionOutcome,
  ExecutionPackage,
  ExecutionResult,
  WorkerLease,
  WorkerRequest,
  WorkerRuntime,
} from "@loom/worker-runtime";
import { ChainHopLimitError, LeaseHeldError, StartLeaseHeldError } from "@loom/workflow-runtime";
import type { RunOptions, SystemGrant, WorkflowRuntime } from "@loom/workflow-runtime";

type Principal = NonNullable<RunOptions["principal"]>;

/** What a worker acts as for one operation: the package's principal, else the trusted grant, else nobody. */
type Identity = { principal?: Principal; system?: SystemGrant };

export interface LocalWorkerRuntimeOptions {
  /**
   * R3 — the kernel's SYSTEM identity (`runtime.systemOptions().system`). OFF by default, and
   * that is the point: a `LocalWorkerRuntime` is reached by every dispatcher-routed caller
   * (`InProcessA2ABus`, `executeGraph`, `PlacementDispatcher`, a worker-server), so giving it
   * the grant made each of them the system, bypassing the execution authorizer.
   *
   * Pass it ONLY to a worker that serves the kernel's own re-drives (a `TimerDispatcher` /
   * `recoverAbandoned` target) and is not reachable by user-originated dispatch. It applies to
   * principal-LESS packages only: a package that carries a `principal` is always authorized as
   * that principal, grant or not. A worker built with it reports `runsAsSystem`, which the
   * worker-server uses to refuse an unauthenticated listener.
   */
  system?: SystemGrant;
}
/**
 * The in-process WorkerRuntime: the zero-cloud reference implementation of the
 * Platform SPI. It runs an {@link ExecutionPackage} directly on a local
 * {@link WorkflowRuntime} — the same object that holds the registered flows and
 * effects (the worker's "code bundle" is simply this process).
 *
 * Semantics match the distributed contract exactly, so callers behave the same
 * whether execution is local or remote:
 *  - a fresh package (`input`, no `resumeEvent`) → `runtime.start`.
 *  - a resume package (`resumeEvent`) → `runtime.resume`.
 *  - in both cases the worker runs the execution to **suspend-or-complete**,
 *    then returns. A suspend is a normal, non-terminal outcome; the caller
 *    resumes with a fresh dispatch.
 */
export class LocalWorkerRuntime implements WorkerRuntime {
  private leaseCounter = 0;
  /** ADR 0130 D11 (S7c): the heartbeat hold of each allocated lease, released with it. */
  private readonly holds = new Map<string, { release(): Promise<void> }>();
  private readonly system: SystemGrant | undefined;
  readonly runsAsSystem: boolean;

  constructor(
    private readonly runtime: WorkflowRuntime,
    options: LocalWorkerRuntimeOptions = {}
  ) {
    this.system = options.system;
    this.runsAsSystem = options.system !== undefined;
  }

  /** The identity one operation runs as. A carried principal wins over the (opt-in) grant. */
  private identity(principal?: Record<string, unknown>): Identity {
    if (principal !== undefined) return { principal: principal as Principal };
    return this.system !== undefined ? { system: this.system } : {};
  }

  async allocate(request: WorkerRequest): Promise<WorkerLease> {
    // In-process capacity is unbounded here (the scheduler/dispatcher already
    // owns concurrency limits), so a lease is a correlation token — plus, on a
    // fencing store (K9.4), the monotonic token that makes this dispatch the
    // execution's sole legitimate writer until someone allocates a newer one.
    // ADR 0130 D11 (S7c): this attempt is a driver - the heartbeat lease comes BEFORE the fence. Another
    // live owner = stand down (a superseded refusal, not a failed attempt): no fence is taken.
    const hold = await this.runtime.acquireDriverLease(request.executionId);
    if (hold === null) {
      // A leased id with NO sequence 0 (a start package) may be facing a ghost lease: retryable, never
      // "superseded" (the start would be lost outright). A real stream stands down.
      if (!(await this.runtime.hasSequenceZero(request.executionId)))
        throw new StartLeaseHeldError(request.executionId);
      throw new LeaseHeldError(request.executionId);
    }
    let fence: number | undefined;
    try {
      fence = await this.runtime.acquireFence(request.executionId, {
        ...this.identity(request.principal),
        gateAs: "resume",
      });
    } catch (err) {
      await hold.release();
      throw err;
    }
    const leaseId = `local-${request.executionId}-${++this.leaseCounter}`;
    this.holds.set(leaseId, hold);
    return {
      leaseId,
      ...(fence !== undefined && { fence }),
      ...(request.metadata !== undefined && { metadata: request.metadata }),
    };
  }

  async execute(lease: WorkerLease, pkg: ExecutionPackage): Promise<ExecutionResult> {
    const handle = await this.resolveHandle(pkg, lease.fence);
    // A recovery of an already-terminal/suspended execution short-circuits to the
    // folded state (no handle, no re-run) — see resolveHandle.
    if (handle === null) {
      const state = await this.runtime.loadState(pkg.executionId, this.identity(pkg.principal));
      return toResult(await this.followContinuation(pkg, state!));
    }

    // waitForCompletion stays pending on suspend; waitForSuspend stays pending
    // when the flow never suspends — so this race resolves on whichever the flow
    // actually does. getState() is then authoritative for the outcome.
    try {
      await Promise.race([
        handle.waitForSuspend().then(() => undefined),
        handle.waitForCompletion().then(() => undefined),
      ]);
    } catch (err) {
      // K8.5 — a cancellation rejects the completion promise, but it is a normal
      // TERMINAL outcome, not a dispatch failure: settle with the folded state
      // (the in-memory fold already applied EXECUTION_CANCELLED synchronously)
      // so the caller gets a result instead of a retryable error — redispatching
      // a cancelled execution would be wrong.
      const state = handle.getState();
      if (state.status === "cancelled") {
        return toResult(state);
      }
      throw err;
    }

    const state = handle.getState();
    return toResult(await this.followContinuation(pkg, state));
  }

  /**
   * ADR 0109 D6 — a `continued` execution is not a failure and not a completion: its work goes on in
   * a successor. The dispatch reports what the HEAD of the chain did (suspended, completed...), under
   * the id the caller dispatched: a later resume addressed to that id is resolved forward by the
   * runtime. The head is waited on through its live handle when this runtime drives it (the kernel
   * starts a successor in-process), else read from the log. A chain that cannot be followed (an
   * unreadable or unverifiable successor) is left `continued` and reported as the old interim
   * outcome, a failed dispatch, rather than guessed at.
   */
  private async followContinuation(
    pkg: ExecutionPackage,
    state: ExecutionState
  ): Promise<ExecutionState> {
    let current = state;
    let id = state.executionId;
    // `followToHead` routes to the chain's newest generation however many times it rotated (a flow
    // that rotates ten times and then completes is a completion, not a failure), verifying links.
    while (current.status === "continued") {
      let head: Awaited<ReturnType<WorkflowRuntime["followToHead"]>>;
      try {
        head = await this.runtime.followToHead(id, this.identity(pkg.principal));
      } catch (err) {
        // an unverifiable deepest generation past the hop bound: leave the chain `continued` (the
        // fail-safe `failed` dispatch), never guess and never throw out of the dispatch
        if (err instanceof ChainHopLimitError) break;
        throw err;
      }
      if (head === null || head.executionId === id) break; // an unreadable / unverifiable successor
      id = head.executionId;
      current = head.state;
      // The kernel makes a successor's sequence 0 durable BEFORE it registers the live handle, so a
      // head read `running` may be in that window; `awaitLiveHandle` bridges it exactly (the start
      // is registered before its sequence 0 can be observed). No polling, no tick counting.
      if (current.status !== "running") continue;
      const live = await this.runtime.awaitLiveHandle(id);
      if (live !== undefined) {
        try {
          await Promise.race([
            live.waitForSuspend().then(() => undefined),
            live.waitForCompletion().then(() => undefined),
          ]);
        } catch {
          // a cancel / failure rejects the completion: the folded state below is authoritative
        }
        current = live.getState();
      } else {
        // No handle here: either a chain driven elsewhere, or the head settled between the read
        // above and this call. A handle leaves the live table only AFTER its terminal / continued
        // fact is durable, so one re-read settles which; still `running` means it is not ours.
        const fresh = await this.runtime.loadState(id, this.identity(pkg.principal));
        if (fresh !== null) current = fresh;
      }
    }
    return current === state ? state : { ...current, executionId: pkg.executionId };
  }

  /**
   * Decide how to run this package, making redispatch idempotent:
   *  - explicit resume (resumeEvent) → resume.
   *  - fresh id (no durable events) → start.
   *  - recovery of a crashed, still-"running" execution → resume from the latest
   *    snapshot; completed steps are skipped (no duplicate effects), only the
   *    in-flight tail re-runs.
   *  - recovery of an already terminal/suspended execution → `null`, signalling
   *    the caller to return the folded state untouched (a redispatched "lost
   *    response" must not re-run or restart).
   */
  private async resolveHandle(pkg: ExecutionPackage, fence?: number) {
    // R3 — the dispatch acts as the principal it carries; only a worker explicitly given the
    // system grant acts as the system, and only for a package that names no principal.
    const identity = this.identity(pkg.principal);
    const runOpts = { ...(fence !== undefined && { fence }), ...identity };
    if (pkg.resumeEvent) {
      return this.runtime.resume(pkg.executionId, pkg.resumeEvent, runOpts);
    }
    const existing = await this.runtime.loadState(pkg.executionId, identity);
    if (!existing) {
      return this.startFresh(pkg, runOpts);
    }
    if (existing.status === "running" || existing.status === "pending") {
      return this.runtime.resume(
        pkg.executionId,
        { eventType: "EXECUTION_RECOVERED", payload: {} },
        runOpts
      );
    }
    return null;
  }

  async release(lease: WorkerLease): Promise<void> {
    // Nothing to reclaim in-process but the heartbeat hold (a no-op hold when heartbeat is unwired).
    const hold = this.holds.get(lease.leaseId);
    this.holds.delete(lease.leaseId);
    await hold?.release();
  }

  /**
   * K8.5 — best-effort worker-side cancel: forwards to the runtime's
   * cancel-by-id (live → abort in-flight effect + durable fact; detached →
   * fence-then-cancel). An execution unknown to this worker is `false`, not an
   * error — the best-effort delivery contract; durable settlement belongs to
   * the caller's own store-side cancel.
   */
  async cancel(executionId: string, reason?: string): Promise<boolean> {
    try {
      // The cancel SPI carries no principal, so only a worker holding the grant can cancel on a
      // runtime that fails closed (best-effort by contract: a refusal is `false`).
      return await this.runtime.cancel(executionId, reason, this.identity());
    } catch {
      return false;
    }
  }

  private async startFresh(pkg: ExecutionPackage, runOpts?: { fence?: number } & Identity) {
    const flow = this.runtime.getFlow(pkg.flowId);
    if (!flow) {
      throw new Error(`No flow registered for flowId: "${pkg.flowId}"`);
    }
    return this.runtime.start(flow, pkg.input, { executionId: pkg.executionId, ...runOpts });
  }
}

function outcomeOf(status: ExecutionState["status"]): ExecutionOutcome {
  switch (status) {
    case "completed":
      return "completed";
    case "suspended":
      return "suspended";
    case "continued":
      // ADR 0109: terminal but not completed (no output; the successor carries on). `execute`
      // follows a chain to its head first (`followContinuation`), so this is reached only for a
      // chain that could not be followed (an unreadable or unverifiable successor): a failed
      // dispatch, never a completion.
      return "failed";
    default:
      // running should not be observed post-race; treat anything else (failed,
      // cancelled, pending) as a failed outcome for the dispatch.
      return "failed";
  }
}

function toResult(state: ExecutionState): ExecutionResult {
  const status = outcomeOf(state.status);
  return {
    executionId: state.executionId,
    status,
    state,
    lastSequence: state.sequence,
    ...(state.variables._output !== undefined && { output: state.variables._output }),
    ...(state.variables._error !== undefined && { error: state.variables._error }),
    ...(state.suspendedOn !== undefined && { suspendedOn: state.suspendedOn }),
  };
}
