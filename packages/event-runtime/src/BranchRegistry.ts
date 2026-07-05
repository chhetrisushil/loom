/**
 * Git-style branching for event-sourced executions — branch only, no merge.
 *
 * A {@link BranchRef} is a movable pointer (like a git branch) naming the head
 * execution of a line of work. A {@link LineageRecord} is an immutable edge in
 * the fork DAG (child → parent at a sequence). Together they let speculative
 * agent executions fork from any point, run independently, and be selected with
 * `promote()` ("pick-a-winner"). There is deliberately no merge/rebase: two
 * divergent ExecutionStates have no principled join, so we don't fake one.
 */

/** A named, movable pointer to an execution head. */
export interface BranchRef {
  /** Branch name, e.g. "main" or "spec/scale-replicas". Unique. */
  name: string;
  /** The execution this ref currently points at. */
  executionId: string;
  /** Latest known sequence on that execution (advanced via `moveTip`). */
  tip: number;
  /** If this branch was created by a fork, the execution it forked from. */
  parentExecutionId?: string;
  /** If this branch was created by a fork, the sequence it forked at. */
  forkSequence?: number;
  createdAt: number;
  updatedAt: number;
}

/** An immutable edge in the fork DAG: `executionId` forked from `parentExecutionId` at `forkSequence`. */
export interface LineageRecord {
  executionId: string;
  parentExecutionId: string;
  forkSequence: number;
  createdAt: number;
}

export interface BranchRegistry {
  /** Create or move a ref (upsert by name). */
  putRef(ref: BranchRef): void;
  getRef(name: string): BranchRef | null;
  listRefs(): BranchRef[];
  /** Advance a ref's tip as its execution grows. No-op if the ref is absent. */
  moveTip(name: string, tip: number): void;
  /**
   * Pick-a-winner: repoint `toName` onto the execution `fromName` currently
   * names, adopting its (executionId, tip). This is the entire "merge"
   * replacement — a pointer move, no history rewrite, no state reconciliation.
   * The losing execution remains immutable and independently resumable.
   * Throws if `fromName` does not exist.
   */
  promote(fromName: string, toName: string): void;
  deleteRef(name: string): void;

  /** Record a fork edge in the DAG. */
  recordLineage(rec: Omit<LineageRecord, "createdAt">): void;
  getLineage(executionId: string): LineageRecord | null;
  /** Direct children forked from `executionId`. */
  children(executionId: string): LineageRecord[];

  close(): void;
}
