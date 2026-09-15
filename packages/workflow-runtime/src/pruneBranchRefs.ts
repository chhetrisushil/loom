import { type BranchRegistry, type EventStore, headOf } from "@loom/event-runtime";

// ── Refs that point at nothing ────────────────────────────────────────────────
//
// A ref is a movable pointer, and nothing keeps it honest. Once retention reclaims the
// execution a ref names, the ref survives it — pointing at an id with no events. That is
// worse than untidy: `promote(ghost, "main")` succeeds, and `main` ends up naming an
// execution that cannot be read, resumed or replayed.
//
// Unlike deciding whether a BRANCH is abandoned — someone's open question, which only the
// application can judge (see `retireAbandonedBranches`) — this needs no policy. "The
// execution has no events" is a fact, not a judgement, so this pass has a defensible
// default and takes no predicate. It is still a pass you schedule rather than a service:
// run it after a retention sweep, which is what creates the garbage it collects.

export interface PruneBranchRefsOptions {
  /** Rows to read per page. Default 500. */
  pageSize?: number;
  /** Stop after deleting this many. Default: no limit. */
  limit?: number;
  /**
   * Never delete these refs, even if their execution is gone. `main` is the usual case: a
   * dangling `main` is a loud, findable problem, and silently deleting it turns "main names
   * a ghost" into "there is no main", which is harder to diagnose, not easier.
   */
  protect?: readonly string[];
  /** Called for every dangling, unprotected ref the pass selected, in both modes. */
  onCandidate?: (name: string) => void;
  /** Select and report, deleting nothing — through this function, not beside it. */
  dryRun?: boolean;
}

export interface PruneBranchRefsSummary {
  scanned: number;
  /** Refs whose execution no longer has any events. */
  dangling: number;
  deleted: number;
  /** Dangling but protected — reported so a dangling `main` is visible rather than silent. */
  protectedDangling: string[];
}

/**
 * Delete refs whose execution has been reclaimed. Paged over `listRefs({ limit, after })`,
 * so a registry that has grown (forking is cheap) is walked in bounded memory.
 *
 * Deliberately does NOT touch lineage: `LogLifecycle` drops a fork edge when it deletes the
 * execution, which is the point where the data is provably gone. This pass exists for the
 * rows that outlive that — a ref is named by a human, so nothing else knows it is there.
 */
export async function pruneBranchRefs(
  eventStore: EventStore,
  registry: BranchRegistry,
  options: PruneBranchRefsOptions = {}
): Promise<PruneBranchRefsSummary> {
  const pageSize = options.pageSize ?? 500;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const protectedNames = new Set(options.protect ?? ["main"]);
  let selected = 0;
  const summary: PruneBranchRefsSummary = {
    scanned: 0,
    dangling: 0,
    deleted: 0,
    protectedDangling: [],
  };

  let after: string | undefined;
  for (;;) {
    const page = await registry.listRefs({
      limit: pageSize,
      ...(after !== undefined && { after }),
    });
    if (page.length === 0) break;
    for (const ref of page) {
      summary.scanned++;
      if ((await headOf(eventStore, ref.executionId)) !== null) continue;
      summary.dangling++;
      if (protectedNames.has(ref.name)) {
        summary.protectedDangling.push(ref.name);
        continue;
      }
      // `deleted` counts writes, so in a dry run it stays 0 and the bound comes from the
      // selections instead — a summary that claimed deletions it never made would be the
      // same lie as a preview that disagrees with its pass.
      if ((options.dryRun === true ? selected : summary.deleted) >= limit) continue;
      selected++;
      options.onCandidate?.(ref.name);
      if (options.dryRun === true) continue;
      await registry.deleteRef(ref.name);
      summary.deleted++;
    }
    after = page[page.length - 1]?.name;
    if (page.length < pageSize) break;
  }
  return summary;
}
