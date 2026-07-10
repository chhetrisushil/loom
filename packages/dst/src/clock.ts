// ── Virtual clock (discrete-event time) ──────────────────────────────────────
//
// Loom already makes time injectable: `TimerStore.due(now)` takes `now` as a
// parameter and `EXECUTION_SUSPENDED.condition.wakeAt` is the ONLY wall clock that
// enters the log (P9). So a simulation controls time simply by owning the `now` it
// feeds the timer poll — no core change. Wall-clock never leaks into a fold, so a
// virtual run replays identically to a real one.
//
// This is a discrete-event clock: it holds the current virtual time plus a set of
// registered future wake times, and `nextWake()` lets a driver jump straight to the
// next scheduled event instead of busy-waiting real milliseconds.

export interface VirtualClock {
  /** Current virtual time (epoch ms). */
  now(): number;
  /** Jump forward to an absolute time. No-op if t <= now (time never runs backward). */
  advanceTo(t: number): void;
  /** Jump forward by a duration (ms). Negative deltas are ignored. */
  advanceBy(ms: number): void;
  /** Register a future wake time so `nextWake` can find it. Past times are ignored. */
  registerWake(t: number): void;
  /** Drop a wake time once it has fired (or is obsolete). */
  clearWake(t: number): void;
  /** The soonest registered wake strictly after `now`, or undefined if none. */
  nextWake(): number | undefined;
}

/** Construct a {@link VirtualClock} starting at `startEpochMs` (default 0). */
export function virtualClock(startEpochMs = 0): VirtualClock {
  let current = startEpochMs;
  // Multiset of pending wake times (count per time, since two executions can share one).
  const wakes = new Map<number, number>();

  return {
    now(): number {
      return current;
    },
    advanceTo(t: number): void {
      if (t > current) current = t;
    },
    advanceBy(ms: number): void {
      if (ms > 0) current += ms;
    },
    registerWake(t: number): void {
      if (t <= current) return;
      wakes.set(t, (wakes.get(t) ?? 0) + 1);
    },
    clearWake(t: number): void {
      const n = wakes.get(t);
      if (n === undefined) return;
      if (n <= 1) wakes.delete(t);
      else wakes.set(t, n - 1);
    },
    nextWake(): number | undefined {
      let soonest: number | undefined;
      for (const t of wakes.keys()) {
        if (t > current && (soonest === undefined || t < soonest)) soonest = t;
      }
      return soonest;
    },
  };
}
