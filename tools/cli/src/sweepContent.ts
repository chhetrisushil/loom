import { type ContentSweepReport, sweepUnpinnedContent } from "@loom/plugin-content";
import { SqliteContentStore, SqliteEventStore } from "@loom/plugin-sqlite";
import { type StoreFlags, resolveStores } from "./stores";

// ── `loom sweep content` — the operator surface for the K10.6 pinned sweep ────
//
// Same discipline as `loom retention run` (nothing prunes on a timer): DRY RUN
// by default — reports what WOULD be reclaimed; `--apply` erases. Pins are
// re-derived from the log every sweep (ADR 0055 mark-and-sweep), scanning the
// live store AND the archive when given, so evidence cited by findings in
// archived runs stays protected. Only claim-checked (enveloped) refs age out on
// the TTL; a bare ref is load-bearing and kept while cited (ADR 0055 D4).

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
    // Load-bearing = cited bare somewhere (ADR 0055 D4): never reclaimed while cited.
    `  refs seen: ${report.refsSeen}   pinned: ${report.refsPinned}   load-bearing: ${report.refsLoadBearing}`,
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
 * `loom sweep content (--config <module> | --db <events.db>) --content <content.db>
 *   [--archive-db <path>] [--pin KIND,KIND] [--ttl <ms>] [--apply]`
 *
 * The event log comes from the composition like every other pass, but `--content` stays a
 * path: `defineConfig` has no content-store seam — the content plugin wires itself into the
 * effect runtime, not the composition root — so there is nothing for `--config` to hand over
 * yet. Asking for it explicitly is honest; inventing a default would guess at which store
 * holds the blobs this log cites.
 */
export async function cmdSweepContent(
  opts: StoreFlags & {
    content: string;
    archiveDb?: string;
    pin?: string;
    ttlMs: number;
    apply: boolean;
  }
): Promise<string> {
  const stores = await resolveStores(opts);
  const live = stores.eventStore;
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
    await stores.close();
    await archive?.close();
    await content.close();
  }
}
