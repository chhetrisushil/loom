import { randomUUID } from "node:crypto";
import type { LeaseStore } from "@loom/event-runtime";
import { LeaseKeeper, type LeaseKeeperOptions, type LeaseLostError } from "./leaseKeeper";

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
   * `"stop"` (default): a driver that cannot confirm a renewal stops at its deadline. `"continue"` is
   * accepted but NOT yet honoured by the keeper (S7c ships "stop" only); it behaves as "stop".
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
}

/** The hold of an unwired runtime: always valid, never lost, nothing to release. */
export const NO_LEASE: DriverLease = Object.freeze({
  release: () => Promise.resolve(),
  onLost: () => {},
  valid: () => true,
});

interface Hold {
  id: string;
  dead: boolean;
  released: boolean;
  listener: ((err: LeaseLostError) => void) | undefined;
}

export class DriverLeases {
  readonly keeper: LeaseKeeper;
  /** id -> live holds. Bounded by the live drivers: an entry leaves with its last hold. */
  private readonly holds = new Map<string, Set<Hold>>();

  constructor(deps: HeartbeatOptions) {
    const { leaseStore, onStoreError: _onStoreError, nodeId, ...options } = deps;
    this.keeper = new LeaseKeeper({
      ...options,
      store: leaseStore,
      nodeId: nodeId ?? PROCESS_NODE_ID,
      onLost: (id, err) => this.lost(id, err),
    });
  }

  private lost(id: string, err: LeaseLostError): void {
    const set = this.holds.get(id);
    if (set === undefined) return;
    this.holds.delete(id);
    for (const h of set) {
      h.dead = true;
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
    const ok = await this.keeper.acquire(executionId);
    if (!ok) return null;
    const hold: Hold = { id: executionId, dead: false, released: false, listener: undefined };
    let set = this.holds.get(executionId);
    if (set === undefined) {
      set = new Set();
      this.holds.set(executionId, set);
    }
    set.add(hold);
    return {
      release: () => this.release(hold),
      onLost: (listener) => {
        if (hold.dead) return;
        hold.listener = listener;
      },
      valid: () => !hold.dead && this.keeper.validNow(executionId),
    };
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
    return this.keeper.release(hold.id);
  }

  close(): Promise<void> {
    return this.keeper.close();
  }
}
