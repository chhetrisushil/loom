import {
  BranchPromotionConflictError,
  type BranchRef,
  type BranchRegistry,
  type LineageRecord,
  type ListRefsOptions,
  type PromoteOptions,
  assertListRefsLimit,
} from "./BranchRegistry";
import { compareExecutionIds } from "./executionIdOrder";

export interface InMemoryBranchRegistryOptions {
  /** Injectable clock for createdAt/updatedAt (defaults to Date.now). */
  now?: () => number;
}

/**
 * Ephemeral, Map-based {@link BranchRegistry} — the browser-safe / test reference impl
 * alongside the Sqlite and Postgres ones. Pure JS, no native deps. Behaviour matches
 * the durable backends (verified by `runBranchRegistryConformance` in `@loom/testing`).
 */
export class InMemoryBranchRegistry implements BranchRegistry {
  private readonly refs = new Map<string, BranchRef>();
  private readonly lineage = new Map<string, LineageRecord>();
  private readonly now: () => number;
  // SPI 2.0.0 (L21, ADR 0108 addendum) — ref names in Unicode CODE POINT order
  // (`compareExecutionIds`), cached across calls and invalidated only when a name is
  // ADDED or REMOVED (a tip/executionId mutation never changes name order). Mirrors
  // `InMemoryAsyncEventStore`'s `sortedIds` cache, so a page costs a binary search plus
  // the page size, not an O(n log n) re-sort of the whole registry on every call.
  //
  // NOT `String.prototype.localeCompare`: it is locale- and normalization-aware, so two
  // DISTINCT, canonically-equivalent names (an NFC "é", U+00E9, and its NFD decomposition
  // "e\u0301") can compare equal. `listRefs`'s `after` filter used to test
  // `name.localeCompare(after) > 0`, so a name tied with the cursor by that comparator was
  // silently excluded — an L10-style skip at exactly the page boundary `pruneBranchRefs`
  // resumes from.
  private sortedNames: string[] | undefined;

  constructor(options: InMemoryBranchRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  async putRef(ref: BranchRef): Promise<void> {
    if (!this.refs.has(ref.name)) this.sortedNames = undefined;
    this.refs.set(ref.name, { ...ref });
  }

  async getRef(name: string): Promise<BranchRef | null> {
    const ref = this.refs.get(name);
    return ref !== undefined ? { ...ref } : null;
  }

  async listRefs(options?: ListRefsOptions): Promise<BranchRef[]> {
    assertListRefsLimit(options?.limit);
    this.sortedNames ??= [...this.refs.keys()].sort(compareExecutionIds);
    const sorted = this.sortedNames;
    const after = options?.after;
    // Binary-search the first name strictly after the cursor (any string, not only one
    // this store returned) — the same seek `InMemoryAsyncEventStore.listExecutionsPage`
    // does for execution ids.
    let start = 0;
    if (after !== undefined) {
      let hi = sorted.length;
      while (start < hi) {
        const mid = (start + hi) >>> 1;
        if (compareExecutionIds(sorted[mid] as string, after) > 0) hi = mid;
        else start = mid + 1;
      }
    }
    const end = options?.limit === undefined ? sorted.length : start + options.limit;
    return sorted.slice(start, end).map((name) => ({ ...(this.refs.get(name) as BranchRef) }));
  }

  async moveTip(name: string, tip: number): Promise<void> {
    const ref = this.refs.get(name);
    if (ref === undefined) return;
    ref.tip = tip;
    ref.updatedAt = this.now();
  }

  async promote(fromName: string, toName: string, options?: PromoteOptions): Promise<void> {
    const from = this.refs.get(fromName);
    if (from === undefined) {
      throw new Error(`promote: branch "${fromName}" does not exist`);
    }
    const now = this.now();
    const to = this.refs.get(toName);
    // CAS. Single-threaded by construction here, so read-then-write IS atomic; the durable
    // backends do the same check inside one statement/transaction.
    if (options !== undefined && "expect" in options) {
      const actual = to?.executionId ?? null;
      if (actual !== (options.expect ?? null)) {
        throw new BranchPromotionConflictError(toName, options.expect ?? null, actual);
      }
    }
    if (to === undefined) {
      this.sortedNames = undefined; // a new name enters the order
      this.refs.set(toName, {
        name: toName,
        executionId: from.executionId,
        tip: from.tip,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      to.executionId = from.executionId;
      to.tip = from.tip;
      to.updatedAt = now;
    }
  }

  async deleteRef(name: string): Promise<void> {
    if (this.refs.delete(name)) this.sortedNames = undefined;
  }

  async recordLineage(rec: Omit<LineageRecord, "createdAt">): Promise<void> {
    this.lineage.set(rec.executionId, { ...rec, createdAt: this.now() });
  }

  async getLineage(executionId: string): Promise<LineageRecord | null> {
    const rec = this.lineage.get(executionId);
    return rec !== undefined ? { ...rec } : null;
  }

  async removeLineage(executionId: string): Promise<void> {
    this.lineage.delete(executionId);
  }

  async children(executionId: string): Promise<LineageRecord[]> {
    return [...this.lineage.values()]
      .filter((l) => l.parentExecutionId === executionId)
      .map((l) => ({ ...l }));
  }

  async close(): Promise<void> {}
}
