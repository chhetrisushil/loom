import { isReservedStream } from "@loom/event-runtime";
import { SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";
import { foldEvents } from "@loom/replay-vm";
import { LogLifecycle } from "@loom/workflow-runtime";

// ── `loom retention run` — the explicit, operator-driven retention sweep (K10.1) ─
//
// Nothing prunes the log on a timer (the anti-hidden-thread stance). This command enumerates
// every execution (via the listExecutions SPI), and reclaims the terminal-and-aged ones. It is
// a DRY RUN by default — it reports what WOULD happen; `--apply` performs the deletion. The
// branch-integrity guard + control facts are handled by LogLifecycle.applyRetention.

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

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
  db: string,
  snap: string,
  ttlMs: number,
  apply: boolean
): Promise<string> {
  const events = new SqliteEventStore(db);
  const snapshots = new SqliteSnapshotStore(snap);
  try {
    if (events.listExecutions === undefined) {
      return "this event store does not support listExecutions (cannot enumerate for retention)";
    }
    const ids = (await events.listExecutions()).filter((id) => !isReservedStream(id)).sort();
    const now = Date.now();
    const lifecycle = new LogLifecycle(events, snapshots);

    const rows: string[] = [];
    const outcomes: string[] = [];
    for (const id of ids) {
      const outcome = apply
        ? await lifecycle.applyRetention(id, { terminalTtlMs: ttlMs }, now)
        : await previewRetention(events, id, ttlMs, now);
      outcomes.push(outcome);
      rows.push(`  ${id.padEnd(28)} ${outcome}`);
    }

    const mode = apply ? "run" : "DRY RUN (pass --apply to reclaim)";
    const header = `retention ${mode} — ttl ${ttlMs}ms — ${ids.length} execution(s)`;
    return ids.length === 0
      ? `${header}\n  (no executions)`
      : `${header}\n${rows.join("\n")}\n${tally(outcomes)}`;
  } finally {
    await events.close();
    await snapshots.close();
  }
}

/** Read-only eligibility peek (no deletion): terminal + aged past the TTL ⇒ would-reclaim. */
async function previewRetention(
  events: SqliteEventStore,
  executionId: string,
  ttlMs: number,
  now: number
): Promise<string> {
  const evs = await events.read(executionId);
  if (evs.length === 0) return "unknown";
  const state = foldEvents(evs, { executionId });
  if (!TERMINAL.has(state.status)) return "not-terminal";
  const endedAt = evs[evs.length - 1]!.timestamp;
  return now - endedAt < ttlMs ? "kept" : "would-reclaim";
}
