import type { EventStore, ExecutionEnumerable } from "@loom/event-runtime";
import { type ContentSweepReport, sweepUnpinnedContent } from "@loom/plugin-content";
import { SqliteContentStore, SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";
import type { SnapshotStore } from "@loom/snapshot-runtime";
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
        "  WARNING: --orphans with no archive (no --archive-db, none wired in the config) — a blob cited only by an ARCHIVED run is an orphan to this sweep and is erased. Pass every store that holds citations."
      );
    }
    lines.push(`  ${verb} orphans (${report.orphansReclaimed.length}):`);
    listAddresses(lines, report.orphansReclaimed);
  }
  return lines.join("\n");
}

/**
 * `loom sweep content (--config <module> | --db <events.db> [--snap <snap.db>]) --content <content.db>
 *   [--archive-db <path> [--archive-snap <path>]] [--pin KIND,KIND] [--ttl <ms>]
 *   [--orphans [--no-archive]] [--apply]`
 *
 * `--orphans` (ADR 0055 D6) also reclaims blobs nothing scanned cites. Everything that can
 * cite a blob must be scanned, so:
 *  - the archive: under `--config`, the app's `durability.retention.archive` is scanned
 *    automatically. On the `--db` path, `--archive-db`. The sweep cannot tell an archive left
 *    out from no archive at all, so `--orphans --apply` with neither REFUSES unless
 *    `--no-archive` asserts there is none, and then it warns before erasing anything.
 *  - compaction snapshots: a compacted prefix's refs live only in its checkpoint, so
 *    `--orphans` needs the snapshot store (`--snap`, `--archive-snap`; a config always has one).
 *
 * Scan order is live first, then archive: retention copies to the archive before it deletes
 * from the live store, so an execution that moves mid-sweep is seen in one of them.
 * An app whose blobs are also cited from its own tables sweeps through the API
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
    /** `--no-archive`: the operator asserts retention archives nowhere (ADR 0055 D6). */
    noArchive?: boolean;
    archiveSnap?: string;
  }
): Promise<string> {
  const orphans = opts.orphans === true;
  const stores = await resolveStores(opts);
  const live = stores.eventStore;
  const configArchive = stores.archive;
  const archive =
    opts.archiveDb !== undefined
      ? new SqliteEventStore(opts.archiveDb)
      : (configArchive?.eventStore as (EventStore & ExecutionEnumerable) | undefined);
  const archiveSnap =
    opts.archiveSnap !== undefined
      ? new SqliteSnapshotStore(opts.archiveSnap)
      : configArchive?.snapshotStore;
  const snapshotStores = [stores.snapshotStore, archiveSnap].filter(
    (s): s is SnapshotStore => s !== undefined
  );
  const hasArchive = archive !== undefined;
  const closeOwned = async (): Promise<void> => {
    await stores.close();
    if (opts.archiveDb !== undefined) await archive?.close();
    if (opts.archiveSnap !== undefined) await archiveSnap?.close();
  };
  if (orphans && stores.snapshotStore === undefined) {
    await closeOwned();
    return "loom sweep content --orphans needs the snapshot store: a compacted execution's prefix refs live only in its snapshot, and would look like orphans. Pass --snap <snap.db> (and --archive-snap for an archive), or use --config.";
  }
  if (orphans && opts.apply && !hasArchive && opts.noArchive !== true) {
    await closeOwned();
    return "loom sweep content --orphans --apply refuses to run with no archive: a blob cited only by an ARCHIVED run is an orphan to this sweep and would be erased. Pass --archive-db (or wire durability.retention.archive under --config), or --no-archive if retention archives nowhere.";
  }
  if (orphans && opts.apply && !hasArchive) {
    // Said BEFORE anything is erased, not only in the report afterwards.
    console.error(
      "WARNING: --orphans --apply with --no-archive — every blob no scanned event cites will be erased; if any archive holds citations, stop now."
    );
  }
  const content = new SqliteContentStore(opts.content);
  const pins = (opts.pin ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  try {
    const report = await sweepUnpinnedContent({
      // Live first, then archive (see above).
      eventStores: archive === undefined ? [live] : [live, archive],
      ...(orphans && { snapshotStores }),
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
      orphans ? { archive: hasArchive } : undefined
    );
  } finally {
    await closeOwned();
    await content.close();
  }
}
