import { type ContentSweepReport, sweepUnpinnedContent } from "@loom/plugin-content";
import { SqliteContentStore, SqliteEventStore } from "@loom/plugin-sqlite";
import { type StoreFlags, resolveStores } from "./stores";

// ── `loom sweep content` — the operator surface for the K10.6 pinned sweep ────
//
// Same discipline as `loom retention run` (nothing prunes on a timer): DRY RUN
// by default — reports what WOULD be reclaimed; `--apply` erases. Pins are
// re-derived from the log every sweep (ADR 0055 mark-and-sweep), scanning the
// live store AND the archive when given, so evidence cited by findings in
// archived runs stays protected. Only a claim-check envelope's own `ref` ages
// out on the TTL; any other ref is load-bearing, kept while cited (ADR 0055 D4).
// Every erase is conditional on the blob's touch time (ADR 0055 D5), so a `put` that
// re-cites a blob mid-sweep keeps it. `--orphans` (D6) also erases stored blobs that no
// scanned event cites once untouched for the TTL — which is only safe when EVERY store
// holding citations is scanned: pass `--archive-db` if retention archives.

const LIST_CAP = 20;

function listAddresses(lines: string[], addresses: readonly string[]): void {
  for (const address of addresses.slice(0, LIST_CAP)) lines.push(`    ${address}`);
  if (addresses.length > LIST_CAP) lines.push(`    … +${addresses.length - LIST_CAP} more`);
  if (addresses.length === 0) lines.push("    (nothing eligible)");
}

function formatReport(
  report: ContentSweepReport,
  apply: boolean,
  ttlMs: number,
  pins: string[],
  orphans: { archive: boolean } | undefined
): string {
  const mode = apply ? "run" : "DRY RUN (pass --apply to erase)";
  const verb = apply ? "reclaimed" : "would-reclaim";
  const lines = [
    `content sweep ${mode} — ttl ${ttlMs}ms — pins: ${pins.length === 0 ? "(none)" : pins.join(", ")}`,
    `  executions scanned: ${report.executionsScanned}`,
    // Load-bearing = cited bare somewhere (ADR 0055 D4): never reclaimed while cited.
    `  refs seen: ${report.refsSeen}   pinned: ${report.refsPinned}   load-bearing: ${report.refsLoadBearing}`,
    // ADR 0055 D5: "no" = plain delete, so a blob re-put during the sweep can be lost.
    `  race-safe: ${report.raceSafe ? "yes" : "NO (the content store lacks deleteIfUntouchedSince)"}`,
    `  ${verb} (${report.reclaimed.length}):`,
  ];
  listAddresses(lines, report.reclaimed);
  if (orphans !== undefined) {
    if (!orphans.archive) {
      lines.push(
        "  WARNING: --orphans with no --archive-db — a blob cited only by an ARCHIVED run is an orphan to this sweep and is erased. Pass every store that holds citations."
      );
    }
    lines.push(`  ${verb} orphans (${report.orphansReclaimed.length}):`);
    listAddresses(lines, report.orphansReclaimed);
  }
  return lines.join("\n");
}

/**
 * `loom sweep content (--config <module> | --db <events.db>) --content <content.db>
 *   [--archive-db <path>] [--pin KIND,KIND] [--ttl <ms>] [--orphans] [--apply]`
 *
 * `--orphans` (ADR 0055 D6) also reclaims blobs nothing scanned cites. The sweep cannot tell
 * an archive you did not pass from no archive at all, so it warns whenever `--archive-db` is
 * absent. An app whose blobs are also cited from its own tables sweeps through the API
 * (`sweepUnpinnedContent({ roots })`, D7): the CLI has no way to read those tables.
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
    orphans?: boolean;
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
      ...(opts.orphans === true && { reclaimOrphans: true }),
    });
    return formatReport(
      report,
      opts.apply,
      opts.ttlMs,
      pins,
      opts.orphans === true ? { archive: archive !== undefined } : undefined
    );
  } finally {
    await stores.close();
    await archive?.close();
    await content.close();
  }
}
