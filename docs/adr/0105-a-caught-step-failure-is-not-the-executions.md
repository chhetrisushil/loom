# ADR 0105 — A caught step failure is not the execution's failure

- Status: **Accepted — implemented** (2026-09-28)
- Date: 2026-09-28
- Found by: the ADR 0104 review, which recorded it as a known related gap (L14) and left it
  for its own decision because the fix changes the folded status of existing logs.
- Corrects: the `STEP_FAILED` fold as it interacts with [ADR 0004](0004-failure-recovery.md)
  (`recoverAbandoned` re-drives `running`/`pending` executions only),
  [ADR 0041](0041-saga-compensation.md) (compensations run after a caught failure) and
  [ADR 0060](0060-typed-failure-channels.md) (a typed failure exists to be caught).
- Placement: **kernel** (`@loom/replay-vm`, the fold). No 1P or 3P surface could hold it: the
  wrong value is produced by the fold, and every consumer reads the fold.
- **KERNEL_ABI unchanged (1.1.0). EVENT_SCHEMA unchanged (1.20.0)** (D3): no event kind, no
  payload field, no fold key, and the kernel writes the same bytes it wrote before.

## Context — the defect

`STEP_FAILED` folded two things: the step's frame (`frames[stepId].status = "failed"`) and the
EXECUTION's status (`status = "failed"`). It was the only `STEP_*` event that moved the
execution status. `STEP_CANCELLED` deliberately does not; `EXECUTION_CANCELLED` owns that.

A step failure is not an execution failure. `ctx.run` throws, and the flow decides what the
throw means:

- `try { await ctx.run(a) } catch { … }` — a fallback, a default, a retry loop in flow code;
- a saga (ADR 0041) catches the failure and runs compensations;
- a typed failure (ADR 0060) exists precisely so the flow can take a declared branch.

Every one of those executions keeps running under a status that read `failed` — a terminal
status — until the next lifecycle event (`EXECUTION_SUSPENDED`, `EXECUTION_COMPLETED`, …)
overwrote it. What read the fold in that window got the wrong answer:

- **`recoverAbandoned` skipped it.** It re-drives `running`/`pending` executions only. A process
  that crashed after the catch left an execution nothing would ever recover. The same filter is
  in `LocalWorkerRuntime`'s redispatch, `resume`'s crash re-drive check and `orphanCensus`, so
  the dispatcher could not re-drive it either and the census did not count it.
- **`cancel` refused it.** A detached cancel folds the log and returns `false` for a terminal
  status, so the stranded execution could not even be stopped.
- **Retention treated it as finished.** `LogLifecycle` retains, archives and deletes terminal
  executions only; `failed` qualified. A crashed-after-catch execution's log was eligible for
  pruning while its work was unfinished. `eraseSubject` likewise classified it as settled
  rather than live.
- **A2A peers were told it failed.** `LoomAgentExecutor.get` maps the folded status onto the A2A
  task status. A peer polling a live, healthy execution after a caught failure got
  `failed` with error `"unknown error"` (no `_error` exists yet), and `A2AClientEffect` stops
  polling on `failed`. `InProcessA2ABus` has the same mapping.
- **`loom trace`, `handle.getState()` and `@loom/live-query`** showed a live execution as
  failed, so a subscriber waiting for a terminal state stopped early.

The log already distinguishes the two outcomes. When a failure escapes the runner,
`WorkflowRuntime.execute` commits `EXECUTION_FAILED { error }` (the one writer of that event),
and its fold sets `status = "failed"` and `_error`. A caught failure is followed by whatever the
flow did next. The step event never needed to guess.

## Decisions

### D1 — `STEP_FAILED` folds the frame only

`STEP_FAILED` sets `frames[stepId]` (status `failed`, `error`, and for a typed failure
`errorChannel`/`errorPayload`) and `updatedAt`, and leaves the execution `status` untouched —
the same contract as `STEP_CANCELLED`. The execution status is moved only by execution-level
events: `EXECUTION_STARTED`, `EXECUTION_SUSPENDED`, `EXECUTION_RESUMED`, `EXECUTION_COMPLETED`,
`EXECUTION_FAILED`, `EXECUTION_CANCELLED`.

`EXECUTION_FAILED` is unchanged and remains the terminal failure. An escaped failure writes
`STEP_FAILED` then `EXECUTION_FAILED`, which folds to `failed` exactly as before.

`inspectStrayPassthroughs` (ADR 0104) mirrors the fold's status in its own pass. Its
`STEP_FAILED → failed` line is removed with the fold's. It only compares that status with
`suspended`, so its verdicts are unchanged.

### D2 — every status consumer, and what it sees now

The fix is in the fold, so each consumer below needed no code change; each was checked against
what it should see.

| Consumer | Reads | Before, after a caught failure | Now |
|---|---|---|---|
| `recoverAbandoned` | fold status ∈ {running, pending} | skipped (unrecoverable) | recovered, runs to completion |
| `LocalWorkerRuntime` redispatch | same | returned `null` (no re-drive) | re-driven |
| `resume` with `EXECUTION_RECOVERED` | same | refused (`not-suspended`) | re-driven |
| `orphanCensus`, `retireAbandonedBranches` | same (+ suspended) | skipped as terminal | counted / retirable |
| `cancel` (detached) | fold status terminal? | `false`, not cancellable | cancelled |
| `LogLifecycle` retention, `eraseSubject` | fold status terminal? | eligible for pruning / "settled" | `not-terminal` / live |
| A2A `toTaskResult`, `InProcessA2ABus` | fold status | `failed`, `"unknown error"` | `working` |
| `loom trace`, `handle.getState()` | fold status | `failed` | `running` |
| `@loom/live-query` subscribers (e.g. an `awaitTerminal` that stops on `completed`/`failed`, as `loom-examples`' `child-orchestration` has) | pushed fold status | stopped early with no `_output` | wait for the real terminal |
| `@loom/analytics` (`analyze`, `introspect`, `profile`), `@loom/learning` trajectories, `@loom/telemetry`, `@loom/orchestration` child outcomes, DST invariants, audit-chain, CLI glyphs | the EVENTS (`EXECUTION_FAILED`) | already correct | unchanged |

The last row is the tell: every consumer that derived status from the events themselves already
treated only `EXECUTION_FAILED` as the execution's failure. The fold was the outlier.

### D3 — no EVENT_SCHEMA bump, no KERNEL_ABI change

The K5 version protects a READER of the log against a log it would mis-fold. Its earlier
fold-level bumps each changed what a writer puts on disk or what replay feeds the flow:
1.16.0 (`_resumePayloads`, a replay input), 1.19.0 (the `flowEmit` envelope stamp), 1.20.0 (the
kernel's new `null` resume). An older reader folding a newer log would have replayed it wrongly,
so the version had to say so.

Nothing like that happens here:

- **The writer is unchanged.** The kernel writes the same events in the same order.
- **Replay is unchanged.** No flow code reads `state.status`. The one fold rule that does
  (`isStatusOnlyResume`, 1.20.0) tests only for `suspended`, which `STEP_FAILED` never set or
  cleared. Replay's inputs — frames, `_resumePayloads`, decisions, emits — are byte-identical.
- **An older reader of a new log** sees the old (wrong) status, exactly as it does for any old
  log. There is no new-log-specific misreading to warn it about.

What changes is one derived value on existing logs, in one window: after a `STEP_FAILED` that no
lifecycle event has yet followed, `status` now reads what the execution actually was — `running`
— instead of `failed`. That is the fix, not a compatibility hazard.

### D4 — legacy logs

Every legacy log folds to the same status it did before, except in that window:

- **Completed / suspended / cancelled / escaped-failure logs:** the following lifecycle event
  set the status then and sets it now. Identical.
- **A log that ends between a caught failure and the next lifecycle event** — the crashed
  execution this ADR is about — now folds to `running` and becomes recoverable. Recovery replays
  it: the untyped failure re-executes (at-least-once, as any non-completed step on recovery), a
  typed failure is substituted (ADR 0060), the flow takes its catch branch again, and continues.
- **A log whose storage died after `STEP_FAILED`** (`journal.failed`: the kernel deliberately
  writes no `EXECUTION_FAILED` into a store that cannot accept it) used to fold to `failed`. It
  now folds to `running`, so `recoverAbandoned` re-drives it once storage is back. That is the
  correct outcome: the execution never reached a terminal decision, and an interrupted write is
  what recovery exists for.

## Residuals

- **A legacy mid-run snapshot can still hold the old status.** A snapshot folded by the old
  kernel between a caught failure and the next lifecycle event stored `status: "failed"`, and
  `loadState` folds snapshot + tail, so that execution still reads `failed` until its snapshots
  are discarded. Only the opt-in `snapshotEvery` cadence and a `fork` at such a point can have
  written one (suspend snapshots store `suspended`; settle checkpoints follow a lifecycle event).
  Remedy: `snapshotStore.deleteExecution(executionId)` — snapshots are an optimisation, and the
  log then folds to `running`. No heuristic repair is attempted: telling such a snapshot from a
  real terminal failure needs the log, and reading it on every load of every failed execution
  would put a full-log read on the hot path to correct a one-time artifact. New snapshots are
  correct (tested).
- **Recovery re-executes an untyped caught failure.** This is ADR 0060's G2 at-least-once rule
  for untyped failures, unchanged; a flow that must not repeat the failing call uses a typed
  failure channel, which is substituted on replay.

## Consequences

- A flow that catches a step failure and then crashes is recovered by `recoverAbandoned`, can be
  cancelled, and is not pruned by retention while unfinished.
- `status === "failed"` now means one thing everywhere: the execution failed
  (`EXECUTION_FAILED` is in its log and `_error` is set). A step's failure is read from its
  frame.
- Tests: `replay-vm/src/stepFailureStatus.test.ts` pins the fold (caught untyped and typed
  failures stay `running`; an escaped failure and a bare `EXECUTION_FAILED` fold to `failed`),
  and `workflow-runtime/src/caughtStepFailure.test.ts` drives the crash end to end in two
  processes (recover to completion, through a mid-run snapshot, cancel), with the negative case:
  an escaped failure is `failed`, never a recovery candidate, and not cancellable.
