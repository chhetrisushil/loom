import type { SuspendCondition } from "./execution";

export class SuspendError extends Error {
  readonly condition: SuspendCondition;

  constructor(condition: SuspendCondition) {
    super("SUSPEND");
    this.name = "SuspendError";
    this.condition = condition;
    Object.setPrototypeOf(this, SuspendError.prototype);
  }
}

/**
 * DE-4 (ADR 0060) — a typed failure on a DECLARED error channel. Thrown from an
 * effect/handler body (via {@link fail}); when the owning contract declares the
 * channel in its `errors:` map, the kernel records STEP_FAILED with
 * `{ channel, payload }` (payload validated against the channel's schema) and
 * REPLAY SUBSTITUTES the recorded failure — the effect is never re-invoked and
 * the flow deterministically re-takes the same catch branch. An UNDECLARED
 * channel degrades to the legacy untyped failure (at-least-once re-run).
 *
 * Deliberately a plain userspace throw, not a syscall: no `ctx.fail`, no new
 * event type, KERNEL_ABI stays 1.1.0 (the saga/ctx.compensate precedent).
 */
export class TypedFailure extends Error {
  readonly channel: string;
  readonly payload: unknown;

  constructor(channel: string, payload: unknown, message?: string) {
    super(message ?? `typed failure on channel "${channel}"`);
    this.name = "TypedFailure";
    this.channel = channel;
    this.payload = payload;
    Object.setPrototypeOf(this, TypedFailure.prototype);
  }
}

/** Complete the current effect on a declared error channel (throws {@link TypedFailure}). */
export function fail(channel: string, payload: unknown, message?: string): never {
  throw new TypedFailure(channel, payload, message);
}

export class StepError extends Error {
  readonly stepId: string;
  readonly cause: unknown;

  constructor(stepId: string, cause: unknown) {
    super(`Step "${stepId}" failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "StepError";
    this.stepId = stepId;
    this.cause = cause;
    Object.setPrototypeOf(this, StepError.prototype);
  }
}

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
    Object.setPrototypeOf(this, ReplayError.prototype);
  }
}

export class WorkflowNotFoundError extends Error {
  constructor(executionId: string) {
    super(`No execution found for id: ${executionId}`);
    this.name = "WorkflowNotFoundError";
    Object.setPrototypeOf(this, WorkflowNotFoundError.prototype);
  }
}

/**
 * A durable event write (EventStore.append) rejected. Surfaced by the
 * per-execution write pipeline at a flush barrier — so waitForCompletion /
 * waitForSuspend reject with this. `cause` is the underlying store error.
 */
export class StorageWriteError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(`Durable event write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "StorageWriteError";
    this.cause = cause;
    Object.setPrototypeOf(this, StorageWriteError.prototype);
  }
}

/**
 * ADR 0106 — a snapshot names a DIFFERENT execution (or workflow) than the one it was loaded
 * for. A blank identity is filled in (compaction before ADR 0106 wrote blank checkpoints);
 * a non-blank mismatch is refused, because it can only come from a store or tenant-scoping
 * bug, and folding it would write this execution's events under another's identity.
 */
export class SnapshotIdentityMismatchError extends Error {
  constructor(
    readonly executionId: string,
    readonly field: "executionId" | "workflowId",
    readonly expected: string,
    readonly found: string
  ) {
    super(
      `refusing the snapshot loaded for execution "${executionId}": its ${field} is "${found}", expected "${expected}". A snapshot naming another execution or workflow is a store or tenant-scoping defect; nothing was folded.`
    );
    this.name = "SnapshotIdentityMismatchError";
    Object.setPrototypeOf(this, SnapshotIdentityMismatchError.prototype);
  }
}

/**
 * ADR 0106 — the one rule for a snapshot's identity fields, shared by every place that seeds
 * a fold from a snapshot: a BLANK field (a pre-0106 compaction checkpoint) is acceptable and
 * the caller fills it; a NON-blank field that disagrees throws
 * {@link SnapshotIdentityMismatchError}. `retarget` skips the executionId comparison — fork's
 * explicit exception, where a parent's snapshot seeds a child.
 */
export function assertSnapshotIdentity(
  state: { executionId: string; workflowId: string },
  executionId: string,
  workflowId: string,
  options: { retarget?: boolean } = {}
): void {
  if (options.retarget !== true && state.executionId !== "" && state.executionId !== executionId) {
    throw new SnapshotIdentityMismatchError(
      executionId,
      "executionId",
      executionId,
      state.executionId
    );
  }
  if (state.workflowId !== "" && workflowId !== "" && state.workflowId !== workflowId) {
    throw new SnapshotIdentityMismatchError(
      executionId,
      "workflowId",
      workflowId,
      state.workflowId
    );
  }
}
