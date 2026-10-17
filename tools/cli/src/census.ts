import { EffectRuntime } from "@loom/effect-runtime";
import { isReservedStream } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, orphanCensus } from "@loom/workflow-runtime";
import type { LeaseCoverage, OrphanCensus } from "@loom/workflow-runtime";
import { UsageError } from "./args";
import { humanizeDuration as humanize, parseDuration } from "./duration";
import { relative, wakeAtOf } from "./ls";
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

/**
 * What the census saw of executions that are PARKED rather than in flight. The orphan bands
 * above count only running/pending work, so a timer wait whose `wakeAt` passed with nothing
 * firing it was invisible; this is that blind spot, read from the same states the pass already
 * folds (no second scan).
 */
export interface SuspendedSummary {
  /** Suspended executions seen. */
  count: number;
  /** Of those, parked on a durable timer (`wakeAt` recorded). */
  onTimer: number;
  /** Timer waits whose `wakeAt` is already in the past: nothing has woken them. */
  overdue: number;
  /** Earliest `wakeAt` still in the future (epoch ms). */
  nextWakeAt?: number;
  /** Up to a few overdue ids, oldest wake first. */
  overdueSample: Array<{ executionId: string; wakeAt: number }>;
}

function suspendedLines(s: SuspendedSummary, now: number): string[] {
  if (s.count === 0) return [];
  const lines = [
    `  suspended (parked, not in flight): ${s.count}${
      s.onTimer > 0 ? `   — ${s.onTimer} on a timer` : ""
    }${s.nextWakeAt !== undefined ? `, next wakeAt ${new Date(s.nextWakeAt).toISOString()} (${relative(s.nextWakeAt, now)})` : ""}`,
  ];
  if (s.overdue > 0) {
    lines.push(
      `      ├─ timer wakeAt already passed:  ${String(s.overdue).padStart(5)}   ← nothing has woken these`
    );
    lines.push(
      `      └─ e.g. ${s.overdueSample.map((o) => `${o.executionId} (wakeAt ${new Date(o.wakeAt).toISOString()})`).join(", ")}`
    );
  }
  return lines;
}

export function renderCensus(
  census: OrphanCensus,
  coverageNote?: string,
  suspended?: SuspendedSummary,
  now: number = Date.now()
): string {
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
  if (suspended !== undefined) lines.push(...suspendedLines(suspended, now));
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
  const { census, note, suspended } = await censusReport(flags);
  return renderCensus(census, note, suspended);
}

/** The structured census (`loom census --json`): the report plus the coverage note, if any. */
export async function censusReport(
  flags: StoreFlags & { buckets?: string; sampleSize?: number } = {}
): Promise<{ census: OrphanCensus; note: string | undefined; suspended: SuspendedSummary }> {
  const stores = await resolveStores(flags);
  const events = stores.eventStore;
  const leases = stores.leaseStore;
  try {
    if (events.listExecutions === undefined && events.listExecutionsPage === undefined) {
      // Name the store: on the `--config` path the operator did not choose it here, and
      // "does not support enumeration" without a name is a dead end.
      throw new UsageError(
        `loom census needs to enumerate executions, and the configured ${events.constructor.name} implements neither listExecutions nor listExecutionsPage.`
      );
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
    // The pass folds every execution anyway; watch the states go by instead of scanning twice.
    const now = Date.now();
    const suspended: SuspendedSummary = { count: 0, onTimer: 0, overdue: 0, overdueSample: [] };
    const overdue: Array<{ executionId: string; wakeAt: number }> = [];
    const watching = {
      loadState: async (id: string) => {
        const state = await runtime.loadState(id);
        if (state?.status === "suspended") {
          suspended.count++;
          const wakeAt = wakeAtOf(state.suspendedOn);
          if (wakeAt !== undefined) {
            suspended.onTimer++;
            if (wakeAt < now) {
              suspended.overdue++;
              overdue.push({ executionId: id, wakeAt });
            } else if (suspended.nextWakeAt === undefined || wakeAt < suspended.nextWakeAt) {
              suspended.nextWakeAt = wakeAt;
            }
          }
        }
        return state;
      },
    };
    const census = await orphanCensus(watching, {
      source: {
        listExecutions: async () =>
          (await events.listExecutions!()).filter((id) => !isReservedStream(id)),
      },
      ...(leases !== undefined && { leases }),
      ...(flags.buckets !== undefined && { buckets: parseBuckets(flags.buckets) }),
      ...(flags.sampleSize !== undefined && { sampleSize: flags.sampleSize }),
    });
    suspended.overdueSample = overdue.sort((a, b) => a.wakeAt - b.wakeAt).slice(0, 5);
    return { census, note: coverageNote(stores.origin, leases !== undefined), suspended };
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
