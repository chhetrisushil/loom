import { describe, expect, it } from "vitest";
import type { BranchRef } from "./BranchRegistry";
import { InMemoryBranchRegistry } from "./InMemoryBranchRegistry";

const ref = (name: string, executionId: string): BranchRef => ({
  name,
  executionId,
  tip: 0,
  createdAt: 1,
  updatedAt: 1,
});

// Review round 1 (P3) — `pruneBranchRefs` (`@loom/workflow-runtime`) walks `listRefs({ after,
// limit })` a page at a time, deleting every dangling ref it finds INSIDE that same loop, one
// `deleteRef` per candidate. A `listRefs` that invalidated its sorted-name cache on every
// delete paid for a full O(n log n) re-sort on the NEXT page, every page — measured at 100k
// refs, a full prune (every ref dangling, the worst case) took 179s. This is a self-contained
// replica of that access pattern — `pruneBranchRefs` itself lives in `@loom/workflow-runtime`,
// which depends on this package, not the other way around, so it cannot be imported here.
describe("InMemoryBranchRegistry: a prune-style walk (list a page, delete what it finds, repeat)", () => {
  async function pruneStyleWalk(
    reg: InMemoryBranchRegistry,
    pageSize: number
  ): Promise<{ scanned: string[]; pages: number }> {
    const scanned: string[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      pages++;
      const page = await reg.listRefs({ limit: pageSize, ...(after !== undefined && { after }) });
      if (page.length === 0) break;
      for (const r of page) {
        scanned.push(r.name);
        await reg.deleteRef(r.name); // every ref is "dangling" — the worst case for a full sweep
      }
      after = page[page.length - 1]?.name;
      if (page.length < pageSize) break;
    }
    return { scanned, pages };
  }

  it("scans every ref exactly once, in order, and leaves the registry empty", async () => {
    const reg = new InMemoryBranchRegistry();
    const names = Array.from({ length: 500 }, (_, i) => `ref-${String(i).padStart(4, "0")}`);
    for (const n of [...names].reverse()) await reg.putRef(ref(n, `exec-${n}`));

    const { scanned } = await pruneStyleWalk(reg, 7); // a page size that does not divide evenly
    expect(scanned).toEqual(names); // no skips, no duplicates, code-point order preserved
    expect(await reg.listRefs()).toEqual([]);
  });

  // Review round 2 (P3) — a wall-clock bound here flaked under load (this repo already
  // removed the same pattern once, in L18): 398ms/559ms measured on an idle machine against a
  // 2000ms budget is ~25% noise, and this test runs in the default suite with no gating. The
  // property under test is DETERMINISTIC — how many times the full O(n log n) rebuild/sort
  // runs during the walk — so assert that directly, the same way `enumerate.test.ts` proves
  // `InMemoryAsyncEventStore` "sorts once per change": monkey-patch `Array.prototype.sort` for
  // the duration of the walk and count calls into it. `Array.prototype.sort` is otherwise
  // unused by `pruneStyleWalk`/`InMemoryBranchRegistry`, so every call counted here is one of
  // this store's own rebuilds, not incidental sorting elsewhere.
  it("rebuilds its sorted index O(log n) times over a full prune, not once per page", async () => {
    const reg = new InMemoryBranchRegistry();
    const n = 5_000;
    const pageSize = 50;
    for (let i = 0; i < n; i++) {
      const name = `ref-${String(i).padStart(6, "0")}`;
      await reg.putRef(ref(name, `exec-${i}`));
    }

    const nativeSort = Array.prototype.sort;
    let rebuilds = 0;
    Array.prototype.sort = function (this: unknown[], ...args) {
      rebuilds++;
      return nativeSort.apply(this, args as [((a: unknown, b: unknown) => number)?]);
    };
    let scanned: string[];
    let pages: number;
    try {
      ({ scanned, pages } = await pruneStyleWalk(reg, pageSize));
    } finally {
      Array.prototype.sort = nativeSort;
    }

    expect(scanned).toHaveLength(n);
    expect(pages).toBe(n / pageSize + 1); // one extra, empty, terminating page
    expect(await reg.listRefs()).toEqual([]);
    // Lazy compaction rebuilds only when tombstones reach half the array, which halves the
    // live count each time it fires — O(log n) rebuilds for a full sweep to empty (measured:
    // 8 at n=5000), independent of how many pages the walk took (101 here). Invalidating on
    // every delete (the bug this guards against) rebuilds once PER PAGE — measured 101, equal
    // to `pages` — so the assertion is against `pages` itself, not a hand-picked constant that
    // could quietly stop meaning anything if the compaction schedule changes.
    expect(rebuilds).toBeLessThan(pages / 2);
  });
});
