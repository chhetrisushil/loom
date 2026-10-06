import type { ExecutionState } from "@loom/core";
import {
  type ExecutionEnumerable,
  type Lease,
  type LeaseStore,
  isReservedStream,
  iterateExecutionIds,
} from "@loom/event-runtime";

/**
 * All a census needs: the folding read. Structural, so a `WorkflowRuntime` satisfies it and a
 * caller that only has stores does not have to build one — the same shape `@loom/live-query`
 * takes, and for the same reason.
 */
export interface CensusStateReader {
  loadState(executionId: string): Promise<ExecutionState | null>;
}

// ── What is stuck, and is anything watching it ────────────────────────────────
//
// Every other maintenance pass reads state in order to ACT: `recoverAbandoned` resumes what a
// predicate claims, `retireAbandonedBranches` cancels, `pruneBranchRefs` deletes. Nothing just
// looks — and that gap is why "wait for a deployment to report orphans the predicate misses"
// was never a real condition. A false negative sits `running` forever, silently; nobody files
// an issue about work that quietly never finished.
//
// This pass only looks. No predicate, no writes, no policy — a predicate is the thing a census
// must not need, because the question it answers is whether YOUR predicate is right.
//
// Given a lease store it also answers #408 directly: of the executions that look stuck, how
// many have no lease at all? Those are the paths nothing is watching — `runtime.start()` from
// a request, an operator resume — and counting them is how "should the runtime lease every
// run" stops being a guess.

/** How many in-flight executions fall in each lease state. */
export interface LeaseCoverage {
  /** Someone holds an unexpired lease: healthy and watched. */
  held: number;
  /** A lease exists but lapsed: a recovery pass will take these. */
  expired: number;
  /** No lease at all: nothing is watching, and nothing will recover it from evidence. */
  none: number;
}

export interface OrphanBand {
  /** Executions whose newest event is at least this old (CUMULATIVE — bands overlap). */
  olderThanMs: number;
  count: number;
  /** A few ids, so a report points somewhere rather than only counting. */
  sample: string[];
  leases?: LeaseCoverage;
}

export interface OrphanCensus {
  /** Executions enumerated. */
  scanned: number;
  /** Those `running`/`pending` — the only ones that can be stuck. */
  inFlight: number;
  /** Oldest band first. */
  bands: OrphanBand[];
  /** Lease coverage across ALL in-flight executions, when a lease store was given. */
  leases?: LeaseCoverage;
}

export interface OrphanCensusOptions {
  source: ExecutionEnumerable;
  /**
   * When given, each in-flight execution is classified held / expired / none. `none` is the
   * number #408 turns on.
   */
  leases?: LeaseStore;
  /** Age thresholds in ms, cumulative. Default 5m / 1h / 6h / 24h. */
  buckets?: number[];
  /**
   * Injectable clock, as everywhere else. Default: `Date.now()`. It ages executions
   * (`updatedAt`, wall-clock event timestamps) AND is compared to `lease.expiresAt`, which the
   * lease store stamped with ITS clock: if `leases` runs on a non-wall clock (e.g.
   * `InMemoryLeaseStore({ now: sim })`), pass that clock's reading here or every lease is
   * misclassified. When omitted, executions age by `Date.now()` but leases are judged on the
   * store's own `LeaseStore.storeNow()` if it has one (SPI 2.1.0; Postgres = DB time), else
   * `Date.now()`. An explicit `now` overrides both.
   */
  now?: number;
  pageSize?: number;
  /** Ids kept per band. Default 5 — a pointer, not a dump. */
  sampleSize?: number;
}

const DEFAULT_BUCKETS = [5 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];

/**
 * Count what is in flight, how long it has been, and whether anything owns it.
 *
 * Read-only and predicate-free. Run it beside `recoverAbandoned` — if a band hours deep is
 * full of executions your predicate never claimed, the predicate is too tight; if `none` is
 * large, the gap is that nothing leases those paths at all.
 */
export async function orphanCensus(
  reader: CensusStateReader,
  options: OrphanCensusOptions
): Promise<OrphanCensus> {
  const now = options.now ?? Date.now();
  // Leases are judged on the STORE's clock when it exposes one (SPI 2.1.0 `storeNow()`: Postgres
  // stamps on DB time, which is not this host's clock); executions are still aged by `now`
  // (event timestamps are wall clock). An explicit `options.now` wins for both.
  const leaseNow = options.now ?? (await options.leases?.storeNow?.()) ?? now;
  const sampleSize = options.sampleSize ?? 5;
  // Oldest first: a report is read from the worrying end.
  const thresholds = [...(options.buckets ?? DEFAULT_BUCKETS)].sort((a, b) => b - a);
  const bands: OrphanBand[] = thresholds.map((olderThanMs) => ({
    olderThanMs,
    count: 0,
    sample: [],
    ...(options.leases !== undefined && { leases: { held: 0, expired: 0, none: 0 } }),
  }));
  const census: OrphanCensus = {
    scanned: 0,
    inFlight: 0,
    bands,
    ...(options.leases !== undefined && { leases: { held: 0, expired: 0, none: 0 } }),
  };

  for await (const executionId of iterateExecutionIds(options.source, options.pageSize)) {
    // A reserved control stream (the retention trail, an inbox stream) is no execution: folded, it
    // reads `pending` forever and would be reported as an orphan.
    if (isReservedStream(executionId)) continue;
    census.scanned++;
    const state = await reader.loadState(executionId);
    if (state === null) continue;
    if (state.status !== "running" && state.status !== "pending") continue;
    census.inFlight++;

    const bucket = classify(options.leases, await leaseOf(options.leases, executionId), leaseNow);
    if (census.leases !== undefined && bucket !== undefined) census.leases[bucket]++;

    const age = now - state.updatedAt;
    for (const band of bands) {
      if (age < band.olderThanMs) continue;
      band.count++;
      if (band.sample.length < sampleSize) band.sample.push(executionId);
      if (band.leases !== undefined && bucket !== undefined) band.leases[bucket]++;
    }
  }
  return census;
}

/** `undefined` when no store was given, or when the store cannot be read (no `get`). */
async function leaseOf(store: LeaseStore | undefined, executionId: string): Promise<Lease | null> {
  if (store?.get === undefined) return null;
  return store.get(executionId);
}

function classify(
  store: LeaseStore | undefined,
  lease: Lease | null,
  now: number
): keyof LeaseCoverage | undefined {
  if (store === undefined) return undefined;
  if (lease === null) return "none";
  return lease.expiresAt > now ? "held" : "expired";
}
