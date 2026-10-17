import type { LoomApp } from "@loom/app";

/**
 * A minimal controllable clock for tests (epoch ms). It matches the `now()` / `advanceBy()`
 * shape of `@loom/dst`'s `virtualClock`, kept here so `@loom/testing` does not depend on the
 * simulation kit.
 */
export interface TestClock {
  /** Current virtual time (epoch ms) - handed to the runtime as `now`. */
  now(): number;
  /** Move time forward by `ms`. Zero or negative deltas are ignored (time never runs backward). */
  advanceBy(ms: number): void;
  /** Move time forward to an absolute instant. No-op if it is not in the future. */
  advanceTo(epochMs: number): void;
}

/** Create a {@link TestClock}. Defaults to a fixed, readable start (2030-01-01T00:00:00Z). */
export function createTestClock(startEpochMs = Date.UTC(2030, 0, 1)): TestClock {
  let current = startEpochMs;
  return {
    now: () => current,
    advanceBy(ms) {
      if (ms > 0) current += ms;
    },
    advanceTo(t) {
      if (t > current) current = t;
    },
  };
}

const clocks = new WeakMap<LoomApp, TestClock>();

/** @internal Remember which clock drives an app (set by `createTestApp({ clock })`). */
export function bindClock(app: LoomApp, clock: TestClock): void {
  clocks.set(app, clock);
}

/** The {@link TestClock} an app was created with, or `undefined` when it runs on wall time. */
export function clockOf(app: LoomApp): TestClock | undefined {
  return clocks.get(app);
}

function requireClock(app: LoomApp, fn: string): TestClock {
  const clock = clocks.get(app);
  if (clock === undefined) {
    throw new Error(
      `${fn}: this app has no test clock - create it with createTestApp({ clock: true })`
    );
  }
  return clock;
}

/**
 * Fire every timer that is due at the app's test-clock time, through the app's REAL
 * `TimerService` (the code path production polls): `ctx.sleep` / `sleepUntil` wakes,
 * `suspend({ timeout })` expiries and cron occurrences. Resolves once the poll, including the
 * resumes it triggered, has finished.
 */
export async function fireDueTimers(app: LoomApp): Promise<void> {
  const clock = requireClock(app, "fireDueTimers");
  if (app.timerService === undefined) {
    throw new Error(
      "fireDueTimers: the app has no TimerService (a custom config removed `timers`)"
    );
  }
  await app.timerService.tick(clock.now());
}

/**
 * Advance the app's test clock by `ms`, then fire whatever became due ({@link fireDueTimers}).
 * Advancing by less than a timer's remaining time fires nothing.
 */
export async function advanceTime(app: LoomApp, ms: number): Promise<void> {
  requireClock(app, "advanceTime").advanceBy(ms);
  await fireDueTimers(app);
}
