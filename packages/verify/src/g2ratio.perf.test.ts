import { describe, expect, it } from "vitest";
import type { VerifyInput } from "./types";
import { runVerification } from "./verify";

// Fitness gate (relative-ratio, machine-stable): the G2 "zero overhead when disabled" invariant
// as a RATIO, not an absolute hz — both sides scale with machine speed, so the ratio holds under
// CI load. The absolute baselines in docs/benchmarks.md stay advisory. This complements the
// deterministic behavioral G2 tests (mode=off never calls buildInput) in verify.test.ts.

function buildBig(): VerifyInput {
  const flows = Array.from({ length: 200 }, (_, i) => ({ id: `f${i}`, flowHash: `fnv1a:${i}` }));
  return { flows, eventSchemaVersion: "1.11.0" };
}

function timeMs(fn: () => void, iters: number): number {
  for (let i = 0; i < 200; i++) fn(); // warm up
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return performance.now() - t0;
}

describe("verify — G2 zero-overhead ratio (fitness gate)", () => {
  it("mode=off is dramatically cheaper than mode=warn (input never built)", () => {
    const N = 3000;
    const off = timeMs(() => runVerification("off", buildBig, undefined, () => {}), N);
    const warn = timeMs(() => runVerification("warn", buildBig, undefined, () => {}), N);
    // Real ratio is ~1000×+; assert a very generous ≥5× so it never flakes across machines/CI.
    expect(off).toBeLessThan(warn / 5);
  });
});
