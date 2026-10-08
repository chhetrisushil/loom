import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { ReplayVM } from "./ReplayVM";
import { foldEvents } from "./foldEvents";

// PERF SUITE (`*.perf.test.ts`): excluded from `pnpm test` and run by `pnpm test:perf` — a
// non-blocking CI step and the nightly flake hunt. Timing RATIOS on a shared runner are noise-bound
// (one GC pause multiplies a single-digit-ms sample), so they never gate a merge. The blocking
// regression guard for the same property is the absolute ceiling in foldScale.test.ts.

const ID = { executionId: "x", workflowId: "wf", workflowVersion: "1.0.0" };

function ev(sequence: number, eventType: string, payload: unknown): EventEnvelope {
  return {
    id: `x-${sequence}`,
    workflowId: "wf",
    executionId: "x",
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
  };
}

// ── scale ────────────────────────────────────────────────────────────────────

// The ratio checks below compare single-digit-millisecond timings, so on a shared CI runner (turbo runs
// other packages' suites concurrently) one GC pause or descheduling can multiply a sample. The guard is
// against QUADRATIC behaviour, which costs seconds at 20k events (it was ~42 s), so the baseline is
// floored at RATIO_FLOOR_MS: below that, timer and scheduler noise dominate and the ratio means nothing,
// while a quadratic regression still blows far past `RATIO_FLOOR_MS * 10`. Absolute bounds stay as well.
const RATIO_FLOOR_MS = 25;
const best = (runs: number, fn: () => void): number => {
  fn(); // warm-up: JIT and allocation shape, never measured
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    min = Math.min(min, performance.now() - t);
  }
  return min;
};

function decisionEvents(n: number): EventEnvelope[] {
  const evs = [ev(0, "EXECUTION_STARTED", { input: {} })];
  for (let i = 1; i <= n; i++)
    evs.push(ev(i, "DECISION_RECORDED", { decisionId: `d${i}`, choice: i }));
  return evs;
}
function stepEvents(n: number): EventEnvelope[] {
  const evs = [ev(0, "EXECUTION_STARTED", { input: {} })];
  for (let i = 1; i <= n; i++) evs.push(ev(i, "STEP_COMPLETED", { stepId: `s${i}`, output: i }));
  return evs;
}

describe(
  "fold scales linearly (R1a perf regression; generous bounds)",
  { timeout: 180_000 },
  () => {
    // Before the fix: 5k/10k/20k decisions folded in 2.3s/10s/42s. After: single-digit ms.
    it("folds 20k decisions in a bounded time and within a small factor of 20k steps", () => {
      const d = decisionEvents(20_000);
      const s = stepEvents(20_000);
      const tDecisions = best(2, () => foldEvents(d, ID));
      const tSteps = best(2, () => foldEvents(s, ID));
      expect(tDecisions).toBeLessThan(3000); // was ~42 000 ms
      // the plan's acceptance bound is 5x; a floor keeps a 5 ms baseline from flaking
      expect(tDecisions).toBeLessThan(Math.max(tSteps * 5, 150));
    });

    it("decision fold is O(n): 4x the events costs far less than 16x", () => {
      const small = decisionEvents(5_000);
      const large = decisionEvents(20_000);
      const t5 = Math.max(
        best(5, () => foldEvents(small, ID)),
        RATIO_FLOOR_MS
      );
      const t20 = best(5, () => foldEvents(large, ID));
      expect(t20 / t5).toBeLessThan(10); // O(n^2) gives 16x; O(n) gives ~4x
    });

    it("live commits are linear: 20k applyEvent costs well under 16x of 5k", () => {
      const run = (n: number): number =>
        best(2, () => {
          const vm = new ReplayVM([], ID);
          for (const e of stepEvents(n)) vm.applyEvent(e);
        });
      const t5 = Math.max(run(5_000), RATIO_FLOOR_MS);
      const t20 = run(20_000);
      expect(t20).toBeLessThan(5_000); // was ~42 000 ms for 20k
      expect(t20 / t5).toBeLessThan(10);
    });

    it("live decisions are linear too", () => {
      const run = (n: number): number =>
        best(2, () => {
          const vm = new ReplayVM([], ID);
          for (const e of decisionEvents(n)) vm.applyEvent(e);
        });
      const t5 = Math.max(run(5_000), RATIO_FLOOR_MS);
      const t20 = run(20_000);
      expect(t20).toBeLessThan(5_000);
      expect(t20 / t5).toBeLessThan(10);
    });

    it("an escape every k events costs one copy per escape, not per event", () => {
      const evs = stepEvents(20_000);
      const t = best(1, () => {
        const vm = new ReplayVM([], ID);
        evs.forEach((e, i) => {
          vm.applyEvent(e);
          if (i % 1000 === 0) vm.getState(); // e.g. the snapshot cadence
        });
      });
      expect(t).toBeLessThan(5_000);
    });
  }
);
