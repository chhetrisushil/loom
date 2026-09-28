import { loomTest } from "../../vitest.shared";

// The integration suites here stand up a real HTTP worker over two SQLite files per test and
// drive a flow through it. Unloaded that is tens of milliseconds; under a saturated full
// `turbo test` one test measured past vitest's 5 s default, which then reported "timed out" for
// tests that assert WHAT the seam did and never how fast (L18). The timeout is a hang detector,
// so it is sized for a saturated host — the ruling plugin-sandbox (L13) and @loom/isolate (L18)
// share. No test in this package asserts a duration.
export default loomTest({ test: { testTimeout: 30_000 } });
