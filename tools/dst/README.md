# @loom/dst — Deterministic Simulation Testing

Drive the Loom kernel under **seeded, adversarial fault schedules**, assert its invariants hold, and
reproduce/minimize any failure bit-for-bit. Loom is event-sourced with deterministic replay (P2) and
logs all non-determinism (P9) — the ideal substrate for simulation testing.

> Test/dev-only. **No runtime package imports `@loom/dst`**, so its production overhead is zero by
> construction. See [ADR 0036](../../docs/adr/0036-deterministic-simulation-testing.md).

## What it gives you

- **`splitmix64(seed)`** — the single seeded entropy source (`next/int/pick/bool/fork`). Everything
  random in a run flows from the seed, so a failure replays from the seed alone.
- **`virtualClock()`** — discrete-event virtual time (time is already injectable: `TimerStore.due`
  takes `now`).
- **`faultInjectingStore` / `FaultModel`** — generalizes `@loom/testing`'s single-point
  `crashingEventStore` into per-append/-delivery draws over the `EventStore` SPI: `crash`,
  `appendReject`, `msgLoss`, `msgDup`. Two modes: **explore** (sample + record `FaultDraw[]`) and
  **replay** (apply a recorded schedule, no rng).
- **`simWorld({ seed, faults, registerFlows })`** — a simulated universe; `spawn()` returns a fresh
  `WorkflowRuntime` over the shared fault-injecting store (each spawn = a new worker process).
- **`INVARIANTS`** — `noDoubleNonIdempotentEffect`, `logPrefixConsistency`, `fenceMonotonic`,
  `exactlyOnceOutcome`, `resumeConvergence`.
- **`checkProperty` / `replaySchedule`** — search seeds for a violation, **shrink** the witness to a
  minimal reproducing `FaultDraw[]`, and replay it deterministically.

## Example

```ts
import { checkProperty } from "@loom/dst";

const report = await checkProperty(
  {
    name: "crash-recovery-converges",
    faults: { crashBeforeAppend: 0.15 },
    registerFlows: (runtime, effects) => {
      effects.register("pay-tool", new ToolEffect(chargeFn));
      runtime.registerFlow(flow.definition, runner);
    },
    scenario: async (world) => {
      const rt1 = world.spawn();
      const h1 = await rt1.start(flow, { amountUsd: 42 }, { executionId: "e1" });
      await h1.waitForCompletion();
      // …if the durable tail was crashed away, reboot + recover:
      const durable = await world.logOf("e1");
      if (durable.length > 0 && !durable.some((e) => e.eventType === "EXECUTION_COMPLETED")) {
        world.faults.restore();
        await (await world.spawn().resume("e1", { eventType: "EXECUTION_RECOVERED", payload: {} }))
          .waitForCompletion();
      }
      return "e1";
    },
  },
  { seeds: 30 }
);

if (!report.ok) {
  // report.seed + report.minimizedSchedule reproduce report.violation deterministically
}
```

## Scope (honest)

DST controls the durable store, transport delivery, and the poll clock — where Loom's
non-determinism actually lives. It does **not** intercept a runtime's internal `Date.now()`; the
built-in invariants are log-structural (they don't read timestamps), so PASS/FAIL reproduction is
deterministic regardless. Message **reordering** and injected **clock skew** are not modeled yet —
they'll be added when a property needs them rather than shipped half-working.
