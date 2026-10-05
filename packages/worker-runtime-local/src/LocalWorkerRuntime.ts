import type { ExecutionState } from "@loom/core";
import type {
  ExecutionOutcome,
  ExecutionPackage,
  ExecutionResult,
  WorkerLease,
  WorkerRequest,
  WorkerRuntime,
} from "@loom/worker-runtime";
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
    const fence = await this.runtime.acquireFence(
      request.executionId,
      this.identity(request.principal)
    );
    return {
      leaseId: `local-${request.executionId}-${++this.leaseCounter}`,
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
      return toResult(state!);
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
    return toResult(state);
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

  async release(_lease: WorkerLease): Promise<void> {
    // No-op: nothing to reclaim in-process.
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
