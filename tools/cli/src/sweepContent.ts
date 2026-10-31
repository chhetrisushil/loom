import { existsSync } from "node:fs";
import path from "node:path";
import type { ArchiveStore, EventStore, ExecutionEnumerable } from "@loom/event-runtime";
import {
  ArchiveStoresRequiredError,
  type ContentSweepReport,
  sweepUnpinnedContent,
} from "@loom/plugin-content";
import {
  SqliteArchiveStore,
  SqliteContentStore,
  SqliteEventStore,
  SqliteSnapshotStore,
} from "@loom/plugin-sqlite";
import type { SnapshotStore } from "@loom/snapshot-runtime";
import { type StoreFlags, requireExistingFile, resolveStores } from "./stores";

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
 *   [--orphans [--no-archive] [--snapshots-touch-content]] [--apply]`
 *
 * `--orphans` (ADR 0055 D6) also reclaims blobs nothing scanned cites. Everything that can
 * cite a blob must be scanned, so:
 *  - the archive: under `--config`, the app's `durability.retention.archive` is scanned
 *    automatically. On the `--db` path, `--archive-db`. The sweep cannot tell an archive left
 *    out from no archive at all, so `--orphans --apply` with neither REFUSES unless
 *    `--no-archive` asserts there is none, and then it warns before erasing anything.
 *  - compaction snapshots: a compacted prefix's refs live only in its checkpoint, so
 *    `--orphans` needs the snapshot store (`--snap`; a config always has one), and with
 *    `--archive-db` also the archive's (`--archive-snap`).
 *
 *  - seed snapshots: `--orphans --apply` also needs `--snapshots-touch-content`, the operator's
 *    assertion that the runtime wrapped its snapshot store in `ContentTouchingSnapshotStore`. The
 *    flag is what the CLI passes as the sweep's `snapshotsTouchContent` acknowledgement; a dry
 *    run is exempt.
 *
 * Every refusal throws, so the binary exits non-zero.
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
    /** `--compaction-archive <archive.db>` (ADR 0138): the compaction archive; default `archive.db` beside `--db`. */
    compactionArchive?: string;
    /** `--no-compaction-archive`: the operator asserts no log was compacted into an archive. */
    noCompactionArchive?: boolean;
    /**
     * `--snapshots-touch-content`: the operator asserts that the runtime which WROTE these
     * snapshot stores wrapped them in `ContentTouchingSnapshotStore` (ADR 0055 D6 amendment 2).
     */
    snapshotsTouchContent?: boolean;
  }
): Promise<string> {
  const orphans = opts.orphans === true;
  // A SQLite open creates a missing file: a typo'd path would stand in for a real (empty)
  // archive and make every blob it alone cites look orphaned. Check BEFORE anything opens.
  requireExistingFile("content", opts.content);
  if (opts.archiveDb !== undefined) requireExistingFile("archive-db", opts.archiveDb);
  if (opts.archiveSnap !== undefined) requireExistingFile("archive-snap", opts.archiveSnap);
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
  // ADR 0138 - the compaction archive: the config's, an explicit path (must exist: a SQLite open
  // would create an empty file that stands in for a real archive), or `archive.db` beside `--db`.
  let compactionArchive: ArchiveStore | undefined = stores.compactionArchive;
  let ownsCompactionArchive = false;
  if (compactionArchive === undefined && opts.noCompactionArchive !== true) {
    if (opts.compactionArchive !== undefined) {
      requireExistingFile("compaction-archive", opts.compactionArchive);
    }
    const candidate =
      opts.compactionArchive ??
      (opts.db !== undefined && opts.config === undefined
        ? path.join(path.dirname(path.resolve(opts.db)), "archive.db")
        : undefined);
    if (
      candidate !== undefined &&
      (opts.compactionArchive !== undefined || existsSync(candidate))
    ) {
      compactionArchive = new SqliteArchiveStore(candidate);
      ownsCompactionArchive = true;
    }
  }
  const closeOwned = async (): Promise<void> => {
    if (ownsCompactionArchive) await compactionArchive?.close();
    await stores.close();
    if (opts.archiveDb !== undefined) await archive?.close();
    if (opts.archiveSnap !== undefined) await archiveSnap?.close();
  };
  // Refusals THROW: the binary exits non-zero, so a script can tell a refusal from a sweep.
  const refuse = async (message: string): Promise<never> => {
    await closeOwned();
    throw new Error(message);
  };
  if (orphans && stores.snapshotStore === undefined) {
    return refuse(
      "loom sweep content --orphans needs the snapshot store: a compacted execution's prefix refs live only in its snapshot, and would look like orphans. Pass --snap <snap.db> (and --archive-snap for an archive), or use --config."
    );
  }
  if (orphans && opts.archiveDb !== undefined && opts.archiveSnap === undefined) {
    return refuse(
      "loom sweep content --orphans with --archive-db needs --archive-snap <path>: an archived run compacted before it was archived keeps its prefix refs only in the archive's snapshot store."
    );
  }
  if (orphans && opts.apply && !hasArchive && opts.noArchive !== true) {
    return refuse(
      "loom sweep content --orphans --apply refuses to run with no archive: a blob cited only by an ARCHIVED run is an orphan to this sweep and would be erased. Pass --archive-db (or wire durability.retention.archive under --config), or --no-archive if retention archives nowhere."
    );
  }
  if (orphans && opts.apply && !hasArchive) {
    // Said BEFORE anything is erased, not only in the report afterwards.
    console.error(
      "WARNING: --orphans --apply with --no-archive — every blob no scanned event cites will be erased; if any archive holds citations, stop now."
    );
  }
  if (orphans && opts.apply && opts.snapshotsTouchContent !== true) {
    return refuse(
      "loom sweep content --orphans --apply refuses without --snapshots-touch-content: a fork of a compacted parent saves a seed snapshot citing refs that exist nowhere else, and only a snapshot store wrapped in ContentTouchingSnapshotStore (@loom/plugin-content) touches them. The CLI opens raw snapshot stores and cannot tell how the writing runtime built its own, so assert it: pass --snapshots-touch-content once every runtime that writes these snapshots wraps its snapshot store, or run without --apply (a dry run is exempt)."
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
      // ADR 0138: the compaction archive pins what compaction moved out of the logs. `[]` is the
      // operator's explicit statement (`--no-compaction-archive`) that none exists; with neither, an
      // erasing orphan pass over a compacted log refuses (ArchiveStoresRequiredError).
      ...(compactionArchive !== undefined
        ? { archiveStores: [compactionArchive] }
        : opts.noCompactionArchive === true
          ? { archiveStores: [] }
          : {}),
      contentStore: content,
      pinnedEventTypes: pins,
      olderThanMs: opts.ttlMs,
      now: Date.now(),
      dryRun: !opts.apply,
      ...(opts.orphans === true && {
        reclaimOrphans: {
          completeScan: true as const,
          ...(opts.snapshotsTouchContent === true && { snapshotsTouchContent: true as const }),
        },
      }),
    });
    return formatReport(
      report,
      opts.apply,
      opts.ttlMs,
      pins,
      orphans ? { archive: hasArchive } : undefined
    );
  } catch (err) {
    if (err instanceof ArchiveStoresRequiredError) {
      throw new Error(
        `${err.message} On the CLI: pass --compaction-archive <archive.db> (default: archive.db beside --db; --config wires the app's), or --no-compaction-archive if no log was compacted into an archive.`
      );
    }
    throw err;
  } finally {
    await closeOwned();
    await content.close();
  }
}
