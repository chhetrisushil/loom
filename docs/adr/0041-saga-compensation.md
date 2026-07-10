# ADR 0041 — Saga / Compensation (`@loom/saga`)

- Status: Accepted (2026-07-11)
- Date: 2026-07-11
- Builds on: the `execute`/`run` syscall (replay-guarded via `vm.hasCompleted`) and `SuspendError`.
- Part of: the three-direction kernel arc, coordination primitives (Direction B), Phase 5.
- Supersedes the plan's "`ctx.compensate` syscall + `COMPENSATION_*` events" proposal — see below.

## Context

Loom had no first-class **saga / compensation**: reverse-order undo of completed work when a flow
fails. The plan proposed a new syscall `ctx.compensate` plus `COMPENSATION_*` governed events and a
runtime failure-path drain, arguing that "reverse-order undo must reconstruct the compensation stack
from the log and drive it deterministically on replay — userspace try/catch cannot be replay-safe."

## Decision — and the correction

**Building it disproved the premise.** Compensators can run as ordinary `ctx.run` steps, which are
**already replay-guarded** (`vm.hasCompleted` serves a completed step from the log without
re-executing). So a userspace saga is replay-safe *for free*:

- the compensation stack is a plain local array, rebuilt **deterministically** when a resume/recovery
  re-runs the flow (completed forward steps are served from the log; each `compensate(...)` re-pushes
  as the flow replays);
- a crash **mid-rollback** recovers correctly — already-run compensators are served from the log, the
  remaining ones run.

So `@loom/saga` ships as a **userspace library with NO new syscall, NO new event type, and NO fold
change** — `KERNEL_ABI` stays 1.1.0, `EVENT_SCHEMA_VERSION` stays 1.12.0. This is the fullest P10
outcome and carries **zero G1 risk** (the kernel's failure path is untouched), unlike the proposed
syscall + failure-path surgery.

**API.** `createSaga(ctx)` → `run(step, input, compensator?)` (runs a forward step and registers a
compensator that receives the forward output), `compensate(step, input)` (explicit), `rollback()`
(runs compensators in reverse as `ctx.run` steps, each given a unique, replay-stable id
`<id>#compensate:<i>`). `withSaga(ctx, body)` runs `body` as a saga and auto-rolls-back on a real
error, re-throwing — while a `SuspendError` propagates untouched (a suspension is not a failure; the
stack rebuilds on the resume re-run).

## Consequences

- First-class, replay-safe reverse-order compensation, opt-in per flow. On success, **no compensator
  runs and no compensation events exist** — byte-identical to a non-saga flow (G2).
- The one thing a syscall could do that this does not: auto-compensate an *unhandled* failure without
  a `withSaga` scope. Requiring an explicit scope makes compensation boundaries visible — a feature.
- Determinism/replay and the kernel failure path are entirely untouched (P2/G1).

## Verification

- `saga.test.ts` (3): on success, only forward steps run and no `#compensate:` frame is ever recorded
  (byte-identical); on failure, compensators run in **reverse** (`reserve, charge, ship, refund,
  unreserve`) and the error re-throws; the rollback is recorded as durable `STEP_COMPLETED` frames
  (`refund#compensate:1`, `unreserve#compensate:0`) alongside `EXECUTION_FAILED` — proving it replays.
- `saga.dst.test.ts` (`@loom/dst`): the failing saga driven under seeded crash schedules never
  double-compensates — no step (forward or compensation) completes more than once in the durable log,
  across the crash-schedule space (crashes really fire).
- `@loom/spec` registers `saga` at L2. `abi.test.ts` and `eventSchema.test.ts` are **unchanged**.
