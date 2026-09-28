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
  // (`compareExecutionIds`), kept sorted incrementally rather than re-sorted per call.
  // Mirrors `InMemoryAsyncEventStore`'s `sortedIds` cache, so a page costs a binary search
  // plus the page size, not an O(n log n) re-sort of the whole registry on every call.
  //
  // NOT `String.prototype.localeCompare`: it is locale- and normalization-aware, so two
  // DISTINCT, canonically-equivalent names (an NFC "é", U+00E9, and its NFD decomposition
  // "e\u0301") can compare equal. `listRefs`'s `after` filter used to test
  // `name.localeCompare(after) > 0`, so a name tied with the cursor by that comparator was
  // silently excluded — an L10-style skip at exactly the page boundary `pruneBranchRefs`
  // resumes from.
  //
  // Review round 1 (P3) — `deleteRef` does NOT remove the name from this array; it becomes
  // a TOMBSTONE (absent from `refs`, still present here) that `listRefs` skips while paging,
  // and that gets swept out the next time this array is rebuilt. Deleting never reorders the
  // survivors, so there is nothing to re-sort — `pruneBranchRefs` interleaves one `listRefs`
  // page with N `deleteRef` calls, and invalidating per delete forced a full re-sort on
  // every single page (measured: 100k refs, 179s). New names are binary-INSERTed in place
  // instead, which also keeps a revived name (deleted, then `putRef`-created again under the
  // same string) from producing a duplicate entry — see `insertSorted`. Compacted lazily in
  // `listRefs`, once tombstones make up at least half the array, rather than never (an
  // unbounded array over a long-lived registry) or on every delete (the cost above).
  private sortedNames: string[] | undefined;

  constructor(options: InMemoryBranchRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Binary-insert `name` into `sortedNames`, no-op if it is already there (live or a tombstone). */
  private insertSorted(name: string): void {
    if (this.sortedNames === undefined) return; // computed fresh, lazily, on the next listRefs
    const arr = this.sortedNames;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareExecutionIds(arr[mid] as string, name) < 0) lo = mid + 1;
      else hi = mid;
    }
    if (arr[lo] !== name) arr.splice(lo, 0, name);
  }

  async putRef(ref: BranchRef): Promise<void> {
    if (!this.refs.has(ref.name)) this.insertSorted(ref.name);
    this.refs.set(ref.name, { ...ref });
  }

  async getRef(name: string): Promise<BranchRef | null> {
    const ref = this.refs.get(name);
    return ref !== undefined ? { ...ref } : null;
  }

  async listRefs(options?: ListRefsOptions): Promise<BranchRef[]> {
    assertListRefsLimit(options?.limit);
    // Lazy compaction: `deleteRef` never removes a name from `sortedNames` (see its doc
    // comment), so once tombstones make up at least half the array, drop them by rebuilding
    // from the live map — bounding how long a dead name can inflate every later scan, without
    // paying for a rebuild on every delete.
    if (this.sortedNames !== undefined && this.sortedNames.length >= this.refs.size * 2) {
      this.sortedNames = undefined;
    }
    this.sortedNames ??= [...this.refs.keys()].sort(compareExecutionIds);
    const sorted = this.sortedNames;
    const after = options?.after;
    // Binary-search the first name strictly after the cursor (any string, not only one
    // this store returned) — the same seek `InMemoryAsyncEventStore.listExecutionsPage`
    // does for execution ids. Tombstones do not disturb this: removing a name from `refs`
    // never changes the relative order of the names that remain in `sortedNames`.
    let start = 0;
    if (after !== undefined) {
      let hi = sorted.length;
      while (start < hi) {
        const mid = (start + hi) >>> 1;
        if (compareExecutionIds(sorted[mid] as string, after) > 0) hi = mid;
        else start = mid + 1;
      }
    }
    const limit = options?.limit;
    const page: BranchRef[] = [];
    for (let i = start; i < sorted.length; i++) {
      const ref = this.refs.get(sorted[i] as string);
      if (ref === undefined) continue; // a tombstone — deleted since this name was indexed
      page.push({ ...ref });
      if (limit !== undefined && page.length >= limit) break;
    }
    return page;
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
      this.insertSorted(toName); // a new name enters the order
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
    // Deliberately does NOT touch `sortedNames` — see its doc comment. The name becomes a
    // tombstone, skipped by `listRefs` and compacted away lazily.
    this.refs.delete(name);
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
