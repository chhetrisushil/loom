import { loomTest } from "../../vitest.shared";

// Every worker-pool test pays for real threads: a spawn plus a WASM compile per worker, per
// test, before the first assertion. Unloaded that is ~100 ms; under a full `turbo test`
// (~129 vitest processes sharing every core) it measured 1–4 s per test, and the heaviest
// case (10 MB thrown values, two pools) 5.7 s — past vitest's 5 s default, which then
// reported "timed out" for tests that assert WHAT happened and never how fast (L13). The
// timeout here is a hang detector, so it is sized for a saturated host; the one place this
// suite measures time (`workerPool.test.ts`) calibrates against the same run's own load.
export default loomTest({ test: { testTimeout: 30_000 } });
