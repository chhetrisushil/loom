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
// NOTE: the SPI conformance kits (ADR 0033) now live in their own ESM package,
// `@loom/conformance`, so a plugin can `import` them in its own vitest suite (a CJS
// build that `require()`s vitest is forbidden). They are no longer part of @loom/testing.
