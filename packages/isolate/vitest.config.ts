import { loomTest } from "../../vitest.shared";

// Nearly every test here forks a real Node child (the K7 boundary IS a process) and waits for it
// to boot and load its runner before the first assertion. Unloaded that is ~50–100 ms; under a
// saturated full `turbo test` a single cold fork measured multiple seconds, past vitest's 5 s
// default, which then reported "timed out" for tests that assert WHAT the boundary did and never
// how fast (L18). The timeout is a hang detector, so it is sized for a saturated host — the same
// ruling as plugin-sandbox's worker pool (L13). No test in this package asserts a duration.
export default loomTest({ test: { testTimeout: 30_000 } });
