export { createTestApp, type TestAppConfig } from "./createTestApp";
export {
  waitFor,
  waitForPhase,
  getSurfaceState,
  driveToSuspend,
  resumeWith,
  captureGolden,
  type WaitOptions,
} from "./wait";
export {
  recordingProvider,
  replayingProvider,
  hashRequest,
  emptyCassette,
  type LlmCassette,
} from "./vcr";
export {
  crashingEventStore,
  type CrashingEventStore,
  type CrashingEventStoreOptions,
} from "./crash";
// NOTE: the SPI conformance kits (ADR 0033) are exposed via the `@loom/testing/conformance`
// subpath, NOT this barrel. They `import "vitest"` at module scope; keeping them off the main
// entry means importing app helpers (createTestApp, waitFor, …) never drags vitest into a
// consumer's require graph (vitest forbids being require()'d from CommonJS).
