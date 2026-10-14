import type { Lease, LeaseStore } from "@loom/event-runtime";
import type { WorkflowRuntime } from "./WorkflowRuntime";
import { isHeuristicOwner } from "./leaseKeeper";

// ── Reading heartbeat leases as EVIDENCE (ADR 0130 D11, S7d) ───────────────────────────────────
//
// The poll (`TimerService`) and the sweep (`recoverAbandoned`) read a lease for three decisions:
//
//  - VETO: an UNEXPIRED lease means a driver said it was alive inside the TTL. It overrides any
//    `isAbandoned` heuristic (the S6 silent-live-driver residual).
//  - EVIDENCE: an EXPIRED lease, from a node whose leases are true evidence, in a store every node
//    reads, means the driver stopped saying so for a full TTL.
//  - NOTHING: an ABSENT lease (a legacy driver, a node with heartbeat off, a store that cannot say)
//    is never evidence of anything.
//
// Fail closed: a store error is not an answer. It is reported (typed), the caller re-drives nothing,
// and the first successful read afterwards opens a QUIET PERIOD of one TTL during which an expired
// lease is still not acted on (live drivers re-establish their leases first; `renew` succeeds on an
// expired-but-untaken row, so nobody usurps a driver that merely rode out the outage).

/** A lease-store read failed while judging abandonment. The re-drive did NOT happen (fail closed). */
export class LeaseEvidenceError extends Error {
  readonly executionId: string;
  constructor(executionId: string, cause: unknown) {
    super(
      `could not read the heartbeat lease of "${executionId}"; nothing was re-driven (fail closed): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
    this.name = "LeaseEvidenceError";
    this.executionId = executionId;
  }
}

/** What the lease stores say about one execution, strongest first. */
export type LeaseJudgement =
  /** An unexpired lease: a live driver. Vetoes every heuristic. */
  | { kind: "live"; lease: Lease }
  /** Expired, and its owner's leases are true evidence. */
  | { kind: "expired"; lease: Lease }
  /** Expired, but the owner runs `onStoreError: "continue"`: a heuristic, never evidence. */
  | { kind: "expired-heuristic"; lease: Lease }
  /** Expired, but the outage that just ended opened a quiet period: wait, act on nothing. */
  | { kind: "quiet"; lease: Lease }
  /** No lease row (or a store that cannot tell absent from live): no evidence of anything. */
  | { kind: "absent" };

interface Quiet {
  erroredSinceOk: boolean;
  quietUntil: number;
}
const quietOf = new WeakMap<WorkflowRuntime, Quiet>();

/** The store's own clock (SPI 2.1.0 `storeNow`), else this host's. */
async function storeClock(store: LeaseStore): Promise<number> {
  return store.storeNow !== undefined ? await store.storeNow() : Date.now();
}

/** One store's answer: the lease row and whether it is still live, or `undefined` for "cannot say". */
async function read(
  store: LeaseStore,
  executionId: string
): Promise<{ lease: Lease; live: boolean } | null | undefined> {
  if (store.get !== undefined) {
    const lease = await store.get(executionId);
    if (lease === null) return null;
    return { lease, live: lease.expiresAt > (await storeClock(store)) };
  }
  // A store with no `get` can list its EXPIRED leases (judged on its own clock) but cannot tell an
  // absent lease from a live one: found = expired, otherwise unknown.
  const found = (await store.expired(undefined, 1000)).find((l) => l.executionId === executionId);
  return found === undefined ? undefined : { lease: found, live: false };
}

/**
 * Judge `executionId` from the runtime's heartbeat store (and `extra`, an explicitly configured
 * store, when it is a different one). Throws {@link LeaseEvidenceError} when a store errors.
 * `{ kind: "absent" }` for a runtime with no heartbeat keeper and no `extra`.
 */
export async function judgeLease(
  runtime: WorkflowRuntime,
  executionId: string,
  extra?: LeaseStore
): Promise<LeaseJudgement> {
  const keeper = runtime.leaseKeeper;
  const stores: LeaseStore[] = [];
  if (keeper !== undefined) stores.push(keeper.leaseStore);
  if (extra !== undefined && !stores.includes(extra)) stores.push(extra);
  if (stores.length === 0) return { kind: "absent" };
  const quiet = keeper !== undefined ? quietState(runtime) : undefined;
  let best: LeaseJudgement = { kind: "absent" };
  const rank = (j: LeaseJudgement): number =>
    j.kind === "live"
      ? 4
      : j.kind === "expired"
        ? 3
        : j.kind === "quiet"
          ? 2
          : j.kind === "expired-heuristic"
            ? 1
            : 0;
  for (const store of stores) {
    let got: Awaited<ReturnType<typeof read>>;
    try {
      got = await read(store, executionId);
    } catch (err) {
      if (quiet !== undefined) quiet.erroredSinceOk = true;
      throw new LeaseEvidenceError(executionId, err);
    }
    if (quiet !== undefined && keeper !== undefined && quiet.erroredSinceOk) {
      quiet.erroredSinceOk = false;
      quiet.quietUntil = keeper.monotonicNow() + keeper.ttlMs;
    }
    if (got == null) continue;
    let j: LeaseJudgement;
    if (got.live) j = { kind: "live", lease: got.lease };
    else if (isHeuristicOwner(got.lease.owner)) j = { kind: "expired-heuristic", lease: got.lease };
    else if (
      keeper !== undefined &&
      quiet !== undefined &&
      keeper.monotonicNow() < quiet.quietUntil
    )
      j = { kind: "quiet", lease: got.lease };
    else j = { kind: "expired", lease: got.lease };
    if (rank(j) > rank(best)) best = j;
  }
  return best;
}

function quietState(runtime: WorkflowRuntime): Quiet {
  let q = quietOf.get(runtime);
  if (q === undefined) {
    q = { erroredSinceOk: false, quietUntil: Number.NEGATIVE_INFINITY };
    quietOf.set(runtime, q);
  }
  return q;
}

/**
 * Is an expired lease TRUE evidence on this runtime's fleet by default (no host predicate, no
 * explicit `leases` option)? Only when this node runs heartbeat in `"stop"` mode AND the lease store
 * is cluster-visible (every node reads the same table): otherwise "a lease expired" proves nothing
 * about a driver on another node, and the default re-drive stays off (S7e).
 */
export function defaultLeaseEvidence(runtime: WorkflowRuntime): boolean {
  const keeper = runtime.leaseKeeper;
  return keeper !== undefined && !keeper.heuristic && keeper.leaseStore.scope === "cluster";
}

/** Pages a rotating GC scan may reach past the front of the expired list (bounds one pass's read). */
const GHOST_MAX_PAGES = 64;
const ghostPage = new WeakMap<WorkflowRuntime, number>();

/**
 * ADR 0130 D11 section 1: a lease with NO stream (a driver acquired it, then died before its first
 * append) is a ghost. It is garbage-collected, never re-driven. Examines at most `limit` expired
 * leases per call and returns how many ghosts it deleted. A lease whose stream exists is an orphan,
 * not a ghost, and is left to the poll and the sweep.
 *
 * The expired list is soonest-first with no cursor in the store SPI, so orphans (which are never
 * deleted here) would pin the front window forever. The scan therefore ROTATES: a pass that collected
 * nothing and filled its window moves to the next page on the next call (up to {@link GHOST_MAX_PAGES}
 * pages deep, then back to the front), so a ghost behind any number of orphans is reached in a
 * bounded number of passes. A pass that collected something stays on its page (the list shifted).
 *
 * Skipped, never touched: a `"continue"` owner's lease (that starter may still be alive: its expired
 * lease proves nothing), and a lease whose stream read throws (unknown is treated as an orphan). To
 * delete, the node takes the (expired) row FIRST, unrenewed, and re-checks that no stream appeared. If
 * one did (a slow start), the row is left to EXPIRE as an orphan's lease, never deleted, so a running
 * stream keeps an expiring lease the default re-drive can judge. No-op without a keeper. A failing
 * `expired()` read is the caller's (the poll reports it).
 */
export async function collectGhostLeases(
  runtime: WorkflowRuntime,
  options: { limit?: number } = {}
): Promise<number> {
  const keeper = runtime.leaseKeeper;
  if (keeper === undefined) return 0;
  const limit = options.limit ?? 100;
  const page = ghostPage.get(runtime) ?? 0;
  const want = limit * (page + 1);
  const rows = await keeper.leaseStore.expired(undefined, want);
  const window = rows.slice(page * limit);
  let collected = 0;
  for (const lease of window) {
    if (isHeuristicOwner(lease.owner)) continue; // may still be starting: proves nothing
    const id = lease.executionId;
    if (runtime.drivesLocally(id)) continue; // this node is (still) starting it: never collect our own driver's row
    try {
      if (await runtime.hasSequenceZero(id)) continue; // a real stream: an orphan
      // Take the expired row WITHOUT the keeper: nothing renews it, so if we leave it, it expires.
      const mine = await keeper.leaseStore.acquire(id, keeper.owner, keeper.ttlMs);
      if (mine === null) continue; // someone took it meanwhile: alive, not ours
      if (await runtime.hasSequenceZero(id)) continue; // a stream appeared: leave the row to expire
      await keeper.leaseStore.release(id, keeper.owner);
      collected++;
    } catch {
      // one lease's store fault must not abort the pass or starve the rest: treat it as an orphan
    }
  }
  const filled = rows.length >= want && window.length >= limit;
  ghostPage.set(runtime, collected === 0 && filled && page + 1 < GHOST_MAX_PAGES ? page + 1 : 0);
  return collected;
}
