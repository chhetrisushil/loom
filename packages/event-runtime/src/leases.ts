// ── Durable ownership of a running execution (#380) ───────────────────────────
//
// A `running` execution owned by a healthy node is byte-identical, in the log, to one
// orphaned by a dead one: the difference is a fact about the cluster, not about the
// execution, so no fold can see it. That is why `recoverAbandoned` demands a predicate — and
// why a double dispatch today is merely SAFE rather than avoided. Fencing (K9.4) rejects the
// loser's write; both runs still executed, and both still paid for their effects.
//
// A lease is the missing fact: ownership with an expiry, written where both nodes can see it.
//
// Deliberately shaped like `TimerStore`: a small store with a polling service above it, no
// coordination protocol, and nothing required of a deployment that does not want it. Unwired,
// every path behaves byte-identically (G2).

/**
 * SPI version for the {@link LeaseStore} contract. Pinned by `runLeaseStoreConformance`.
 *
 * 2.0.0 (L28): `expired`'s `now` became optional and MUST default to the store's stamping clock.
 * MAJOR, not additive: a 1.x store written `expired(now: number)` still type-checks against the
 * new signature but, handed `undefined`, returns `[]` — recovery silently recovers nothing.
 *
 * 2.1.0 (L29): optional `storeNow()` — the store's own clock. Additive: a store without it behaves
 * exactly as before, and a caller with no `storeNow()` falls back to `Date.now()`.
 */
export const LEASE_STORE_SPI_VERSION = "2.1.0";

export interface Lease {
  executionId: string;
  /** Who holds it. A node id, a pod name, a process uuid — the deployment's vocabulary. */
  owner: string;
  /**
   * Absolute expiry (epoch ms), on the store's clock (the one `expired()` defaults to), not
   * necessarily the caller's. Past this, the lease is collectable by anyone.
   */
  expiresAt: number;
}

export interface LeaseStore {
  /**
   * Take ownership, or report that someone else has it.
   *
   * Returns the lease on success and `null` when another owner holds an unexpired one — that
   * single `null` is the mutual exclusion "only one node should run this execution" needs.
   * Re-acquiring a lease you already hold is a renewal, not a conflict: a node that restarts
   * its own work must not be locked out by its own previous claim.
   *
   * An EXPIRED lease is acquirable by anyone, which is the whole point — the previous owner
   * stopped saying it was alive.
   */
  acquire(executionId: string, owner: string, ttlMs: number, now?: number): Promise<Lease | null>;
  /**
   * Extend a lease you hold. `false` means you no longer hold it — someone else took over
   * after it expired — and a caller that keeps working on `false` is the split-brain this
   * exists to surface. Never resurrects: renewing an expired lease that another owner has
   * since taken fails rather than stealing it back.
   */
  renew(executionId: string, owner: string, ttlMs: number, now?: number): Promise<boolean>;
  /**
   * Leases past their expiry, soonest-expired first. The evidence an execution was orphaned.
   *
   * `now` is OPTIONAL (SPI 2.0.0) and an implementation MUST default it to the store's OWN
   * clock — the same one `acquire`/`renew` stamp `expiresAt` with. Expiry is only meaningful
   * judged on the clock that stamped it: a caller passing wall-clock `Date.now()` to a store
   * running on an injected/simulated clock sees every live lease as expired (a
   * double-execution hazard). Callers with no reason to override the clock
   * (`recoverAbandoned`) pass `undefined`. An implementation that still declares
   * `expired(now: number)` compiles, but given `undefined` its comparison is false (`<=
   * undefined`, SQL `<= NULL`) and it returns `[]`: recovery silently recovers nothing.
   *
   * The SQL stores' "own clock" is one clock for every node: SQLite is single-host, so the
   * process clock is its one clock; Postgres stamps and judges on DATABASE time (L29), so node
   * skew cannot make a live lease look expired or let a fast node steal one.
   */
  expired(now?: number, limit?: number): Promise<Lease[]>;
  /**
   * OPTIONAL read: the lease on an execution, or `null` if nothing holds one.
   *
   * `expired()` answers "who stopped saying they were alive", which cannot distinguish an
   * execution someone is actively renewing from one that never had a lease at all. That
   * distinction is the whole question for `orphanCensus` (#408): a stuck execution with NO
   * lease is a path nothing is watching, and counting those is how "should the runtime lease
   * every run" stops being a guess.
   */
  get?(executionId: string): Promise<Lease | null>;
  /**
   * OPTIONAL (SPI 2.1.0): the store's OWN clock, in epoch ms, the one `expiresAt` is stamped and
   * `expired()` judged on. A reader that must compare `expiresAt` to "now" outside the store
   * (`orphanCensus`) asks this rather than assuming its host's `Date.now()`, which for a shared
   * database (Postgres stamps on DB time) is a different clock. Absent means the store uses the
   * caller-visible process clock.
   */
  storeNow?(): Promise<number>;
  /** Give it up. Releasing a lease held by someone else is a no-op, never a steal. */
  release(executionId: string, owner: string): Promise<void>;
  close(): Promise<void>;
}

export interface InMemoryLeaseStoreOptions {
  /** Injectable clock, as everywhere else in the runtime. Default: `Date.now`. */
  now?: () => number;
}

/**
 * Map-backed {@link LeaseStore} — the browser-safe / test reference implementation beside the
 * durable backends. Behaviour is pinned by `runLeaseStoreConformance`.
 */
export class InMemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, Lease>();
  private readonly now: () => number;

  constructor(options: InMemoryLeaseStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  async acquire(
    executionId: string,
    owner: string,
    ttlMs: number,
    now = this.now()
  ): Promise<Lease | null> {
    assertTtl(ttlMs);
    const held = this.leases.get(executionId);
    // Someone else's, and still alive.
    if (held !== undefined && held.owner !== owner && held.expiresAt > now) return null;
    const lease: Lease = { executionId, owner, expiresAt: now + ttlMs };
    this.leases.set(executionId, lease);
    return { ...lease };
  }

  async renew(
    executionId: string,
    owner: string,
    ttlMs: number,
    now = this.now()
  ): Promise<boolean> {
    assertTtl(ttlMs);
    const held = this.leases.get(executionId);
    if (held === undefined || held.owner !== owner) return false;
    held.expiresAt = now + ttlMs;
    return true;
  }

  async expired(now = this.now(), limit = 100): Promise<Lease[]> {
    return [...this.leases.values()]
      .filter((l) => l.expiresAt <= now)
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .slice(0, limit)
      .map((l) => ({ ...l }));
  }

  async get(executionId: string): Promise<Lease | null> {
    const held = this.leases.get(executionId);
    return held !== undefined ? { ...held } : null;
  }

  async release(executionId: string, owner: string): Promise<void> {
    const held = this.leases.get(executionId);
    if (held?.owner === owner) this.leases.delete(executionId);
  }

  async close(): Promise<void> {
    this.leases.clear();
  }
}

/** A zero or negative TTL would make a lease expired on arrival — refuse it at every backend. */
export function assertTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError(`lease ttlMs must be a positive number of milliseconds, got ${ttlMs}`);
  }
}
