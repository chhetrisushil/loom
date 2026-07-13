import { type LoomApp, type LoomConfig, defineConfig } from "@loom/app";

export type TestAppConfig = Omit<LoomConfig, "storage"> & Partial<Pick<LoomConfig, "storage">>;

/**
 * Spin up a Loom app for tests — `defineConfig` defaulted to in-memory storage.
 * Returns the full {@link LoomApp} (runtime, effectRuntime, projectionRuntime,
 * bus, stores, close), so tests wire the same objects production uses; the test
 * still constructs its own app-specific conductor/orchestrator on top.
 *
 * Override `storage` (e.g. sqlite) when a test needs durability across restarts.
 */
export function createTestApp(config: TestAppConfig = {}): LoomApp {
  return defineConfig({ storage: { kind: "memory" }, ...config });
}
