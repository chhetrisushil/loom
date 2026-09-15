import { EffectRuntime } from "@loom/effect-runtime";
import { isReservedStream } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, orphanCensus } from "@loom/workflow-runtime";
import type { LeaseCoverage, OrphanCensus } from "@loom/workflow-runtime";
import { humanizeDuration as humanize, parseDuration } from "./duration";
import { type StoreFlags, resolveStores } from "./stores";

// ── `loom census` — what is stuck, and is anything watching it ────────────────
//
// The library pass exists to make a deferral measurable (#408). A number that requires
// writing TypeScript against your own composition root is a number nobody looks at, so this
// is the half that makes it an operator tool: point it at a database and read the answer.
//
// Read-only, and takes no predicate — the question it answers is whether YOUR staleness rule
// is right, so it must not need one of its own.

/** `5m,1h,6h,24h` → ms. Plain numbers are milliseconds. */
export function parseBuckets(spec: string): number[] {
  return spec
    .split(",")
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      try {
        return parseDuration(raw);
      } catch {
        throw new Error(`invalid bucket "${raw}" (try 30s, 5m, 6h, 2d)`);
      }
    });
}

function leaseLine(coverage: LeaseCoverage): string[] {
  return [
    `      ├─ lease held (renewing):  ${String(coverage.held).padStart(5)}`,
    `      ├─ lease expired:          ${String(coverage.expired).padStart(5)}   ← recovery will take these`,
    `      └─ no lease at all:        ${String(coverage.none).padStart(5)}   ← nothing is watching these`,
  ];
}

export function renderCensus(census: OrphanCensus, coverageNote?: string): string {
  const lines = [`census — ${census.scanned} execution(s) scanned, ${census.inFlight} in flight`];
  if (coverageNote !== undefined) lines.push(`  ${coverageNote}`);
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
 * `loom census --config <module> | --db <events.db> [--leases <leases.db>] [--buckets 5m,1h]`
 *
 * Writes nothing and acts on nothing. If `no lease at all` stays high for executions that are
 * hours old, those are paths nothing can recover from evidence — see loom#408.
 */
export async function cmdCensus(
  flags: StoreFlags & { buckets?: string; sampleSize?: number } = {}
): Promise<string> {
  const stores = await resolveStores(flags);
  const events = stores.eventStore;
  const leases = stores.leaseStore;
  try {
    if (events.listExecutions === undefined && events.listExecutionsPage === undefined) {
      // Name the store: on the `--config` path the operator did not choose it here, and
      // "does not support enumeration" without a name is a dead end.
      return `loom census needs to enumerate executions, and the configured ${events.constructor.name} implements neither listExecutions nor listExecutionsPage.`;
    }
    const runtime = new WorkflowRuntime({
      eventStore: events,
      // Optional: without a snapshot store every state folds from the log — slower, identical.
      snapshotStore: stores.snapshotStore ?? new InMemoryAsyncSnapshotStore(),
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
      ...(flags.buckets !== undefined && { buckets: parseBuckets(flags.buckets) }),
      ...(flags.sampleSize !== undefined && { sampleSize: flags.sampleSize }),
    });
    return renderCensus(census, coverageNote(stores.origin, leases !== undefined));
  } finally {
    await stores.close();
  }
}

/**
 * Coverage can be missing two ways, and they want different fixes: a flag the operator did
 * not pass, or a lease store the application never wired. Both are "not asked" — neither is
 * "none" — but only one of them is fixed at the prompt.
 */
function coverageNote(origin: "config" | "db", leased: boolean): string | undefined {
  if (leased) return undefined;
  return origin === "config"
    ? "(this app wires no lease store — `timers.leases` — so coverage is 'not asked', not 'none')"
    : "(no --leases given: lease coverage not reported — this is 'not asked', not 'none')";
}
