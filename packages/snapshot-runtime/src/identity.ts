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
 * explicit exception, where a parent's snapshot seeds a child. An empty expected
 * `workflowId` (unknown to the caller) is not compared.
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
