import { isReservedStream, iterateExecutionIds } from "@loom/event-runtime";
import { LogLifecycle } from "@loom/workflow-runtime";
import { UsageError } from "./args";
import { type StoreFlags, resolveStores } from "./stores";

// ── `loom retention run` — the explicit, operator-driven retention sweep (K10.1) ─
//
// Nothing prunes the log on a timer (the anti-hidden-thread stance). This command enumerates
// every execution (via the listExecutions SPI), and reclaims the terminal-and-aged ones. It is
// a DRY RUN by default — it reports what WOULD happen; `--apply` performs the deletion.
//
// Both modes go through `LogLifecycle`, which is load-bearing rather than tidy. The preview
// used to re-implement eligibility here (terminal + aged), so it silently skipped the branch
// and pin gates and printed `would-reclaim` for executions the library would refuse.
//
// `--branches` matters for the same reason: R5.3 refuses to delete a parent whose forked
// branches alias its prefix, and that guard is a NO-OP unless the registry is wired. Without
// it this command would happily delete a parent that three live branches still depend on —
// so when it is absent, the report says the guard is off rather than staying quiet.

function tally(outcomes: string[]): string {
  const counts = new Map<string, number>();
  for (const o of outcomes) counts.set(o, (counts.get(o) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}: ${v}`)
    .join("   ");
}

/**
 * `loom retention run --db <events.db> --snap <snap.db> [--ttl <ms>] [--apply]` — reclaim
 * terminal executions older than the TTL. Dry run unless `--apply`.
 */
export async function cmdRetentionRun(
  flags: StoreFlags & { ttlMs: number; apply: boolean }
): Promise<string> {
  const { ttlMs, apply } = flags;
  const stores = await resolveStores(flags);
  const events = stores.eventStore;
  const branchRegistry = stores.branchRegistry;
  try {
    if (events.listExecutions === undefined && events.listExecutionsPage === undefined) {
      throw new UsageError(
        `loom retention needs to enumerate executions, and the configured ${events.constructor.name} implements neither listExecutions nor listExecutionsPage.`
      );
    }
    if (stores.snapshotStore === undefined) {
      // Retention PRUNES snapshots alongside the log. Running without one would silently
      // leave them behind — a sweep that reports success while half the data stays.
      throw new UsageError(
        "loom retention needs a snapshot store: pass --snap <snap.db>, or use --config (an app always has one)."
      );
    }
    const snapshots = stores.snapshotStore;
    const now = Date.now();
    const lifecycle = new LogLifecycle(events, snapshots, {
      ...(branchRegistry !== undefined && { branchRegistry }),
    });

    // SP-2 — bounded-memory enumeration: pages when the store supports them
    // (SPI 1.2.0; SqliteEventStore does, lexicographically ordered), whole-list
    // fallback otherwise.
    const rows: string[] = [];
    const outcomes: string[] = [];
    let seen = 0;
    for await (const id of iterateExecutionIds(events)) {
      if (isReservedStream(id)) continue;
      seen++;
      // Same gates either way — `evaluate` is exactly what `applyRetention` consults.
      const outcome = apply
        ? await lifecycle.applyRetention(id, { terminalTtlMs: ttlMs }, now)
        : ((await lifecycle.evaluate(id, { terminalTtlMs: ttlMs }, now)) as string).replace(
            "reclaimable",
            "would-reclaim"
          );
      outcomes.push(outcome);
      rows.push(`  ${id.padEnd(28)} ${outcome}`);
    }

    const mode = apply ? "run" : "DRY RUN (pass --apply to reclaim)";
    // Which half to fix differs by how the stores were resolved: a flag the operator can add,
    // or a registry the application never wired (so fork/branch is not in use at all).
    const guard =
      branchRegistry === undefined
        ? stores.origin === "config"
          ? "\n  ⚠ this app wires no branchRegistry: the live-descendant guard (R5.3) is OFF, so a parent with live branches is not protected"
          : "\n  ⚠ no --branches given: the live-descendant guard (R5.3) is OFF, so a parent with live branches is not protected"
        : "";
    const header = `retention ${mode} — ttl ${ttlMs}ms — ${seen} execution(s)`;
    return seen === 0
      ? `${header}${guard}\n  (no executions)`
      : `${header}${guard}\n${rows.join("\n")}\n${tally(outcomes)}`;
  } finally {
    await stores.close();
  }
}
