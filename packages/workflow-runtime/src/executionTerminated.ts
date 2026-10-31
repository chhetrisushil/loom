import type { ExecutionState } from "@loom/core";

/**
 * Issue #710 - what `ExecutionHandle.waitForSuspend()` rejects with when the run TERMINATES before
 * it parks: it completed, failed, was cancelled, or continued as new. `waitForSuspend()` settles
 * only on a park; without this it stayed pending forever on a terminal run, so a caller that
 * awaited it alone hung.
 *
 * - `state` is the folded state at the terminal (`completed`, `failed`, `cancelled` or `continued`);
 *   for a completion it is the very state `waitForCompletion()` resolves with.
 * - `status` is `state.status`, for a quick branch.
 * - `cause` is the error `waitForCompletion()` rejects with, when it rejects (a failure or a
 *   cancellation); absent for a completion and for a continue-as-new.
 *
 * `waitForCompletion()` settles BEFORE `waitForSuspend()` rejects, so a `Promise.race` of the two
 * (either order) resolves exactly as it did before. A storage, lease or seal failure is NOT a
 * termination: both promises still reject with that error.
 */
export class ExecutionTerminatedError extends Error {
  readonly state: ExecutionState;
  readonly status: ExecutionState["status"];
  readonly cause?: unknown;

  constructor(state: ExecutionState, cause?: unknown) {
    super(
      `Execution "${state.executionId}" ${state.status} before it suspended; waitForSuspend() only settles on a park`
    );
    this.name = "ExecutionTerminatedError";
    this.state = state;
    this.status = state.status;
    if (cause !== undefined) this.cause = cause;
    Object.setPrototypeOf(this, ExecutionTerminatedError.prototype);
  }
}
