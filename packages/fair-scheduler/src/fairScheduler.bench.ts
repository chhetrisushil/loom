import { createScheduler } from "@loom/scheduler";
import { bench, describe } from "vitest";
import { createFairScheduler } from "./fairScheduler";

// The zero-overhead claim: with concurrency Infinity, the fair scheduler takes the
// same fast path as the base scheduler (no queue, no tenant bookkeeping). This bench
// backs the L4 maturity bar — perf measured, not assumed. Absolute hz are machine-
// relative; the point is that the Infinity path tracks the base scheduler closely.

const noop = () => Promise.resolve(1);

describe("scheduler dispatch overhead (Infinity fast path)", () => {
  bench("base createScheduler", async () => {
    const s = createScheduler();
    for (let i = 0; i < 200; i++) await s.schedule(noop);
  });

  bench("createFairScheduler", async () => {
    const s = createFairScheduler();
    for (let i = 0; i < 200; i++) await s.schedule(noop);
  });
});
