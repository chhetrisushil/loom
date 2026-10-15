import { describe, expect, it } from "vitest";
import { measureLeaseOverhead } from "./leaseOverheadLib";

// PERF (excluded from `pnpm test`; run with `pnpm test:perf`): the ADR 0130 D11 / Q8 cost gate on the
// in-memory stores. Wall-clock ratios measure the machine's load as much as the code, so this is the
// non-blocking tier; tools/bench-throughput's `bench:lease` records the numbers in docs/benchmarks.md.
describe("heartbeat lease overhead (Q8 gate, lazy default)", () => {
  it("no-op ceiling: LAZY heartbeat costs <= 10% (in-memory)", async () => {
    const r = await measureLeaseOverhead({
      backend: "memory",
      shape: "noop",
      concurrency: 64,
      executions: 2000,
      ioMs: 0,
      repeats: 5,
    });
    expect(r.lazyOverheadPct, JSON.stringify(r)).toBeLessThanOrEqual(10);
  }, 120_000);

  it("I/O-bound (20 ms): LAZY heartbeat costs no more than noise (<= 5%)", async () => {
    const r = await measureLeaseOverhead({
      backend: "memory",
      shape: "io",
      concurrency: 64,
      executions: 1000,
      ioMs: 20,
      repeats: 5,
    });
    expect(r.lazyOverheadPct, JSON.stringify(r)).toBeLessThanOrEqual(5);
  }, 120_000);
});
