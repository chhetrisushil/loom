import { randomUUID } from "node:crypto";
import type { Lease, LeaseStore } from "@loom/event-runtime";

// ── One lease keeper per node (ADR 0130 D11, S7b) ─────────────────────────────
//
// `renewWhileHeld` runs one timer and one store call per held execution. A node that leases
// EVERY driver would turn that into thousands of statements per tick against the store that
// is already the throughput bottleneck. The keeper is the batched form: one timer, one set of
// held ids, group-committed acquire/release, ONE renew per tick for everything the node holds.
//
// The lease is LIVENESS EVIDENCE for other nodes; the fence stays the only write guard. The
// keeper's second job is therefore to make that evidence true from the holder's side: a driver
// that cannot confirm a renewal stops itself at a local MONOTONIC deadline
// (`lastRenewSent + ttl - ttl/6`), before the store's clock can let anyone else take over.
// The deadline is measured from just BEFORE the request was sent, so only clock RATE drift
// matters, never offset, and the TTL/6 margin covers it.
//
// Not wired into any driver yet (S7c).

/** The lease this node held is gone, or could not be confirmed before its local deadline. */
export class LeaseLostError extends Error {
  readonly executionId: string;
  readonly owner: string;
  readonly reason: "taken-over" | "deadline" | "closed";
  constructor(executionId: string, owner: string, reason: "taken-over" | "deadline" | "closed") {
    super(
      reason === "taken-over"
        ? `lease lost: "${owner}" no longer owns "${executionId}" — another node may have recovered it`
        : reason === "deadline"
          ? `lease lost: no confirmed renewal of "${executionId}" before the self-fencing deadline`
          : `lease lost: the keeper for "${owner}" was closed while holding "${executionId}"`
    );
    this.name = "LeaseLostError";
    this.executionId = executionId;
    this.owner = owner;
    this.reason = reason;
  }
}

/** `acquire` was refused locally: the store errored recently and the keeper is in its quiet period. */
export class LeaseStoreQuietError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`lease store errored recently; no acquire attempts for another ${retryAfterMs} ms`);
    this.name = "LeaseStoreQuietError";
  }
}

// Replaced by the S7a SPI types (`LeaseStore` 2.2.0) on merge. Structural, so a store with the
// real methods satisfies it, and a 2.1.0 store simply lacks them.
export interface BatchLeaseStore {
  acquireMany?(
    executionIds: readonly string[],
    owner: string,
    ttlMs: number,
    now?: number
  ): Promise<Lease[]>;
  renewMany?(
    executionIds: readonly string[],
    owner: string,
    ttlMs: number,
    now?: number
  ): Promise<string[]>;
  releaseMany?(executionIds: readonly string[], owner: string): Promise<void>;
}

export interface LeaseKeeperOptions {
  store: LeaseStore;
  /** This node's id; the owner is `<nodeId>:<incarnation>`. */
  nodeId: string;
  /** A fresh uuid per process start by default, so a restarted pod never inherits its predecessor's leases. */
  incarnation?: string;
  /** Default 30 000. */
  ttlMs?: number;
  /** Default ttl/3 (10 000). */
  renewEveryMs?: number;
  /** Monotonic clock in ms. Default `performance.now()`. NEVER wall time. */
  monotonicNow?: () => number;
  /** Repeating timer; returns its canceller. Default `setInterval` + `unref`. Injectable for tests. */
  every?: (fn: () => void, ms: number) => () => void;
  /** Fires once per id when it is lost; the id is already removed. */
  onLost: (executionId: string, err: LeaseLostError) => void;
  /** Store errors and failed releases (never thrown). */
  onError?: (err: unknown) => void;
  /** Ids per batched call. Default 1000. */
  chunkSize?: number;
}

interface Pending {
  id: string;
  resolve: (held: boolean) => void;
  reject: (err: unknown) => void;
}

const defaultEvery = (fn: () => void, ms: number): (() => void) => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return () => clearInterval(t);
};

export class LeaseKeeper {
  readonly owner: string;
  readonly ttlMs: number;
  readonly renewEveryMs: number;
  private readonly store: LeaseStore & BatchLeaseStore;
  private readonly now: () => number;
  private readonly margin: number;
  private readonly chunk: number;
  private readonly onLost: LeaseKeeperOptions["onLost"];
  private readonly onError: (err: unknown) => void;
  /** id -> local monotonic deadline. Bounded by the live drivers: removed on release and loss. */
  private readonly deadlines = new Map<string, number>();
  private acquireQueue: Pending[] = [];
  private releaseQueue: Array<{ id: string; resolve: () => void }> = [];
  private acquireScheduled = false;
  private releaseScheduled = false;
  private quietUntil = Number.NEGATIVE_INFINITY;
  private renewsInFlight = 0;
  private closed = false;
  private readonly stopTimers: Array<() => void> = [];

  constructor(options: LeaseKeeperOptions) {
    this.store = options.store;
    this.ttlMs = options.ttlMs ?? 30_000;
    this.renewEveryMs = options.renewEveryMs ?? Math.max(Math.floor(this.ttlMs / 3), 1);
    this.margin = Math.floor(this.ttlMs / 6);
    this.owner = `${options.nodeId}:${options.incarnation ?? randomUUID()}`;
    this.now = options.monotonicNow ?? (() => performance.now());
    this.chunk = options.chunkSize ?? 1000;
    this.onLost = options.onLost;
    this.onError = options.onError ?? (() => {});
    const every = options.every ?? defaultEvery;
    this.stopTimers.push(every(() => void this.tick(), this.renewEveryMs));
    // The watchdog is what makes the deadline hold when the store never answers: it needs a
    // finer grain than the renew tick, or a deadline could be overshot by a whole period.
    this.stopTimers.push(
      every(() => this.enforceDeadlines(), Math.max(Math.floor(this.ttlMs / 12), 1))
    );
  }

  /** Number of leases currently held (bounded memory: released and lost ids are gone). */
  get size(): number {
    return this.deadlines.size;
  }

  /**
   * True only while the lease is held AND the local monotonic deadline has not passed. A clock
   * compare, no I/O: the gate a driver checks before dispatching an effect or appending.
   */
  validNow(executionId: string): boolean {
    const deadline = this.deadlines.get(executionId);
    return deadline !== undefined && this.now() < deadline;
  }

  /**
   * Take the lease. `true` = held; `false` = another owner holds an unexpired one (stand down).
   * Concurrent calls within a tick coalesce into one `acquireMany`. Rejects with
   * {@link LeaseStoreQuietError} during the quiet period after a store error, or with the
   * store's own error.
   */
  acquire(executionId: string): Promise<boolean> {
    if (this.closed) return Promise.reject(new Error("LeaseKeeper is closed"));
    if (this.validNow(executionId)) return Promise.resolve(true);
    const remaining = this.quietUntil - this.now();
    if (remaining > 0) return Promise.reject(new LeaseStoreQuietError(Math.ceil(remaining)));
    return new Promise<boolean>((resolve, reject) => {
      this.acquireQueue.push({ id: executionId, resolve, reject });
      if (!this.acquireScheduled) {
        this.acquireScheduled = true;
        queueMicrotask(() => void this.flushAcquires());
      }
    });
  }

  /**
   * Give the lease up and wait for the store. The id leaves the held set immediately (no
   * `onLost` fires for a release). A failing release is reported to `onError`, never thrown:
   * the lease just expires.
   */
  release(executionId: string): Promise<void> {
    this.deadlines.delete(executionId);
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.releaseQueue.push({ id: executionId, resolve });
      if (!this.releaseScheduled) {
        this.releaseScheduled = true;
        queueMicrotask(() => void this.flushReleases());
      }
    });
  }

  /** Stop the timers, fail pending acquires, and release everything still held (awaited). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.stopTimers) stop();
    const pending = this.acquireQueue;
    this.acquireQueue = [];
    for (const p of pending) p.reject(new Error("LeaseKeeper is closed"));
    const queued = this.releaseQueue;
    this.releaseQueue = [];
    const ids = [...new Set([...this.deadlines.keys(), ...queued.map((q) => q.id)])];
    this.deadlines.clear();
    await this.releaseIds(ids);
    for (const q of queued) q.resolve();
  }

  /** One renew round. Public so a test (or a host with its own scheduler) can drive it. */
  async tick(): Promise<void> {
    this.enforceDeadlines();
    if (this.closed || this.deadlines.size === 0) return;
    // A store that hangs must not stack unbounded calls; the watchdog still enforces deadlines.
    if (this.renewsInFlight >= 3) return;
    const ids = [...this.deadlines.keys()];
    const sentAt = this.now();
    this.renewsInFlight++;
    try {
      const results = await Promise.all(
        chunks(ids, this.chunk).map((c) =>
          this.renewChunk(c).then(
            (held) => ({ c, held }),
            (err: unknown) => {
              this.failed(err);
              return { c, held: undefined };
            }
          )
        )
      );
      for (const { c, held } of results) {
        if (!held) continue; // failure: no deadline extension, the watchdog decides
        for (const id of c) {
          if (!this.deadlines.has(id)) continue; // released or lost meanwhile
          if (held.has(id)) {
            const next = sentAt + this.ttlMs - this.margin;
            if (next > (this.deadlines.get(id) as number)) this.deadlines.set(id, next);
          } else this.lose(id, "taken-over");
        }
      }
    } finally {
      this.renewsInFlight--;
    }
  }

  private async renewChunk(ids: string[]): Promise<Set<string>> {
    if (this.store.renewMany)
      return new Set(await this.store.renewMany(ids, this.owner, this.ttlMs));
    const held = new Set<string>();
    const outcomes = await Promise.all(
      ids.map((id) => this.store.renew(id, this.owner, this.ttlMs).then((ok) => ({ id, ok })))
    );
    for (const o of outcomes) if (o.ok) held.add(o.id);
    return held;
  }

  private enforceDeadlines(): void {
    const t = this.now();
    for (const [id, deadline] of this.deadlines) if (t >= deadline) this.lose(id, "deadline");
  }

  private lose(id: string, reason: "taken-over" | "deadline"): void {
    if (!this.deadlines.delete(id)) return;
    try {
      this.onLost(id, new LeaseLostError(id, this.owner, reason));
    } catch (err) {
      this.onError(err);
    }
  }

  private failed(err: unknown): void {
    this.quietUntil = this.now() + this.ttlMs;
    this.onError(err);
  }

  private async flushAcquires(): Promise<void> {
    this.acquireScheduled = false;
    const batch = this.acquireQueue;
    this.acquireQueue = [];
    if (batch.length === 0) return;
    const ids = [...new Set(batch.map((p) => p.id))];
    const sentAt = this.now();
    const granted = new Set<string>();
    let failure: { err: unknown } | undefined;
    for (const c of chunks(ids, this.chunk)) {
      try {
        if (this.store.acquireMany) {
          for (const l of await this.store.acquireMany(c, this.owner, this.ttlMs))
            granted.add(l.executionId);
        } else {
          const got = await Promise.all(
            c.map((id) =>
              this.store.acquire(id, this.owner, this.ttlMs).then((l) => (l ? id : null))
            )
          );
          for (const id of got) if (id) granted.add(id);
        }
      } catch (err) {
        failure = { err };
        this.failed(err);
        break;
      }
    }
    for (const id of granted) {
      if (this.closed) break;
      this.deadlines.set(id, sentAt + this.ttlMs - this.margin);
    }
    for (const p of batch) {
      if (failure) p.reject(failure.err);
      else p.resolve(granted.has(p.id) && !this.closed);
    }
  }

  private async flushReleases(): Promise<void> {
    this.releaseScheduled = false;
    const batch = this.releaseQueue;
    this.releaseQueue = [];
    if (batch.length === 0) return;
    await this.releaseIds([...new Set(batch.map((q) => q.id))]);
    for (const q of batch) q.resolve();
  }

  private async releaseIds(ids: string[]): Promise<void> {
    for (const c of chunks(ids, this.chunk)) {
      try {
        if (this.store.releaseMany) await this.store.releaseMany(c, this.owner);
        else await Promise.all(c.map((id) => this.store.release(id, this.owner)));
      } catch (err) {
        this.onError(err);
      }
    }
  }
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
