import { type LoomApp, type LoomConfig, defineConfig } from "@loom/app";
import { InMemoryTimerStore } from "@loom/event-runtime";
import { type TestClock, bindClock, createTestClock } from "./time";

export type TestAppConfig = Omit<LoomConfig, "storage"> &
  Partial<Pick<LoomConfig, "storage">> & {
    /**
     * Time travel. `true` creates a {@link TestClock}; a number is its start (epoch ms); pass your
     * own clock to share it. The app gets `execution.now: clock.now`, an in-memory `TimerStore` and a
     * `TimerService` that does NOT poll on its own (`autostart: false`) - drive it with
     * `advanceTime(app, ms)` / `fireDueTimers(app)`. Your own `timers` or `autostart` win over these defaults;
     * your own `execution.now` wins too but must agree with the clock (it throws otherwise).
     */
    clock?: boolean | number | TestClock;
  };

/**
 * Spin up a Loom app for tests — `defineConfig` defaulted to in-memory storage.
 * Returns the full {@link LoomApp} (runtime, effectRuntime, projectionRuntime,
 * bus, stores, close), so tests wire the same objects production uses; the test
 * still constructs its own app-specific conductor/orchestrator on top.
 *
 * Override `storage` (e.g. sqlite) when a test needs durability across restarts.
 */
export function createTestApp(config: TestAppConfig = {}): LoomApp {
  const { clock: clockOption, ...rest } = config;
  if (clockOption === undefined || clockOption === false) {
    return defineConfig({ storage: { kind: "memory" }, ...rest });
  }
  const clock: TestClock =
    typeof clockOption === "object"
      ? clockOption
      : createTestClock(typeof clockOption === "number" ? clockOption : undefined);
  const ownNow = rest.execution?.now;
  if (ownNow !== undefined && ownNow() !== clock.now()) {
    throw new Error(
      "createTestApp: execution.now disagrees with the test clock - advanceTime moves the clock, not your now(), so timers would fire at the wrong instant. Drop execution.now (the clock supplies it) or pass a clock built on the same source"
    );
  }
  const app = defineConfig({
    storage: { kind: "memory" },
    timers: { store: new InMemoryTimerStore() },
    autostart: false,
    ...rest,
    execution: { now: () => clock.now(), ...rest.execution },
  });
  bindClock(app, clock);
  return app;
}
