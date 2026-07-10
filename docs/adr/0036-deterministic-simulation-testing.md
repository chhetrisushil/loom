# ADR 0036 — Deterministic Simulation Testing (`@loom/dst`)

- Status: Accepted (2026-07-11)
- Date: 2026-07-11
- Builds on: the deterministic-replay foundation (P2), logged non-determinism (P9), the
  `EventStore` SPI + single-point `crashingEventStore` ([ADR 0033](0033-spi-conformance-contracts.md),
  K9 delivery contract), and the T1 durable-timer model (`TimerStore.due(now)`).

## Context

Loom's defining invariant is deterministic replay: executions are event-sourced and every source
of non-determinism is logged (P9). That is precisely the substrate a **deterministic simulation
testing** (DST) engine needs — the ability to seize control of the clock, the store, and the
transport, then replay an adversarial schedule bit-for-bit. Yet the kernel had only a single-point
crash helper (`crashingEventStore`) and example-based golden replay; there was no virtual clock, no
simulated network, no general/seeded fault injection, no invariant/property search, and no run
minimization. The hardening rings (K1–K12, T1–T2) were verified by hand-written example tests, not
by adversarial exploration.

## Decision

Add **`@loom/dst`**, a test/dev-only package that drives the real kernel under seeded fault
schedules and asserts its invariants. It is imported by **no runtime package**, so its production
overhead is **zero by construction** (dependency direction), not by a flag.

**Seeded sources.** `splitmix64(seed)` is the single entropy source (`Rng` with
`next/int/pick/bool/fork`); `fork(label)` derives independent, stable sub-streams. `virtualClock()`
is a discrete-event clock — time is already injectable because `TimerStore.due(now)` takes `now` as
a parameter and `EXECUTION_SUSPENDED.condition.wakeAt` is the only wall clock in the log.

**Fault injection over existing seams.** `faultInjectingStore` generalizes `crashingEventStore`'s
one predicate into an `Rng`-driven per-append/-delivery draw over the `EventStore` SPI, with two
modes over the same code: **explore** (sample from a `FaultModel`, recording each decision as a
`FaultDraw`) and **replay** (apply exactly a recorded `FaultDraw[]`, no rng). Modeled faults map to
real failure shapes: `crash` (swallow this + all later appends — the K9 window), `appendReject`
(transient write error), `msgLoss` / `msgDup` (lost/duplicated subscriber delivery). Optional store
methods are forwarded exactly as `crashingEventStore` does, so capability probes behave identically.

**SimWorld.** Bundles the seeded sources + a shared fault-injecting store and hands out fresh
`WorkflowRuntime` instances (`spawn()`) — each spawn models a new worker process picking up the
shared durable log, so crash-then-recover is expressed naturally.

**Invariants + property search.** Five built-in `Invariant`s over the durable log
(`noDoubleNonIdempotentEffect`, `logPrefixConsistency`, `fenceMonotonic`, `exactlyOnceOutcome`,
`resumeConvergence`). `checkProperty(prop, {seeds})` runs a scenario under many seeded schedules; on
the first violation it captures the seed + `FaultDraw[]` witness and **shrinks** it by
delta-debugging (drop fault subsets, replay, keep the smaller set that still fails), returning the
minimal reproducing schedule. `replaySchedule(prop, schedule, seed)` reproduces it deterministically.

## Consequences

- The kernel's core invariant becomes a **testing weapon**: every future change can be validated
  under adversarial crash/message schedules, and each later phase (audit chain, fair scheduler,
  lifecycle authz, orchestration, saga) ships with a DST property as its acceptance harness.
- A found bug is delivered as a **minimal, replayable schedule** — a pinnable regression, not a
  flaky seed.
- **No ABI/event-schema change; no core change.** DST is pure-additive and off the execution path
  (P10 respected; G1/G2 untouched).
- Honest scope: DST controls the durable store, transport delivery, and the poll clock — the seams
  where Loom's non-determinism actually lives. It does **not** intercept a runtime's internal
  `Date.now()` for wall-clock timestamps; the built-in invariants are log-structural and do not read
  timestamps, so PASS/FAIL reproduction is deterministic regardless. Message reordering and injected
  clock skew are deliberately **not** modeled yet (they need buffering / per-node skew) — added when
  a property needs them, rather than shipped half-working.

## Verification

- `@loom/dst` tests (20): `splitmix64`/`virtualClock` determinism; `faultInjectingStore`
  explore→record→replay reproduces the exact durable outcome, crash semantics, capability
  forwarding; a **machinery** property where a buggy SUT (ignores write failures → log gap) is
  found, shrunk to the essential rejection, and replayed deterministically, while a correct SUT
  reports `ok`; the **flagship** — the K9 crash-recovery contract as a seeded property:
  `checkProperty` finds no violation across the crash-schedule space, and a direct sweep proves
  crashes really fire while idempotency collapses to one logical charge and all five invariants
  hold.
- `faultStore.bench.ts` characterizes the harness's own append overhead (a small constant factor;
  absolute hz are machine-relative). `@loom/spec` registers the `dst` capability at **L4** (bench +
  tests; not L5 — it is a harness, not a wire contract).
