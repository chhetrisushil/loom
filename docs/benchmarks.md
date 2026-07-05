# Loom Benchmarks — Committed Baselines

Run all benches: `pnpm bench`. Per package: `pnpm --filter @loom/<pkg> bench`.

These baselines are the **no-regression gate** for the cooperative-scheduling work
(see `packages/scheduler` and the plan). The render fast-path (`traverseBlueprint`)
is deliberately left untouched; treat a >~2% regression on it as a failure.

Numbers below are indicative (Apple Silicon, Node 20, vitest bench). Re-capture on
your CI host to set the authoritative baseline; compare relative movement, not
absolute hz, across machines.

## traverseBlueprint — render fast path (regression gate)

Pure synchronous walk, no scheduler involvement. Scales ~linearly with node count.

| Nodes  | mean (ms) | hz        |
|--------|-----------|-----------|
| 10     | 0.0005    | ~1,970,000 |
| 100    | 0.0048    | ~207,000  |
| 1,000  | 0.0451    | ~22,000   |
| 10,000 | 0.4668    | ~2,140    |

Takeaway: even a 10k-node tree traverses in ~0.47ms — well inside a frame budget.
This is the empirical basis for **not** adding a Fiber-style time-slicer to the
render path.

## @loom/scheduler — overhead guardrails

| Bench                              | Result vs baseline |
|------------------------------------|--------------------|
| `schedule` (Infinity) vs direct await | ~1.0–1.04× (negligible) |
| `parallelLimit` unbounded vs `Promise.all` | ~1.7× (sub-µs absolute; dwarfed by real I/O) |

Takeaway: the unbounded scheduler adds no meaningful latency; gating cost is only
paid when a finite concurrency cap is explicitly configured.

## projection storm — pre-coalescing baseline (Phase 4 target)

One `handleEvent` per streamed token; subscriber fires once per event today.

| Burst  | mean (ms) | subscriber calls |
|--------|-----------|------------------|
| 100    | 0.0131    | 100              |
| 1,000  | 0.1214    | 1,000            |

Phase 4 coalescing target: keep wall time flat or better while collapsing
subscriber calls from O(events) → O(microtask flushes).
