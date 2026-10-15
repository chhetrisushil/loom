import { randomUUID } from "node:crypto";
import type { LeaseStore } from "@loom/event-runtime";
import {
  type AcquireOutcome,
  LeaseKeeper,
  type LeaseKeeperOptions,
  LeaseLostError,
  LeaseStoreQuietError,
  LeaseStoreTimeoutError,
} from "./leaseKeeper";

// ── The runtime's drivers hold heartbeat leases (ADR 0130 D11, S7c) ─────────────────────────────
//
// ONE `LeaseKeeper` per runtime (one renew timer, group-committed acquire/release), and this thin
// layer above it that gives every DRIVER of an execution a reference-counted hold:
//
//  - the runtime's own run (`start`, `resume`, the `send`/notify winner, a successor, ...) takes a
//    hold before its first append and releases it at the suspend/terminal commit (S7g: only a FRESH
//    `start` of a stream that does not exist yet may take that hold lazily; see `acquireFresh`);
//  - the poll and the sweep (`TimerService`, `recoverAbandoned`) and a local worker take a hold
//    BEFORE the fence and keep it across the resumed run, which takes its own hold on top.
//
// The keeper's lease is released only when the LAST hold on the id is released, so a claimant can
// never drop the lease out from under the run it started (the run's settle comes first), and a run
// that settled can never drop one a later claimant re-took. A lease the keeper reports lost
// invalidates every hold on it at once (a stale hold's later `release` is then a no-op, so it cannot
// release a lease a LATER driver took).
//
// Unwired (no `heartbeat` dep) the runtime has no `DriverLeases` at all and
// every path is byte-identical to before (G2).

/**
 * `WorkflowRuntimeDeps.heartbeat` (ADR 0130 D11). Absent = disabled, byte-identical to today. The
 * runtime owns ONE `LeaseKeeper` built from it. Defaults: ttl 30 000 ms, renew every ttl/3,
 * `onStoreError: "stop"`, `nodeId` a stable per-process id. The remaining fields are test seams
 * (fake clocks and timers) and tuning.
 */
export interface HeartbeatOptions
  extends Partial<
    Omit<LeaseKeeperOptions, "onLost" | "store" | "nodeId" | "ttlMs" | "renewEveryMs">
  > {
  leaseStore: LeaseStore;
  ttlMs?: number;
  renewEveryMs?: number;
  /**
   * `"stop"` (default): a driver that cannot confirm a renewal stops at its deadline, so an expired
   * lease is true evidence. The same holds for a lazy run whose delayed acquire has an UNKNOWN outcome
   * (a store error or timeout: the row may exist): it stops at the send time + ttl - margin unless a
   * re-acquire confirms first. A run whose acquire provably sent nothing (the keeper's quiet period, a
   * bad id) is unleased, which is no evidence, and drives on; a fresh-start lazy run on a node
   * partitioned from the lease store therefore drives unleased inside its grace (the fence protects the
   * log). `"continue"` (ADR 0130 D11 section 6, S7d): drivers keep running through a lease-store outage
   * (no self-fence abort at the deadline, and only a store-confirmed lease taken over by another owner
   * ends a driver; its retries apply only to the `"stop"` mode); a driver that cannot even acquire a
   * lease during the outage runs unleased; the fence still guards the log, but the lease no longer
   * proves liveness, so this node's leases carry a heuristic owner marker and its poll's default
   * re-drive is off (re-drive only with `isAbandoned`, as before S7).
   */
  onStoreError?: "stop" | "continue";
  /**
   * WHEN a run takes its lease (ADR 0130 D11 option 2, S7g). `"lazy"` (DEFAULT): a FRESH START (a new
   * execution id whose stream does not exist yet: `start`, which `runAgentOnce` calls) takes NO lease
   * while it is young; only a run still going after {@link lazyGraceMs} acquires one (so a short
   * execution costs the lease store nothing). Every other entry is EAGER in both modes, because a
   * predecessor's leftover lease row may exist: `resume` (the `send`/notify winner included),
   * `resumeAs`, `restoreFromState`, a continue-as-new successor, a start on an id whose stream already
   * exists, and the claims whose lease IS the evidence (the poll's and the sweep's re-drive, a timer
   * fire, a local worker attempt). `"eager"`: every run leases before its first append (S7c).
   *
   * What lazy gives up: a fresh run that dies INSIDE its grace window left no lease, and an absent
   * lease is no evidence, so that crash is recovered only by a host `isAbandoned` (as before S7), and a
   * lease cannot veto a heuristic during the window.
   */
  acquire?: "eager" | "lazy";
  /**
   * Lazy mode: how long a run goes unleased before it acquires. Default `renewEveryMs` (ttl/3, 10 s).
   * Must be a finite number >= 0 (`0` acquires on the next timer turn).
   */
  lazyGraceMs?: number;
  nodeId?: string;
}

/** @deprecated alias kept for the internal name. */
export type HeartbeatDeps = HeartbeatOptions;

const PROCESS_NODE_ID = `node-${process.pid}-${randomUUID().slice(0, 8)}`;

/** A driver's claim on an execution's lease. */
export interface DriverLease {
  /**
   * Release this hold; the keeper's lease is released when the last hold goes. Awaited (a failed
   * release is not an error: the lease just expires). Idempotent, and a no-op once the lease was lost.
   */
  release(): Promise<void>;
  /**
   * Release this hold like {@link release}, but when it is the LAST one the keeper stops renewing and
   * drops the lease WITHOUT deleting the store row: it expires on its own after the TTL and is then
   * expired-lease evidence for a retry. For an attempt that failed after it claimed (a released row
   * would be absent, which proves nothing). If other holds remain, the intent is kept and applies
   * when the last of them goes. Synchronous (no store call); idempotent; a no-op once the lease was lost.
   */
  forget(): void;
  /**
   * Called ONCE, synchronously, if the lease is lost while this hold is live (taken over, past the
   * local self-fencing deadline, or the keeper closed). May run inside `validNow`.
   */
  onLost(listener: (err: LeaseLostError) => void): void;
  /** True while the lease is held AND inside both local deadlines (a clock compare, no I/O). */
  valid(): boolean;
  /**
   * The error to fail with when {@link valid} is false: the real loss this hold was told (taken over,
   * deadline, keeper closed), else a deadline loss naming the keeper's real owner.
   */
  lossError(): LeaseLostError;
}

/** The hold of an unwired runtime: always valid, never lost, nothing to release. */
export const NO_LEASE: DriverLease = Object.freeze({
  release: () => Promise.resolve(),
  forget: () => {},
  onLost: () => {},
  valid: () => true,
  lossError: () => new LeaseLostError("", "", "closed"),
});

interface Hold {
  id: string;
  dead: boolean;
  released: boolean;
  listener: ((err: LeaseLostError) => void) | undefined;
  /** The loss this hold was told, kept for a listener that attaches afterwards. */
  lostErr: LeaseLostError | undefined;
}

export class DriverLeases {
  readonly keeper: LeaseKeeper;
  /** `"lazy"` (default) or `"eager"`: when a RUN takes its lease (see {@link HeartbeatOptions.acquire}). */
  readonly mode: "eager" | "lazy";
  /** Lazy mode: the unleased grace period of a run, in ms. */
  readonly graceMs: number;
  /** Lazy holds still in their grace window or acquiring: cancelled on close. */
  private readonly lazyHolds = new Set<{ closeNow(): void }>();
  /** id -> live holds. Bounded by the live drivers: an entry leaves with its last hold. */
  private readonly holds = new Map<string, Set<Hold>>();
  /** id -> acquires awaiting the keeper: their hold is not registered yet, but they count. */
  private readonly pending = new Map<string, number>();
  /** ids whose last registered hold was released while an acquire was pending: release afterwards. */
  private readonly deferredRelease = new Set<string>();
  /** ids whose lease is to be FORGOTTEN (row left to expire) rather than released when the last hold goes. */
  private readonly forgetOnLast = new Set<string>();

  constructor(deps: HeartbeatOptions) {
    const { leaseStore, onStoreError, nodeId, acquire, lazyGraceMs, ...options } = deps;
    if ((acquire as unknown) !== undefined && acquire !== "eager" && acquire !== "lazy")
      throw new TypeError(
        `heartbeat.acquire: "${String(acquire)}" is not valid; expected "eager" or "lazy"`
      );
    if (
      lazyGraceMs !== undefined &&
      (typeof lazyGraceMs !== "number" || !Number.isFinite(lazyGraceMs) || lazyGraceMs < 0)
    )
      throw new TypeError("heartbeat.lazyGraceMs must be a finite number >= 0");
    this.mode = acquire ?? "lazy";
    if (
      (onStoreError as unknown) !== undefined &&
      onStoreError !== "stop" &&
      onStoreError !== "continue"
    )
      throw new TypeError(
        `heartbeat.onStoreError: "${String(onStoreError)}" is not valid; expected "stop" or "continue"`
      );
    this.keeper = new LeaseKeeper({
      ...options,
      ...(onStoreError !== undefined && { onStoreError }),
      store: leaseStore,
      nodeId: nodeId ?? PROCESS_NODE_ID,
      onLost: (id, err) => this.lost(id, err),
    });
    this.graceMs = lazyGraceMs ?? this.keeper.renewEveryMs;
  }

  private lost(id: string, err: LeaseLostError): void {
    this.deferredRelease.delete(id); // the keeper no longer holds it: nothing to release afterwards
    this.forgetOnLast.delete(id);
    const set = this.holds.get(id);
    if (set === undefined) return;
    this.holds.delete(id);
    for (const h of set) {
      h.dead = true;
      h.lostErr = err;
      const l = h.listener;
      h.listener = undefined;
      try {
        l?.(err);
      } catch {
        // a listener fault must not stop the others from being told
      }
    }
  }

  /**
   * Take a hold on `executionId`'s lease. `null` = another live owner holds an unexpired lease: the
   * caller stands down and takes no fence. Rejects with the store's own error (or
   * `LeaseStoreQuietError`) when the lease cannot be confirmed: the caller drives nothing.
   */
  async acquire(executionId: string): Promise<DriverLease | null> {
    return (await this.acquireDetailed(executionId)).lease;
  }

  private async acquireDetailed(
    executionId: string,
    opts?: { ignoreQuiet?: boolean }
  ): Promise<{ lease: DriverLease | null; why: AcquireOutcome }> {
    // Counted BEFORE the await: a concurrent last-release must not drop the lease this acquire is
    // about to rely on (the keeper answers `true` for a lease it already holds, one tick later).
    this.pending.set(executionId, (this.pending.get(executionId) ?? 0) + 1);
    let outcome: AcquireOutcome;
    try {
      outcome = await this.keeper.acquireOutcome(executionId, opts);
    } catch (err) {
      this.settlePending(executionId);
      // "continue": a lease store that cannot be reached must not stop a NEW driver either. It drives
      // UNLEASED (absent lease = no evidence, which is exactly what a heuristic fleet needs). Only a
      // store failure qualifies: a bad id or a closed keeper still rejects.
      if (this.keeper.heuristic && !(err instanceof TypeError) && !this.keeper.isClosed)
        return { lease: NO_LEASE, why: "held" };
      throw err;
    }
    const ok = outcome === "held";
    const hold: Hold = {
      id: executionId,
      dead: false,
      released: false,
      listener: undefined,
      lostErr: undefined,
    };
    if (ok) {
      let set = this.holds.get(executionId);
      if (set === undefined) {
        set = new Set();
        this.holds.set(executionId, set);
      }
      set.add(hold);
      // A deferred release is stale once a new hold owns the lease: that hold's release decides.
      this.deferredRelease.delete(executionId);
      // Lost in the very tick it was granted (a stall past its deadline): the hold is born dead and
      // tells its first listener immediately.
      if (!this.keeper.validNow(executionId) && !hold.dead) {
        set.delete(hold);
        if (set.size === 0) this.holds.delete(executionId);
        hold.dead = true;
        hold.lostErr = new LeaseLostError(executionId, this.keeper.owner, "deadline");
      }
    }
    this.settlePending(executionId);
    if (!ok) return { lease: null, why: outcome };
    return {
      why: "held",
      lease: {
        release: () => this.release(hold),
        forget: () => {
          if (hold.released || hold.dead) return;
          this.forgetOnLast.add(hold.id);
          void this.release(hold);
        },
        onLost: (listener) => {
          if (hold.dead) {
            // Lost before the driver attached: deliver it NOW (never a silent no-op).
            if (hold.lostErr !== undefined && !hold.released) {
              hold.released = true;
              listener(hold.lostErr);
            }
            return;
          }
          hold.listener = listener;
        },
        valid: () => !hold.dead && this.keeper.validNow(executionId),
        lossError: () =>
          hold.lostErr ?? new LeaseLostError(executionId, this.keeper.owner, "deadline"),
      },
    };
  }

  /**
   * The hold a FRESH START takes (ADR 0130 D11 option 2, S7g; user ruling 2026-10-15: lazy applies only
   * to a fresh start). The caller has established from DURABLE state (the id was minted here, or its
   * stream does not exist yet) that no predecessor can have left a lease row; any other entry MUST use
   * {@link acquire}. Eager mode = {@link acquire}. Lazy mode: a hold that costs NOTHING until the run
   * has gone {@link graceMs} unleased, then acquires; released before that it never touches the store.
   * Same shape as an eager hold, with these differences:
   *
   *  - It never stands down at the start (`null` only comes from the eager path): the fence and the
   *    store's sequence-0 uniqueness already guard the log.
   *  - When the delayed acquire finds the store-confirmed unexpired row of another owner the run is a
   *    duplicate of a driver that is live elsewhere (or a ghost row of a failed start: the documented
   *    residual): it is told the lease is LOST ("taken-over") and appends nothing more.
   *  - When the delayed acquire's outcome is UNKNOWN (a store error or timeout: the row may exist) the
   *    run is treated as possibly held: under "stop" it self-fences at the send time + ttl - margin
   *    ("deadline") unless a re-acquire, which bypasses the keeper's quiet period, confirms first. When
   *    the acquire provably sent nothing (the quiet period, a bad id) the run is simply unleased, which
   *    is no evidence: it retries after another grace period.
   *  - A late answer (after the grant's own deadline), a cancelled one and a closed keeper each have
   *    their own reason; only a confirmed foreign owner is "taken-over".
   *  - When a claimant (poll, sweep, timer fire) already holds the id's lease, the run hooks onto it
   *    now (no store call: the keeper already holds it), so it is told if the claimant's lease is lost.
   */
  async acquireFresh(executionId: string): Promise<DriverLease | null> {
    if (this.mode === "eager") return this.acquire(executionId);
    if (this.holds.has(executionId) || (this.pending.get(executionId) ?? 0) > 0)
      return this.acquire(executionId);
    return this.lazyHold(executionId);
  }

  private lazyHold(executionId: string): DriverLease {
    type Phase = "grace" | "acquiring" | "held" | "done" | "lost";
    let phase: Phase = "grace";
    let inner: DriverLease | undefined;
    let flight: Promise<void> | undefined;
    let lostErr: LeaseLostError | undefined;
    let listener: ((err: LeaseLostError) => void) | undefined;
    let forgetWhenHeld = false;
    let cancelTimer: () => void = () => {};
    let cancelFence: () => void = () => {};
    /**
     * A delayed acquire of UNKNOWN outcome may have written our row. Until a re-acquire confirms, the
     * run is bounded by the row's latest possible expiry minus the margin (the FIRST unknown send: a
     * later unknown attempt cannot extend it, the earlier row may be the one that exists).
     */
    let maybeRow: { mono: number; wall: number } | undefined;
    const entry = {
      closeNow: () => {
        cancelTimer();
        fail(new LeaseLostError(executionId, this.keeper.owner, "closed"));
      },
    };
    const fail = (err: LeaseLostError): void => {
      if (phase === "done" || phase === "lost") return;
      phase = "lost";
      lostErr = err;
      cancelTimer();
      cancelFence();
      this.lazyHolds.delete(entry);
      const l = listener;
      listener = undefined;
      try {
        l?.(err);
      } catch {
        // a listener fault must not stop the run from unwinding
      }
    };
    const checkFence = (): void => {
      if (maybeRow === undefined || (phase !== "grace" && phase !== "acquiring")) return;
      if (this.keeper.monotonicNow() >= maybeRow.mono || this.keeper.wallClock() >= maybeRow.wall)
        fail(new LeaseLostError(executionId, this.keeper.owner, "deadline"));
    };
    const markMaybeRow = (sent: { mono: number; wall: number }): void => {
      if (maybeRow !== undefined) return;
      const window = this.keeper.ttlMs - this.keeper.marginMs;
      maybeRow = { mono: sent.mono + window, wall: sent.wall + window };
      const ms = Math.max(
        0,
        Math.min(
          maybeRow.mono - this.keeper.monotonicNow(),
          maybeRow.wall - this.keeper.wallClock()
        )
      );
      cancelFence = this.keeper.schedule(checkFence, ms);
    };
    /** Nothing was put on the wire for this rejection, so no row can exist because of it. */
    const sentNothing = (err: unknown): boolean =>
      err instanceof LeaseStoreQuietError ||
      (err instanceof LeaseStoreTimeoutError && err.operation === "release");
    const arm = (): void => {
      // While a row may exist the confirming retry must land before the deadline: never later than a renew.
      const ms =
        maybeRow === undefined ? this.graceMs : Math.min(this.graceMs, this.keeper.renewEveryMs);
      cancelTimer = this.keeper.schedule(() => {
        if (phase !== "grace") return;
        flight = acquireNow();
      }, ms);
    };
    /** Give a possibly-written row back (best effort) unless some other hold relies on the keeper's lease. */
    const dropMaybeRow = async (): Promise<void> => {
      if (maybeRow === undefined || forgetWhenHeld) return;
      if (this.holds.has(executionId) || (this.pending.get(executionId) ?? 0) > 0) return;
      await this.keeper.release(executionId).catch(() => {});
    };
    const acquireNow = async (): Promise<void> => {
      phase = "acquiring";
      // Taken BEFORE the call: the row (if one is written) cannot outlive send time + ttl.
      const sent = { mono: this.keeper.monotonicNow(), wall: this.keeper.wallClock() };
      let res: { lease: DriverLease | null; why: AcquireOutcome };
      try {
        res = await this.acquireDetailed(
          executionId,
          maybeRow !== undefined ? { ignoreQuiet: true } : undefined
        );
      } catch (err) {
        // `acquireDetailed` already maps a "continue" store outage to an unleased NO_LEASE; what reaches
        // here is the store failing (or its quiet period) under "stop", a bad id, or a closed keeper.
        if (this.keeper.isClosed) {
          fail(new LeaseLostError(executionId, this.keeper.owner, "closed"));
          return;
        }
        if (err instanceof TypeError) {
          // a bad id never leases: stay unleased and never retry
          if ((phase as Phase) === "acquiring") phase = "grace";
          return;
        }
        if (!sentNothing(err)) markMaybeRow(sent);
        if ((phase as Phase) === "acquiring") {
          phase = "grace";
          arm();
          checkFence();
        } else if ((phase as Phase) === "done") await dropMaybeRow();
        return;
      }
      const { lease: got, why } = res;
      if ((phase as Phase) === "done" || (phase as Phase) === "lost") {
        // Released (or closed / self-fenced) while the acquire was on the wire: hand the lease straight
        // back (or let it lapse).
        if (got !== null) {
          if (forgetWhenHeld) got.forget();
          else await got.release().catch(() => {});
        }
        return;
      }
      if (got === null) {
        if (why === "foreign") {
          fail(new LeaseLostError(executionId, this.keeper.owner, "taken-over"));
        } else if (why === "closed") {
          fail(new LeaseLostError(executionId, this.keeper.owner, "closed"));
        } else {
          // "late": answered after the grant's own deadline, so the keeper handed the row back, but we
          // cannot see that it succeeded: possibly held, and already past its deadline -> self-fence.
          // "cancelled": a release overtook it; nothing is held, retry after another grace.
          if (why === "late") markMaybeRow(sent);
          phase = "grace";
          arm();
          checkFence();
        }
        return;
      }
      cancelFence();
      maybeRow = undefined;
      inner = got;
      phase = "held";
      this.lazyHolds.delete(entry);
      got.onLost((err) => {
        phase = "lost";
        lostErr = err;
        const l = listener;
        listener = undefined;
        l?.(err);
      });
    };
    arm();
    this.lazyHolds.add(entry);
    return {
      release: async () => {
        if (phase === "grace") {
          cancelTimer();
          cancelFence();
          phase = "done";
          this.lazyHolds.delete(entry);
          await dropMaybeRow();
          return;
        }
        if (phase === "acquiring") {
          phase = "done";
          cancelTimer();
          cancelFence();
          this.lazyHolds.delete(entry);
          await flight; // the in-flight acquire hands the lease back itself
          return;
        }
        if (phase === "held") {
          phase = "done";
          await inner?.release();
          return;
        }
        if (phase !== "lost") phase = "done";
      },
      forget: () => {
        if (phase === "grace") {
          cancelTimer();
          cancelFence();
          phase = "done";
          this.lazyHolds.delete(entry);
        } else if (phase === "acquiring") {
          forgetWhenHeld = true;
          phase = "done";
          cancelTimer();
          cancelFence();
          this.lazyHolds.delete(entry);
        } else if (phase === "held") {
          phase = "done";
          inner?.forget();
        }
      },
      onLost: (l) => {
        if (lostErr !== undefined) {
          l(lostErr);
          return;
        }
        listener = l;
      },
      valid: () => {
        checkFence();
        if ((phase as Phase) === "lost") return false;
        if (phase === "held") return inner?.valid() ?? false;
        return true;
      },
      lossError: () =>
        lostErr ??
        inner?.lossError() ??
        new LeaseLostError(executionId, this.keeper.owner, "deadline"),
    };
  }

  /** An acquire finished: if its release was deferred and no hold remains, release now. */
  private settlePending(id: string): void {
    const n = (this.pending.get(id) ?? 1) - 1;
    if (n > 0) {
      this.pending.set(id, n);
      return;
    }
    this.pending.delete(id);
    if (this.deferredRelease.delete(id) && !this.holds.has(id)) void this.finish(id);
  }

  private release(hold: Hold): Promise<void> {
    if (hold.released) return Promise.resolve();
    hold.released = true;
    hold.listener = undefined;
    if (hold.dead) return Promise.resolve();
    const set = this.holds.get(hold.id);
    if (set === undefined) return Promise.resolve();
    set.delete(hold);
    if (set.size > 0) return Promise.resolve();
    this.holds.delete(hold.id);
    if ((this.pending.get(hold.id) ?? 0) > 0) {
      // An acquire is mid-flight on this id: it counts on the lease. Whoever finishes last releases.
      this.deferredRelease.add(hold.id);
      return Promise.resolve();
    }
    this.deferredRelease.delete(hold.id); // sending the release now: no stale flag may linger
    return this.finish(hold.id);
  }

  /** The last hold (and every pending acquire) is gone: give the lease up, or just stop keeping it. */
  private finish(id: string): Promise<void> {
    if (this.forgetOnLast.delete(id)) {
      this.keeper.forget(id);
      return Promise.resolve();
    }
    return this.keeper.release(id);
  }

  close(): Promise<void> {
    // Every lazy hold still in its grace or acquiring is told `closed`, like an eager hold the keeper
    // loses on close (a held lazy hold is told by the keeper itself).
    for (const h of [...this.lazyHolds]) h.closeNow();
    this.lazyHolds.clear();
    return this.keeper.close();
  }
}
