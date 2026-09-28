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

  it("stays fast at 500k refs — a regression guard for the invalidate-per-delete cost", async () => {
    const reg = new InMemoryBranchRegistry();
    const n = 500_000;
    for (let i = 0; i < n; i++) {
      const name = `ref-${String(i).padStart(6, "0")}`;
      await reg.putRef(ref(name, `exec-${i}`));
    }

    const started = performance.now();
    const { scanned, pages } = await pruneStyleWalk(reg, 500);
    const elapsedMs = performance.now() - started;

    expect(scanned).toHaveLength(n);
    expect(pages).toBe(n / 500 + 1); // one extra, empty, terminating page
    expect(await reg.listRefs()).toEqual([]);
    // Invalidating the sorted-name cache on every delete forces a full O(n log n) re-sort of
    // the WHOLE registry on every one of `pages` pages. Measured on this machine: ~170ms with
    // lazy tombstoning (this test's whole point), ~9.4s with the bug reintroduced (still far
    // short of the reviewer's own 179s/100k, but the ~50x gap is what this bound is checking
    // for, not an absolute number that would vary by machine) — 2s leaves generous margin
    // above the fix and is comfortably under the regression either way.
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
