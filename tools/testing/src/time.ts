import type { LoomApp } from "@loom/app";

/**
 * A minimal controllable clock for tests (epoch ms). It matches the `now()` / `advanceBy()`
 * shape of `@loom/dst`'s `virtualClock`, kept here so `@loom/testing` does not depend on the
 * simulation kit.
 */
export interface TestClock {
  /** Current virtual time (epoch ms) - handed to the runtime as `now`. */
  now(): number;
  /** Move time forward by `ms`. Throws on a negative, NaN or non-finite delta (time never runs backward). */
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
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
        throw new Error(`advanceBy: ms must be a finite number >= 0 (got ${String(ms)})`);
      }
      current += ms;
    },
    advanceTo(t) {
      if (typeof t !== "number" || Number.isNaN(t)) {
        throw new Error(`advanceTo: t must be a number (got ${String(t)})`);
      }
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

const MAX_DRAIN_TICKS = 1000;

/**
 * Fire every timer that is due at the app's test-clock time, through the app's REAL
 * `TimerService` (the code path production polls): `ctx.sleep` / `sleepUntil` wakes,
 * `suspend({ timeout })` expiries and cron occurrences. It DRAINS: it polls until nothing is due
 * any more (one poll fires at most a batch), so it resolves with the resumes finished and every
 * due timer fired. A timer that re-arms itself at an instant that is already due (a loop that
 * sleeps for zero) never drains and throws after {@link MAX_DRAIN_TICKS} polls.
 *
 * The app must not poll on its own (`createTestApp` defaults to `autostart: false`): a poll
 * already in flight makes `tick` return at once, which would leave timers unfired.
 */
export async function fireDueTimers(app: LoomApp): Promise<void> {
  const clock = requireClock(app, "fireDueTimers");
  const service = app.timerService;
  if (service === undefined) {
    throw new Error(
      "fireDueTimers: the app has no TimerService (a custom config removed `timers`)"
    );
  }
  if (service.running) {
    throw new Error(
      "fireDueTimers: the TimerService is polling on its own (autostart is on), so a poll may already be in flight and tick() would silently skip - create the app with createTestApp({ clock: true }) (autostart: false) or do not set `autostart: true`"
    );
  }
  const store = app.stores?.timerStore;
  for (let i = 0; i < MAX_DRAIN_TICKS; i++) {
    const now = clock.now();
    await service.tick(now);
    if (store === undefined) return; // cannot look: one poll is all we can promise
    // Same exclusions the service applies when it has no re-driver / inbox: rows it cannot judge.
    const left = await store.due(now, 1, { redrive: false, inbox: false, refused: false });
    if (left.length === 0) return;
  }
  throw new Error(
    `fireDueTimers: timers were still due after ${MAX_DRAIN_TICKS} polls - something keeps re-arming a timer at an instant that is already due (for example a loop that sleeps for 0 ms)`
  );
}

/**
 * Advance the app's test clock by `ms`, then fire whatever became due ({@link fireDueTimers}).
 * Advancing by less than a timer's remaining time fires nothing. `ms` must be a finite number
 * >= 0 (throws otherwise: a negative or NaN delta silently doing nothing hides a broken test).
 */
export async function advanceTime(app: LoomApp, ms: number): Promise<void> {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    throw new Error(`advanceTime: ms must be a finite number >= 0 (got ${String(ms)})`);
  }
  const clock = requireClock(app, "advanceTime");
  clock.advanceBy(ms);
  await fireDueTimers(app);
}
