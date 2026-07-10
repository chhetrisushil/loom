# 12 — Extension Seams (SPI map)

> **Status:** Reference — the one place that enumerates every *replaceable* seam in Loom.
> Landed by [ADR 0033](../adr/0033-spi-conformance-contracts.md) (accepted item #6 of the
> [Execution-OS evaluation](../requirements/2026-07-10-execution-operating-system-evaluation.md)).

Loom is a **generic execution kernel**: the kernel carries mechanism, and every edge is a
pluggable SPI so third parties can supply their own storage, compute, effects, and policy
without forking Loom (P10). This is the "kernel extension model" — as documentation over the
SPIs that already exist, plus **portable conformance kits** so an implementation can *prove* it
conforms (not just compile against the interface).

## How to prove conformance

Reference impls and third-party impls run the same kit from `@loom/testing`:

```ts
import { runEventStoreConformance } from "@loom/testing/conformance";
import { MyEventStore } from "./MyEventStore";

runEventStoreConformance(() => new MyEventStore(/* … */), "MyEventStore");
```

The kit exercises the **required** contract and skips **optional** methods a backend omits. The
in-memory and SQLite reference impls both run these kits in
`packages/testing/src/conformance.test.ts` — that is what pins the contracts.

## Storage seams

| Seam | Interface | Required | Optional | Reference impls | Conformance kit |
|---|---|---|---|---|---|
| **Event log** | `EventStore` (`@loom/event-runtime`) | `append`, `read`, `readFrom`, `subscribe`, `close` | `readRange`, `acquireFence` (K9.4), `copyPrefix` (fork fast-path), `deleteExecution`/`truncatePrefix` (K10) | `InMemoryAsyncEventStore`, `SqliteEventStore`, `PostgresEventStore` | `runEventStoreConformance` |
| **Snapshots** | `SnapshotStore` (`@loom/snapshot-runtime`) | `save`, `loadLatest`, `loadAt`, `loadLatestBefore`, `close` | `deleteExecution` (K10.1) | `InMemoryAsyncSnapshotStore`, `SqliteSnapshotStore`, `PostgresSnapshotStore` | `runSnapshotStoreConformance` |
| **Branches** | `BranchRegistry` (`@loom/event-runtime`) | `putRef`, `getRef`, `listRefs`, `moveTip`, `promote`, `deleteRef`, `recordLineage`, `getLineage`, `children`, `close` | — | `InMemoryBranchRegistry`, `SqliteBranchRegistry`, `PostgresBranchRegistry` | `runBranchRegistryConformance` |
| **Timers** | `TimerStore` (`@loom/event-runtime`) | `putTimer`, `dueTimers`, `deleteTimer`, `close` | fencing (multi-node) | `InMemoryTimerStore`, `SqliteTimerStore`, `PostgresTimerStore` | — (future) |

## Compute seams

| Seam | Interface | Required | Reference impls |
|---|---|---|---|
| **Dispatch** | `ExecutionDispatcher` (`@loom/dispatcher`) | `dispatch`, `cancel`, `health` | `LocalDispatcher`, `PlacementDispatcher` (routing), `SupervisingDispatcher` (K4 circuit-breaker) |
| **Worker** | `WorkerRuntime` (`@loom/worker-runtime`) | `allocate`, `execute`, `release` (`cancel` optional) | `LocalWorkerRuntime`, `RemoteWorkerRuntime`, `CloudRunWorkerRuntime` |

*(A dispatcher conformance kit is a natural follow-up; it needs a mock `WorkerRuntime`, so it is
staged separately from the storage kits.)*

## Effect & policy seams

| Seam | Interface | Role | Reference / examples |
|---|---|---|---|
| **Effect** | `Effect<TIn,TOut>` (`@loom/effect-runtime`) | The unit of side effect; `execute` + optional `idempotent`/`warm` | `ToolEffect`, `IsolatedToolEffect` (K7), LLM effect |
| **Middleware** | `EffectMiddleware` (`@loom/effect-runtime`) | Wraps every effect: auth → retry → meter → safety → redact | `retryMiddleware`, `meteringMiddleware` (K3), `safetyMiddleware` (K6), `redactionMiddleware` (K10) |
| **Authority** | `CapabilityAuthorizer` (`@loom/effect-runtime`) | K2 protection ring — allow/deny per effect | `GrantTable`, `DelegationAuthorizer` (K12.4) |
| **Scheduler** | `Scheduler` (`@loom/scheduler`) | M6 bounded concurrency + priority (advisory; zero-overhead default) | `createScheduler` |
| **Warmer** | `Warmer` (`@loom/effect-runtime`) | M6 advisory pre-warm (latency-only, off-log) | ADR 0027 |

## Observability & projection seams

| Seam | Interface | Role | Reference / examples |
|---|---|---|---|
| **Telemetry** | `TelemetryAdapter` (`@loom/telemetry`) | Spans/metrics over the event stream | OpenTelemetry adapter sketch |
| **Projection** | `ProjectionRuntime` (`@loom/projection-runtime`) | Fold events into read models / UI surfaces | `InMemoryProjectionRuntime` |

## The contract, not the impl, is normative

Alongside the runtime ABIs this completes the "provable contract" story:

- **K1** — kernel syscall ABI (`KERNEL_SYSCALLS` + `abi.test.ts`).
- **K5** — event-schema ABI (`EVENT_SCHEMA_VERSION` + `knownEventTypes()` + `eventSchema.test.ts`).
- **ADR 0033** — the storage SPIs above, via `run<Spi>Conformance` kits.

A third-party runtime is possible precisely because these contracts are pinned and testable —
swap any seam, run its kit, ship.
