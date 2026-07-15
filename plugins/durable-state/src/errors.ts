/**
 * DS-4 — compare-and-set failed: the stored revision was not the expected one.
 * A genuinely concurrent writer got there first (or the key was created/cleared
 * underneath the caller). The schedule-driven pattern makes this a
 * misconfiguration signal, not a normal outcome — fail fast, never lost-update.
 */
export class RevisionConflictError extends Error {
  constructor(
    readonly key: string,
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(
      `durable-state CAS conflict on "${key}": expected revision ${expectedRevision}, found ${actualRevision}`
    );
    this.name = "RevisionConflictError";
    Object.setPrototypeOf(this, RevisionConflictError.prototype);
  }
}

export type StateContractMismatchReason =
  | "no-migration-path"
  | "migration-failed"
  | "future-version"
  | "validation-failed";

/**
 * DS-2/DS-3 — stored state cannot be brought to the current contract: a
 * migration step is missing or threw, the stored version is newer than the
 * contract (rollback deploy), or the (migrated) payload fails schema
 * validation. Loud and typed by design: a run never proceeds on unvalidated
 * state, and state is never silently coerced. Alert on it, register the
 * missing migration (or fix the deploy), and the next run resumes cleanly.
 */
export class StateContractMismatchError extends Error {
  constructor(
    readonly contractId: string,
    readonly reason: StateContractMismatchReason,
    readonly storedVersion: number,
    readonly expectedVersion: number,
    detail?: string
  ) {
    super(
      `durable-state contract mismatch for "${contractId}" (${reason}): stored v${storedVersion}, contract v${expectedVersion}${detail ? ` — ${detail}` : ""}`
    );
    this.name = "StateContractMismatchError";
    Object.setPrototypeOf(this, StateContractMismatchError.prototype);
  }
}
