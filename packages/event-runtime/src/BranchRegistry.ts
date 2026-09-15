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

/**
 * SPI version for the {@link BranchRegistry} contract (ADR 0033). Pinned by
 * `runBranchRegistryConformance` in `@loom/testing`.
 */
export const BRANCH_REGISTRY_SPI_VERSION = "1.1.0";

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

/** Paging for {@link BranchRegistry.listRefs}. Keyset, because refs are unique and name-ordered. */
export interface ListRefsOptions {
  /** Max rows to return. Must be a positive integer — an unbounded page is not a default. */
  limit?: number;
  /** Return refs whose name sorts strictly AFTER this one. Pass the last name of the previous page. */
  after?: string;
}

/** Options for {@link BranchRegistry.promote}. */
export interface PromoteOptions {
  /**
   * Compare-and-set. The executionId `toName` is expected to name right now, or `null` for
   * "must not exist yet". The repoint happens only if the expectation holds; otherwise it
   * throws {@link BranchPromotionConflictError} and **nothing moves**.
   *
   * Without it, `promote` is last-write-wins: two nodes promoting different winners onto
   * `main` both succeed and the loser silently wins. That is the 1.0.0 behaviour, preserved
   * byte-identically when `expect` is omitted.
   */
  expect?: string | null;
}

/**
 * A compare-and-set {@link BranchRegistry.promote} lost: `toName` does not name what the
 * caller expected, so the promotion was refused. The registry is untouched — re-read the ref
 * and decide, rather than retrying blind.
 */
export class BranchPromotionConflictError extends Error {
  constructor(
    readonly toName: string,
    readonly expected: string | null,
    readonly actual: string | null
  ) {
    super(
      `promote onto "${toName}" refused: expected it to name ${expected === null ? "nothing" : `"${expected}"`}, but it names ${actual === null ? "nothing" : `"${actual}"`}`
    );
    this.name = "BranchPromotionConflictError";
    Object.setPrototypeOf(this, BranchPromotionConflictError.prototype);
  }
}

/**
 * Refuse a nonsense page size before it reaches a backend. SQLite treats `LIMIT -1` as "no
 * limit", so an unvalidated negative silently returns the whole table — the opposite of what
 * a caller asking for a page wants.
 */
export function assertListRefsLimit(limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`listRefs: limit must be a positive integer, got ${limit}`);
  }
}

export interface BranchRegistry {
  /** Create or move a ref (upsert by name). */
  putRef(ref: BranchRef): Promise<void>;
  getRef(name: string): Promise<BranchRef | null>;
  /**
   * Refs in name order. Unpaged by default; pass `limit`/`after` to walk a registry that has
   * grown — forking is cheap, so the ref table is unbounded by design.
   */
  listRefs(options?: ListRefsOptions): Promise<BranchRef[]>;
  /** Advance a ref's tip as its execution grows. No-op if the ref is absent. */
  moveTip(name: string, tip: number): Promise<void>;
  /**
   * Pick-a-winner: repoint `toName` onto the execution `fromName` currently
   * names, adopting its (executionId, tip). This is the entire "merge"
   * replacement — a pointer move, no history rewrite, no state reconciliation.
   * The losing execution remains immutable and independently resumable.
   * Throws if `fromName` does not exist. Pass `options.expect` to make it a compare-and-set
   * (see {@link PromoteOptions}) — without it, a concurrent promotion is a silent overwrite.
   */
  promote(fromName: string, toName: string, options?: PromoteOptions): Promise<void>;
  deleteRef(name: string): Promise<void>;

  /** Record a fork edge in the DAG. */
  recordLineage(rec: Omit<LineageRecord, "createdAt">): Promise<void>;
  getLineage(executionId: string): Promise<LineageRecord | null>;
  /** Direct children forked from `executionId`. */
  children(executionId: string): Promise<LineageRecord[]>;

  close(): Promise<void>;
}
