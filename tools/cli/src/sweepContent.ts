import { type ContentSweepReport, sweepUnpinnedContent } from "@loom/plugin-content";
import { SqliteContentStore, SqliteEventStore } from "@loom/plugin-sqlite";

// ── `loom sweep content` — the operator surface for the K10.6 pinned sweep ────
//
// Same discipline as `loom retention run` (nothing prunes on a timer): DRY RUN
// by default — reports what WOULD be reclaimed; `--apply` erases. Pins are
// re-derived from the log every sweep (ADR 0055 mark-and-sweep), scanning the
// live store AND the archive when given, so evidence cited by findings in
// archived runs stays protected.

const LIST_CAP = 20;

function formatReport(
  report: ContentSweepReport,
  apply: boolean,
  ttlMs: number,
  pins: string[]
): string {
  const mode = apply ? "run" : "DRY RUN (pass --apply to erase)";
  const verb = apply ? "reclaimed" : "would-reclaim";
  const lines = [
    `content sweep ${mode} — ttl ${ttlMs}ms — pins: ${pins.length === 0 ? "(none)" : pins.join(", ")}`,
    `  executions scanned: ${report.executionsScanned}`,
    `  refs seen: ${report.refsSeen}   pinned: ${report.refsPinned}`,
    `  ${verb} (${report.reclaimed.length}):`,
  ];
  for (const address of report.reclaimed.slice(0, LIST_CAP)) lines.push(`    ${address}`);
  if (report.reclaimed.length > LIST_CAP) {
    lines.push(`    … +${report.reclaimed.length - LIST_CAP} more`);
  }
  if (report.reclaimed.length === 0) lines.push("    (nothing eligible)");
  return lines.join("\n");
}

/**
 * `loom sweep content --db <events.db> --content <content.db> [--archive-db <path>]
 *   [--pin KIND,KIND] [--ttl <ms>] [--apply]`
 */
export async function cmdSweepContent(opts: {
  db: string;
  content: string;
  archiveDb?: string;
  pin?: string;
  ttlMs: number;
  apply: boolean;
}): Promise<string> {
  const live = new SqliteEventStore(opts.db);
  const archive = opts.archiveDb === undefined ? undefined : new SqliteEventStore(opts.archiveDb);
  const content = new SqliteContentStore(opts.content);
  const pins = (opts.pin ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  try {
    const report = await sweepUnpinnedContent({
      eventStores: archive === undefined ? [live] : [live, archive],
      contentStore: content,
      pinnedEventTypes: pins,
      olderThanMs: opts.ttlMs,
      now: Date.now(),
      dryRun: !opts.apply,
    });
    return formatReport(report, opts.apply, opts.ttlMs, pins);
  } finally {
    await live.close();
    await archive?.close();
    await content.close();
  }
}
