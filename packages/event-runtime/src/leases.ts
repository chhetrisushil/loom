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

/** SPI version for the {@link LeaseStore} contract. Pinned by `runLeaseStoreConformance`. */
export const LEASE_STORE_SPI_VERSION = "1.1.0";

export interface Lease {
  executionId: string;
  /** Who holds it. A node id, a pod name, a process uuid — the deployment's vocabulary. */
  owner: string;
  /** Absolute expiry (epoch ms). Past this, the lease is collectable by anyone. */
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
  /** Leases past their expiry, soonest-expired first. The evidence an execution was orphaned. */
  expired(now: number, limit?: number): Promise<Lease[]>;
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
