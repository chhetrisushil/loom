import { randomUUID } from "node:crypto";
import type { LeaseStore } from "@loom/event-runtime";
import { LeaseKeeper, type LeaseKeeperOptions, LeaseLostError } from "./leaseKeeper";

// ── The runtime's drivers hold heartbeat leases (ADR 0130 D11, S7c) ─────────────────────────────
//
// ONE `LeaseKeeper` per runtime (one renew timer, group-committed acquire/release), and this thin
// layer above it that gives every DRIVER of an execution a reference-counted hold:
//
//  - the runtime's own run (`start`, `resume`, the `send`/notify winner, a successor, ...) takes a
//    hold before its first append and releases it at the suspend/terminal commit;
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
   * lease is true evidence. `"continue"` (ADR 0130 D11 section 6, S7d): drivers keep running through a
   * lease-store outage (no self-fence abort at the deadline; a driver that cannot even acquire a lease
   * during the outage runs unleased); the fence still guards the log, but the lease no longer proves
   * liveness, so this node's leases carry a heuristic owner marker and its poll's default re-drive is
   * off (re-drive only with `isAbandoned`, as before S7).
   */
  onStoreError?: "stop" | "continue";
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
  /** id -> live holds. Bounded by the live drivers: an entry leaves with its last hold. */
  private readonly holds = new Map<string, Set<Hold>>();
  /** id -> acquires awaiting the keeper: their hold is not registered yet, but they count. */
  private readonly pending = new Map<string, number>();
  /** ids whose last registered hold was released while an acquire was pending: release afterwards. */
  private readonly deferredRelease = new Set<string>();

  constructor(deps: HeartbeatOptions) {
    const { leaseStore, onStoreError, nodeId, ...options } = deps;
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
  }

  private lost(id: string, err: LeaseLostError): void {
    this.deferredRelease.delete(id); // the keeper no longer holds it: nothing to release afterwards
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
    // Counted BEFORE the await: a concurrent last-release must not drop the lease this acquire is
    // about to rely on (the keeper answers `true` for a lease it already holds, one tick later).
    this.pending.set(executionId, (this.pending.get(executionId) ?? 0) + 1);
    let ok: boolean;
    try {
      ok = await this.keeper.acquire(executionId);
    } catch (err) {
      this.settlePending(executionId);
      // "continue": a lease store that cannot be reached must not stop a NEW driver either. It drives
      // UNLEASED (absent lease = no evidence, which is exactly what a heuristic fleet needs). Only a
      // store failure qualifies: a bad id or a closed keeper still rejects.
      if (this.keeper.heuristic && !(err instanceof TypeError) && !this.keeper.isClosed)
        return NO_LEASE;
      throw err;
    }
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
    if (!ok) return null;
    return {
      release: () => this.release(hold),
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
    if (this.deferredRelease.delete(id) && !this.holds.has(id)) void this.keeper.release(id);
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
    return this.keeper.release(hold.id);
  }

  close(): Promise<void> {
    return this.keeper.close();
  }
}
