import { randomUUID } from "node:crypto";
import type { LeaseStore } from "@loom/event-runtime";

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
// The keeper keeps TWO anchors per id, monotonic and wall: the monotonic clock stops across a
// host/VM suspend (CLOCK_MONOTONIC / mach_absolute_time) while the store's clock does not. The
// lease is valid only while both are inside the window.
//
// Store-side residual: the store's own clock (Postgres `clock_timestamp()`, SQLite `Date.now()`)
// is a wall clock and can step. An NTP step FORWARD of more than the margin (ttl/6, fixed per
// ADR 0130 Q3(a)) on the store host expires live leases early, and the holder cannot see it.
// That is a store-side residual the fence (not the lease) is there to absorb.
//
// Wired into every driver by the runtime (ADR 0130 D11, S7c): `WorkflowRuntimeDeps.heartbeat`.

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

/**
 * A driver stood down: another live owner holds an unexpired lease on the execution, so this
 * attempt drives nothing and took no fence (ADR 0130 D11: lease BEFORE fence). It is a refusal,
 * not a failure of the execution: nothing was appended. `isSupersededRefusal` (`@loom/worker-runtime`)
 * settles it like a lost start race, so a dispatcher does not retry it.
 */
export class LeaseHeldError extends Error {
  constructor(readonly executionId: string) {
    super(
      `execution "${executionId}" is being driven by another live owner (an unexpired lease); this attempt stood down and took no fence. Nothing was appended.`
    );
    this.name = "LeaseHeldError";
  }
}

/** `acquire` was refused locally: the store errored recently and the keeper is in its quiet period. */
export class LeaseStoreQuietError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`lease store errored recently; no acquire attempts for another ${retryAfterMs} ms`);
    this.name = "LeaseStoreQuietError";
  }
}

/**
 * A lease-store call (acquire / release) did not answer within the keeper's bound
 * (`storeTimeoutMs`, default `min(ttl/6, 1000)` ms). Reported through `onError` for a release (the
 * lease just expires on its own); it REJECTS an acquire, which is treated as a store error (the
 * quiet period starts), so a hung store can never block a `start` forever.
 */
export class LeaseStoreTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number
  ) {
    super(`lease store ${operation} did not answer within ${timeoutMs} ms`);
    this.name = "LeaseStoreTimeoutError";
  }
}

/**
 * Marks an owner whose node runs `onStoreError: "continue"` (ADR 0130 D11 section 6). Such a node's
 * drivers keep running through a lease-store outage, so an EXPIRED lease of theirs no longer proves the
 * driver is gone: every reader treats it as a heuristic (never as evidence). The marker travels in the
 * owner string, the one field every node reads, so a stop-mode poller needs no config about its peers.
 */
export const HEURISTIC_OWNER_SUFFIX = "~continue";
/** Is `owner` a node that runs `onStoreError: "continue"`? */
export const isHeuristicOwner = (owner: string): boolean => owner.endsWith(HEURISTIC_OWNER_SUFFIX);

export interface LeaseKeeperOptions {
  store: LeaseStore;
  /**
   * What a driver does when the lease store is unreachable (ADR 0130 D11 section 6). `"stop"`
   * (default): the self-fencing deadline aborts it, so an expired lease stays TRUE evidence.
   * `"continue"`: the deadline is not enforced, drivers run through an outage (the fence still guards
   * the log; a lease the store reports taken over still stops the driver), and the owner carries
   * {@link HEURISTIC_OWNER_SUFFIX} so its expired leases are never evidence.
   */
  onStoreError?: "stop" | "continue";
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
  /**
   * Wall clock in ms. Default `Date.now`. A SECOND anchor kept beside the monotonic one: the
   * monotonic clock pauses across a host/VM suspend while the store's clock keeps going, so a
   * lease is valid only while BOTH clocks are inside the window (a wall step forward can only
   * cause a false loss, which is safe).
   */
  wallNow?: () => number;
  /** Repeating timer; returns its canceller. Default `setInterval` + `unref`. Injectable for tests. */
  every?: (fn: () => void, ms: number) => () => void;
  /**
   * One-shot timer; returns its canceller. Default `setTimeout` + `unref`. Injectable for tests. Bounds
   * every acquire/release call to the store (see `storeTimeoutMs`).
   */
  after?: (fn: () => void, ms: number) => () => void;
  /**
   * Longest an acquire or release may wait on the store before it is abandoned (ADR 0130 D11).
   * Default `min(ttl/6, 1000)` ms; it must stay within the TTL/6 margin so a settle never outlives
   * the self-fencing slack.
   */
  storeTimeoutMs?: number;
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

/** A held lease: two anchors (monotonic, wall) and an epoch that identifies THIS grant. */
interface Held {
  mono: number;
  wall: number;
  epoch: number;
}

/** One id's part of an in-flight `acquireMany`; a release arriving meanwhile sets `cancelled`. */
interface Flight {
  cancelled: boolean;
  done: Promise<void>;
}

/** A release that has not been sent yet (waiting for an in-flight acquire, or queued). */
interface PendingRelease {
  id: string;
  resolvers: Array<() => void>;
  cancelled: boolean;
}

/** An acquire parked behind an on-the-wire release of the same id. */
interface Parked {
  resolve: (held: boolean | Promise<boolean>) => void;
  cancelled: boolean;
}

interface Outcome {
  id: string;
  granted?: boolean;
  mono?: number;
  wall?: number;
  err?: unknown;
  failed?: boolean;
}

const defaultEvery = (fn: () => void, ms: number): (() => void) => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return () => clearInterval(t);
};

const defaultAfter = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

const CONNECTIVITY_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
]);

/**
 * An error that says the STORE (not one id) is unwell: connection refused/reset, timeouts, pool
 * exhaustion, Postgres admin shutdown / connection-exception / too-many-connections classes,
 * SQLITE_BUSY / SQLITE_LOCKED (after the busy timeout). Looks through `cause` and aggregates.
 */
export function isStoreWideError(err: unknown, depth = 0): boolean {
  if (err === null || typeof err !== "object" || depth > 4) return false;
  const e = err as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (typeof e.code === "string") {
    const code = e.code;
    if (CONNECTIVITY_CODES.has(code)) return true;
    if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) return true;
    if (code.startsWith("08") || code.startsWith("57P") || code === "53300") return true;
  }
  if (e.name === "TimeoutError" || e.name === "LeaseStoreTimeoutError") return true;
  if (
    typeof e.message === "string" &&
    /timed? ?out|timeout|connection (terminated|refused|reset|closed|lost)|pool|ECONN|ETIMEDOUT|database is locked/i.test(
      e.message
    )
  )
    return true;
  if (isStoreWideError(e.cause, depth + 1)) return true;
  return Array.isArray(e.errors) && e.errors.some((x) => isStoreWideError(x, depth + 1));
}

const validId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && !id.includes("\u0000");

export class LeaseKeeper {
  readonly owner: string;
  readonly ttlMs: number;
  readonly renewEveryMs: number;
  private readonly store: LeaseStore;
  private readonly continueOnError: boolean;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly margin: number;
  private readonly after: (fn: () => void, ms: number) => () => void;
  private readonly storeTimeoutMs: number;
  private readonly chunk: number;
  private readonly onLost: LeaseKeeperOptions["onLost"];
  private readonly onError: (err: unknown) => void;
  /** id -> held lease. Bounded by the live drivers: removed on release and loss. */
  private readonly held = new Map<string, Held>();
  private epochCounter = 0;
  private acquireQueue: Pending[] = [];
  private releaseQueue: PendingRelease[] = [];
  /** Releases not yet sent (waiting or queued), per id: a same-owner acquire cancels one. */
  private readonly pendingReleases = new Map<string, PendingRelease>();
  /** Releases on the wire, per id: an acquire for the id waits for it. */
  private readonly releasing = new Map<string, Promise<void>>();
  /**
   * Releases whose CALLER-facing call timed out but whose underlying store call has not settled, per
   * id (the promise resolves when it finally does, success or failure). The store may still apply
   * it, so a same-owner re-acquire waits for it (bounded) instead of landing a row it would delete.
   */
  private readonly lateReleases = new Map<string, Promise<void>>();
  /** Acquires on the wire, per id: a release marks them cancelled and goes after them. */
  private readonly acquiring = new Map<string, Set<Flight>>();
  /** Acquires parked behind an on-the-wire release, per id: a later release() withdraws them. */
  private readonly parked = new Map<string, Parked[]>();
  /** The id of the previous flush's lone failure (consecutive different ids = store-wide). */
  private loneFailure: string | undefined;
  private acquireScheduled = false;
  private releaseScheduled = false;
  private quietUntil = Number.NEGATIVE_INFINITY;
  private renewsInFlight = 0;
  private closed = false;
  private readonly stopTimers: Array<() => void> = [];

  constructor(options: LeaseKeeperOptions) {
    this.store = options.store;
    this.ttlMs = options.ttlMs ?? 30_000;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0)
      throw new TypeError("LeaseKeeper: ttlMs must be a finite number > 0");
    this.margin = Math.floor(this.ttlMs / 6);
    this.renewEveryMs = options.renewEveryMs ?? Math.max(Math.floor(this.ttlMs / 3), 1);
    if (
      !Number.isFinite(this.renewEveryMs) ||
      this.renewEveryMs <= 0 ||
      this.renewEveryMs >= this.ttlMs - this.margin
    )
      throw new TypeError(
        "LeaseKeeper: renewEveryMs must be > 0 and < ttlMs - margin (margin = floor(ttlMs / 6))"
      );
    this.after = options.after ?? defaultAfter;
    this.storeTimeoutMs = options.storeTimeoutMs ?? Math.max(1, Math.min(this.margin, 1000));
    if (!Number.isFinite(this.storeTimeoutMs) || this.storeTimeoutMs <= 0)
      throw new TypeError("LeaseKeeper: storeTimeoutMs must be a finite number > 0");
    this.chunk = options.chunkSize ?? 1000;
    if (!Number.isInteger(this.chunk) || this.chunk < 1)
      throw new TypeError("LeaseKeeper: chunkSize must be an integer >= 1");
    if (
      (options.onStoreError as unknown) !== undefined &&
      options.onStoreError !== "stop" &&
      options.onStoreError !== "continue"
    )
      throw new TypeError('LeaseKeeper: onStoreError must be "stop" or "continue"');
    this.continueOnError = options.onStoreError === "continue";
    this.owner = `${options.nodeId}:${options.incarnation ?? randomUUID()}${
      this.continueOnError ? HEURISTIC_OWNER_SUFFIX : ""
    }`;
    this.now = options.monotonicNow ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
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

  /** The lease store this keeper writes to (readers of the evidence consult the SAME one). */
  get leaseStore(): LeaseStore {
    return this.store;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** `onStoreError: "continue"`: this node's leases are heuristic (see {@link HEURISTIC_OWNER_SUFFIX}). */
  get heuristic(): boolean {
    return this.continueOnError;
  }

  /** The keeper's monotonic clock (injectable), for readers that need a quiet period on the same timeline. */
  monotonicNow(): number {
    return this.now();
  }

  /**
   * Run `fn` once after `ms` on the keeper's (injectable, unref'd) one-shot timer; returns its
   * canceller. The lazy driver hold (ADR 0130 D11, S7g) uses it for its grace period, so a test that
   * injects `after` drives the grace window on the same virtual clock.
   */
  schedule(fn: () => void, ms: number): () => void {
    return this.after(fn, ms);
  }

  /** Number of leases currently held (bounded memory: released and lost ids are gone). */
  get size(): number {
    return this.held.size;
  }

  /**
   * True only while the lease is held AND neither local deadline (monotonic, wall) has passed.
   * A clock compare, no I/O: the gate a driver checks before dispatching an effect or appending.
   * Observing an expiry reports it (`onLost`, once) so the transition is never silent.
   *
   * NOTE for callers: `onLost` (and so any abort listener a driver hangs on it) may run
   * SYNCHRONOUSLY inside this call, before it returns `false`. Do not call it while holding a
   * lock the listener needs, and expect re-entrancy.
   */
  validNow(executionId: string): boolean {
    const h = this.held.get(executionId);
    if (h === undefined) return false;
    if (this.expired(h)) {
      this.lose(executionId, "deadline");
      return false;
    }
    return true;
  }

  /**
   * Take the lease. `true` = held; `false` = another owner holds an unexpired one (stand down),
   * or the caller released the id meanwhile. Concurrent calls within a tick coalesce into one
   * `acquireMany`. Rejects with {@link LeaseStoreQuietError} during the quiet period after a
   * store error, with a TypeError for an invalid id, or with the store's own error for that id.
   *
   * Per id, operations are serialised: an acquire for an id whose release is queued cancels the
   * release (same owner: it is a renewal); one whose release is on the wire waits for it.
   */
  acquire(executionId: string): Promise<boolean> {
    if (this.closed) return Promise.reject(new Error("LeaseKeeper is closed"));
    if (!validId(executionId))
      return Promise.reject(
        new TypeError("LeaseKeeper: executionId must be a non-empty string without NUL")
      );
    if (this.validNow(executionId)) return Promise.resolve(true);
    const wire = this.releasing.get(executionId);
    if (wire) {
      return new Promise<boolean>((resolve) => {
        const p: Parked = { resolve, cancelled: false };
        const list = this.parked.get(executionId);
        if (list) list.push(p);
        else this.parked.set(executionId, [p]);
        void wire.then(() => {
          const l = this.parked.get(executionId);
          if (l) {
            const i = l.indexOf(p);
            if (i >= 0) l.splice(i, 1);
            if (l.length === 0) this.parked.delete(executionId);
          }
          if (!p.cancelled) resolve(this.acquire(executionId));
        });
      });
    }
    const late = this.lateReleases.get(executionId);
    if (late) {
      // A release the store has not answered may still be applied. Sending the acquire now could
      // land a row that release then deletes (validNow true with no row). Wait for it to settle,
      // at most one more storeTimeoutMs; a store that still does not answer rejects the acquire.
      return new Promise<boolean>((resolve, reject) => {
        const p: Parked = { resolve, cancelled: false };
        const list = this.parked.get(executionId);
        if (list) list.push(p);
        else this.parked.set(executionId, [p]);
        const unpark = (): void => {
          const l = this.parked.get(executionId);
          if (l) {
            const i = l.indexOf(p);
            if (i >= 0) l.splice(i, 1);
            if (l.length === 0) this.parked.delete(executionId);
          }
        };
        const cancel = this.after(() => {
          unpark();
          if (p.cancelled) return;
          p.cancelled = true;
          reject(new LeaseStoreTimeoutError("release", this.storeTimeoutMs));
        }, this.storeTimeoutMs);
        void late.then(() => {
          cancel();
          unpark();
          if (!p.cancelled) resolve(this.acquire(executionId));
        });
      });
    }
    const remaining = this.quietUntil - this.now();
    if (remaining > 0) return Promise.reject(new LeaseStoreQuietError(Math.ceil(remaining)));
    const superseded = this.pendingReleases.get(executionId);
    if (superseded) {
      superseded.cancelled = true;
      this.pendingReleases.delete(executionId);
      for (const r of superseded.resolvers) r();
    }
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
   * the lease just expires. A release issued while an acquire for the id is on the wire is sent
   * AFTER it, and that acquire resolves `false` without taking the id.
   */
  release(executionId: string): Promise<void> {
    this.held.delete(executionId);
    if (this.closed || !validId(executionId)) return Promise.resolve();
    // An acquire parked behind an on-the-wire release is withdrawn too: it must not run later
    // and undo this release.
    const parked = this.parked.get(executionId);
    if (parked) {
      this.parked.delete(executionId);
      for (const p of parked) {
        p.cancelled = true;
        p.resolve(false);
      }
    }
    // An acquire still queued is simply withdrawn.
    if (this.acquireQueue.some((p) => p.id === executionId)) {
      const keep: Pending[] = [];
      for (const p of this.acquireQueue) p.id === executionId ? p.resolve(false) : keep.push(p);
      this.acquireQueue = keep;
    }
    return new Promise<void>((resolve) => {
      const existing = this.pendingReleases.get(executionId);
      if (existing) {
        existing.resolvers.push(resolve);
        return;
      }
      const r: PendingRelease = { id: executionId, resolvers: [resolve], cancelled: false };
      this.pendingReleases.set(executionId, r);
      const flights = this.acquiring.get(executionId);
      if (flights && flights.size > 0) {
        const dones: Array<Promise<void>> = [];
        for (const f of flights) {
          f.cancelled = true;
          dones.push(f.done);
        }
        void Promise.all(dones).then(() => this.queueRelease(r));
      } else this.queueRelease(r);
    });
  }

  /**
   * Stop keeping the lease WITHOUT giving it up (ADR 0130 D11, S7d round 3). The id leaves the held
   * set at once (no more renewals, `validNow` false, no `onLost`), but the store row is NOT touched:
   * it expires on its own after the TTL, and an expired row IS the liveness evidence a retry of an
   * attempt that failed needs (a released row is absent, which proves nothing). No store call, so it
   * is synchronous and cannot fail. A same-owner `acquire` afterwards works as any other (it renews
   * the row if it still exists, or takes it once expired). Use `release` when the work succeeded.
   * It does not cancel an acquire already on the wire: callers serialise (see `DriverLeases`).
   */
  forget(executionId: string): void {
    this.held.delete(executionId);
  }

  /** Stop the timers, fail pending acquires, and release everything still held (awaited). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.stopTimers) stop();
    const pending = this.acquireQueue;
    this.acquireQueue = [];
    for (const p of pending) p.reject(new Error("LeaseKeeper is closed"));
    const rels = [...this.pendingReleases.values()];
    this.pendingReleases.clear();
    this.releaseQueue = [];
    for (const r of rels) r.cancelled = true;
    const ids = [...new Set([...this.held.keys(), ...rels.map((r) => r.id)])];
    // Every driver still holding a lease is told (onLost "closed"): a run must not keep driving,
    // or hold a hold, on a lease nothing renews any more.
    for (const id of [...this.held.keys()]) this.lose(id, "closed");
    this.held.clear();
    await this.releaseIds(ids);
    for (const r of rels) for (const f of r.resolvers) f();
  }

  /** One renew round. Public so a test (or a host with its own scheduler) can drive it. */
  async tick(): Promise<void> {
    this.enforceDeadlines();
    if (this.closed || this.held.size === 0) return;
    // A store that hangs must not stack unbounded calls; the watchdog still enforces deadlines.
    if (this.renewsInFlight >= 3) return;
    const epochs = new Map<string, number>();
    for (const [id, h] of this.held) epochs.set(id, h.epoch);
    const ids = [...epochs.keys()];
    const sentMono = this.now();
    const sentWall = this.wallNow();
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
          const h = this.held.get(id);
          // Released, lost, or released and RE-acquired meanwhile: this answer is about a
          // grant that no longer exists.
          if (!h || h.epoch !== epochs.get(id)) continue;
          if (!held.has(id)) {
            this.lose(id, "taken-over");
          } else if (this.expired(h)) {
            // A confirmation that arrives after the deadline proves nothing about the gap.
            this.lose(id, "deadline");
          } else {
            const mono = sentMono + this.ttlMs - this.margin;
            if (mono > h.mono) h.mono = mono;
            const wall = sentWall + this.ttlMs - this.margin;
            if (wall > h.wall) h.wall = wall;
          }
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

  private expired(h: Held): boolean {
    // "continue": the deadline is the one thing an outage must not enforce; a lease the store reports
    // taken over (`renewMany` omits it) still ends the hold in `tick`.
    if (this.continueOnError) return false;
    return this.now() >= h.mono || this.wallNow() >= h.wall;
  }

  private enforceDeadlines(): void {
    for (const [id, h] of [...this.held]) if (this.expired(h)) this.lose(id, "deadline");
  }

  private lose(id: string, reason: "taken-over" | "deadline" | "closed"): void {
    if (!this.held.delete(id)) return;
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

  /**
   * Race a store call against the keeper's bound. A call that never answers rejects with
   * {@link LeaseStoreTimeoutError}; its late result (if it ever comes) is ignored, and the row it
   * may have written simply expires.
   */
  private bounded<T>(
    operation: string,
    call: () => Promise<T>,
    onTimeout?: (underlying: Promise<T>) => void
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let p: Promise<T>;
      try {
        p = call();
      } catch (err) {
        reject(err);
        return;
      }
      const cancel = this.after(() => {
        reject(new LeaseStoreTimeoutError(operation, this.storeTimeoutMs));
        onTimeout?.(p);
      }, this.storeTimeoutMs);
      p.then(
        (v) => {
          cancel();
          resolve(v);
        },
        (e: unknown) => {
          cancel();
          reject(e);
        }
      );
    });
  }

  /** One acquire call's outcome per id. A batch error is re-tried per id to isolate the offender. */
  private async acquireChunk(
    c: string[],
    fails: { n: number; first?: unknown; firstId?: string; wide?: boolean }
  ): Promise<Outcome[]> {
    const note = (id: string, err: unknown): void => {
      fails.n++;
      if (fails.n === 1) fails.firstId = id;
      fails.first ??= err;
      if (isStoreWideError(err)) fails.wide = true;
    };
    const single = async (id: string): Promise<Outcome> => {
      const mono = this.now();
      const wall = this.wallNow();
      try {
        const l = this.store.acquireMany
          ? (
              await this.bounded("acquire", () =>
                (this.store.acquireMany as NonNullable<LeaseStore["acquireMany"]>)(
                  [id],
                  this.owner,
                  this.ttlMs
                )
              )
            )[0]
          : await this.bounded("acquire", () => this.store.acquire(id, this.owner, this.ttlMs));
        return { id, granted: Boolean(l), mono, wall };
      } catch (err) {
        note(id, err);
        return { id, failed: true, err };
      }
    };
    if (!this.store.acquireMany) {
      // No batch method: every id is its own call and already isolated.
      const mono = this.now();
      const wall = this.wallNow();
      const rs = await Promise.allSettled(
        c.map((id) => this.bounded("acquire", () => this.store.acquire(id, this.owner, this.ttlMs)))
      );
      return rs.map((r, i): Outcome => {
        const id = c[i] as string;
        if (r.status === "fulfilled") return { id, granted: r.value !== null, mono, wall };
        note(id, r.reason);
        return { id, failed: true, err: r.reason };
      });
    }
    const mono = this.now();
    const wall = this.wallNow();
    try {
      const acquireMany = this.store.acquireMany;
      const got = new Set(
        (
          await this.bounded("acquire", () =>
            acquireMany.call(this.store, c, this.owner, this.ttlMs)
          )
        ).map((l) => l.executionId)
      );
      return c.map((id) => ({ id, granted: got.has(id), mono, wall }));
    } catch (err) {
      if (c.length === 1) {
        note(c[0] as string, err);
        return [{ id: c[0] as string, failed: true, err }];
      }
      const out: Outcome[] = [];
      for (const id of c) {
        if (fails.n >= 2) out.push({ id, failed: true, err: fails.first });
        else out.push(await single(id));
      }
      return out;
    }
  }

  private async flushAcquires(): Promise<void> {
    this.acquireScheduled = false;
    const batch = this.acquireQueue;
    this.acquireQueue = [];
    if (batch.length === 0) return;
    const byId = new Map<string, Pending[]>();
    for (const p of batch) {
      const l = byId.get(p.id);
      if (l) l.push(p);
      else byId.set(p.id, [p]);
    }
    const ids = [...byId.keys()];
    let finish!: () => void;
    const done = new Promise<void>((r) => {
      finish = r;
    });
    const flights = new Map<string, Flight>();
    for (const id of ids) {
      const f: Flight = { cancelled: false, done };
      flights.set(id, f);
      const set = this.acquiring.get(id);
      if (set) set.add(f);
      else this.acquiring.set(id, new Set([f]));
    }
    const fails: { n: number; first?: unknown; firstId?: string; wide?: boolean } = { n: 0 };
    try {
      for (const c of chunks(ids, this.chunk)) {
        const outcomes: Outcome[] =
          fails.n >= 2
            ? c.map((id) => ({ id, failed: true, err: fails.first }))
            : await this.acquireChunk(c, fails);
        const toRelease: string[] = [];
        const settle: Array<() => void> = [];
        for (const o of outcomes) {
          const ps = byId.get(o.id) as Pending[];
          const flight = flights.get(o.id) as Flight;
          if (o.failed) {
            settle.push(...ps.map((p) => () => p.reject(o.err)));
            continue;
          }
          let result = false;
          if (o.granted) {
            const mono = (o.mono as number) + this.ttlMs - this.margin;
            const wall = (o.wall as number) + this.ttlMs - this.margin;
            if (this.closed) toRelease.push(o.id);
            else if (!flight.cancelled && (this.now() >= mono || this.wallNow() >= wall)) {
              // Answered after its own deadline: holding it would only fire onLost("deadline")
              // on first use. Give the row back and report "not held".
              toRelease.push(o.id);
            } else if (!flight.cancelled) {
              this.held.set(o.id, {
                mono,
                wall,
                epoch: ++this.epochCounter,
              });
              result = true;
            }
            // cancelled: the release that cancelled us is sent after `done`.
          }
          settle.push(...ps.map((p) => () => p.resolve(result)));
        }
        if (toRelease.length > 0) await this.releaseIds(toRelease);
        for (const s of settle) s();
      }
      // Only a store-wide error (connectivity class), two failures in one flush, or lone
      // failures on two consecutive flushes with DIFFERENT ids arm the quiet period; a single
      // id-specific rejection (length limit, constraint, bad byte) rejects just that id.
      if (fails.n === 0) this.loneFailure = undefined;
      else if (fails.n >= 2 || fails.wide) {
        this.loneFailure = undefined;
        this.failed(fails.first);
      } else if (this.loneFailure !== undefined && this.loneFailure !== fails.firstId) {
        this.loneFailure = undefined;
        this.failed(fails.first);
      } else this.loneFailure = fails.firstId;
    } finally {
      for (const [id, f] of flights) {
        const set = this.acquiring.get(id);
        set?.delete(f);
        if (set && set.size === 0) this.acquiring.delete(id);
      }
      finish();
    }
  }

  private queueRelease(r: PendingRelease): void {
    if (r.cancelled) return;
    if (this.closed) {
      r.cancelled = true;
      for (const f of r.resolvers) f();
      return;
    }
    this.releaseQueue.push(r);
    if (!this.releaseScheduled) {
      this.releaseScheduled = true;
      queueMicrotask(() => void this.flushReleases());
    }
  }

  private async flushReleases(): Promise<void> {
    this.releaseScheduled = false;
    const batch = this.releaseQueue.filter((r) => !r.cancelled);
    this.releaseQueue = [];
    if (batch.length === 0) return;
    for (const r of batch)
      if (this.pendingReleases.get(r.id) === r) this.pendingReleases.delete(r.id);
    const ids = batch.map((r) => r.id);
    const prevs: Array<Promise<void>> = [];
    for (const id of ids) {
      const p = this.releasing.get(id);
      if (p) prevs.push(p);
    }
    const work: Promise<void> = Promise.all(prevs)
      .then(() => this.releaseIds(ids))
      .then(() => {
        for (const id of ids) if (this.releasing.get(id) === work) this.releasing.delete(id);
      });
    for (const id of ids) this.releasing.set(id, work);
    await work;
    for (const r of batch) for (const f of r.resolvers) f();
  }

  /**
   * Best-effort: a failing chunk is re-tried per id so one bad id cannot strand the rest. Every
   * store call is bounded: a release the store never answers is abandoned (reported through
   * `onError`; the lease expires on its own) so the handle that awaits it, and any acquire parked
   * behind it, settle. A TIMED-OUT chunk is not retried per id (the store is not answering).
   */
  private async releaseIds(ids: string[]): Promise<void> {
    // A timed-out release is still on the wire: remember it per id until it truly settles.
    const late =
      (c: string[]) =>
      (underlying: Promise<unknown>): void => {
        const settled = underlying.then(
          () => undefined,
          () => undefined
        );
        for (const id of c) {
          this.lateReleases.set(id, settled);
          void settled.then(() => {
            if (this.lateReleases.get(id) === settled) this.lateReleases.delete(id);
          });
        }
      };
    const one = async (id: string): Promise<void> => {
      try {
        await this.bounded("release", () => this.store.release(id, this.owner), late([id]));
      } catch (err) {
        this.onError(err);
      }
    };
    for (const c of chunks(ids, this.chunk)) {
      try {
        if (this.store.releaseMany) {
          const releaseMany = this.store.releaseMany;
          await this.bounded("release", () => releaseMany.call(this.store, c, this.owner), late(c));
        } else
          await this.bounded(
            "release",
            () =>
              Promise.all(c.map((id) => this.store.release(id, this.owner))).then(() => undefined),
            late(c)
          );
      } catch (err) {
        this.onError(err);
        if (c.length > 1 && !(err instanceof LeaseStoreTimeoutError))
          for (const id of c) await one(id);
      }
    }
  }
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
