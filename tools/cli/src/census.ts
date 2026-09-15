import { EffectRuntime } from "@loom/effect-runtime";
import { isReservedStream } from "@loom/event-runtime";
import { SqliteEventStore, SqliteLeaseStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, orphanCensus } from "@loom/workflow-runtime";
import type { LeaseCoverage, OrphanCensus } from "@loom/workflow-runtime";

// ── `loom census` — what is stuck, and is anything watching it ────────────────
//
// The library pass exists to make a deferral measurable (#408). A number that requires
// writing TypeScript against your own composition root is a number nobody looks at, so this
// is the half that makes it an operator tool: point it at a database and read the answer.
//
// Read-only, and takes no predicate — the question it answers is whether YOUR staleness rule
// is right, so it must not need one of its own.

const BUCKET_UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `5m,1h,6h,24h` → ms. Plain numbers are milliseconds. */
export function parseBuckets(spec: string): number[] {
  return spec
    .split(",")
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      const match = /^(\d+)([smhd]?)$/.exec(raw);
      if (match === null) throw new Error(`invalid bucket "${raw}" (try 30s, 5m, 6h, 2d)`);
      return Number(match[1]) * (match[2] ? (BUCKET_UNITS[match[2]] as number) : 1);
    });
}

function humanize(ms: number): string {
  if (ms >= 86_400_000) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`;
  if (ms >= 60_000) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}

function leaseLine(coverage: LeaseCoverage): string[] {
  return [
    `      ├─ lease held (renewing):  ${String(coverage.held).padStart(5)}`,
    `      ├─ lease expired:          ${String(coverage.expired).padStart(5)}   ← recovery will take these`,
    `      └─ no lease at all:        ${String(coverage.none).padStart(5)}   ← nothing is watching these`,
  ];
}

export function renderCensus(census: OrphanCensus, leased: boolean): string {
  const lines = [`census — ${census.scanned} execution(s) scanned, ${census.inFlight} in flight`];
  if (!leased) {
    lines.push(
      "  (no --leases given: lease coverage not reported — this is 'not asked', not 'none')"
    );
  }
  // Bands are CUMULATIVE, so consecutive identical breakdowns say nothing new. Printing them
  // anyway turns a four-line answer into a wall, and a report nobody scans is a report nobody
  // reads — which is the failure this command exists to avoid.
  let previous: string | undefined;
  for (const band of census.bands) {
    lines.push(
      `  in flight ≥ ${humanize(band.olderThanMs).padEnd(4)} ${String(band.count).padStart(5)}`
    );
    if (band.leases !== undefined && band.count > 0) {
      const block = leaseLine(band.leases).join("\n");
      if (block !== previous) {
        lines.push(block);
        previous = block;
      }
    }
    if (band.sample.length > 0) lines.push(`      e.g. ${band.sample.join(", ")}`);
  }
  if (census.leases !== undefined) {
    lines.push("  all in flight:");
    lines.push(...leaseLine(census.leases));
  }
  return lines.join("\n");
}

/**
 * `loom census --db <events.db> [--snap <snap.db>] [--leases <leases.db>] [--buckets 5m,1h]`
 *
 * Writes nothing and acts on nothing. If `no lease at all` stays high for executions that are
 * hours old, those are paths nothing can recover from evidence — see loom#408.
 */
export async function cmdCensus(
  db: string,
  opts: { snap?: string; leases?: string; buckets?: string; sampleSize?: number } = {}
): Promise<string> {
  const events = new SqliteEventStore(db);
  // A snapshot store is optional here: without one every state folds from the log, which is
  // slower and identical. A census must not require the deployment's full wiring.
  const snapshots =
    opts.snap !== undefined ? new SqliteSnapshotStore(opts.snap) : new InMemoryAsyncSnapshotStore();
  const leases = opts.leases !== undefined ? new SqliteLeaseStore(opts.leases) : undefined;
  try {
    if (events.listExecutions === undefined && events.listExecutionsPage === undefined) {
      return "this event store does not support enumeration (cannot take a census)";
    }
    const runtime = new WorkflowRuntime({
      eventStore: events,
      snapshotStore: snapshots,
      effectRuntime: new EffectRuntime(),
      // Nothing here runs a flow; a census only folds. Silence the diagnostics a bare
      // composition would otherwise print.
      onWarn: () => {},
    });
    const census = await orphanCensus(runtime, {
      source: {
        listExecutions: async () =>
          (await events.listExecutions!()).filter((id) => !isReservedStream(id)),
      },
      ...(leases !== undefined && { leases }),
      ...(opts.buckets !== undefined && { buckets: parseBuckets(opts.buckets) }),
      ...(opts.sampleSize !== undefined && { sampleSize: opts.sampleSize }),
    });
    return renderCensus(census, leases !== undefined);
  } finally {
    await events.close();
    await snapshots.close();
    await leases?.close();
  }
}
