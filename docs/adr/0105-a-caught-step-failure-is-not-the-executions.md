# ADR 0105 — A caught step failure is not the execution's failure

- Status: **Accepted — implemented** (2026-09-28)
- Date: 2026-09-28
- Found by: the ADR 0104 review, which recorded it as a known related gap (L14) and left it
  for its own decision because the fix changes the folded status of existing logs.
- Corrects: the `STEP_FAILED` fold as it interacts with [ADR 0004](0004-failure-recovery.md)
  (`recoverAbandoned` re-drives `running`/`pending` executions only),
  [ADR 0041](0041-saga-compensation.md) (compensations run after a caught failure),
  [ADR 0060](0060-typed-failure-channels.md) (a typed failure exists to be caught) and
  [ADR 0104](0104-recovery-never-answers-a-gate.md) (a `null` resume into an unparked
  execution is status-only).
- Placement: **kernel** (`@loom/replay-vm`, the fold; `@loom/workflow-runtime`, the snapshot
  reads, the terminal-failure write and the recovery bound). No 1P or 3P surface could hold it:
  the wrong value is produced by the fold, and every consumer reads the fold.
- **KERNEL_ABI unchanged (1.1.0). EVENT_SCHEMA 1.20.0 → 1.21.0** (D3): no event kind, no
  payload field, no fold key, and the kernel writes the same events — but the fold reads one
  existing log shape differently, which is what the version exists to say.

## Context — the defect

`STEP_FAILED` folded two things: the step's frame (`frames[stepId].status = "failed"`) and the
EXECUTION's status (`status = "failed"`). It was the only `STEP_*` event that moved the
execution status. `STEP_CANCELLED` deliberately does not; `EXECUTION_CANCELLED` owns that.

A step failure is not an execution failure. `ctx.run` throws, and the flow decides what the
throw means:

- `try { await ctx.run(a) } catch { … }` — a fallback, a default, a retry loop in flow code;
- a saga (ADR 0041) catches the failure and runs compensations;
- a typed failure (ADR 0060) exists precisely so the flow can take a declared branch.

Every one of those executions kept running under a status that read `failed` — a terminal
status — until the next lifecycle event overwrote it.

**A second, parked, variant.** A parallel branch can fail AFTER the flow parks:
`Promise.all([ctx.run(slow).catch(…), ctx.suspend({ on: "Approval" })])` commits
`EXECUTION_SUSPENDED`, then the sibling's `STEP_FAILED` (the journal has no closed-after-settle
guard, and a sibling's commit is legitimate log content). The old fold turned that `suspended`
into `failed`, which kept `suspendedOn` but read terminal: `resume` refused the gate
(`not-suspended`), `TimerService` never woke a timed park (it requires `suspended`), and
retention could prune the execution. The same can happen to a SUSPEND snapshot: the snapshot is
taken after `journal.drain()`, and a sibling can commit during that drain.

What read the fold got the wrong answer:

- **`recoverAbandoned` skipped it.** It re-drives `running`/`pending` executions only. A process
  that crashed after the catch left an execution nothing would ever recover. The same filter is
  in `LocalWorkerRuntime`'s redispatch, `resume`'s crash re-drive check and `orphanCensus`, so
  the dispatcher could not re-drive it either and the census did not count it.
- **`cancel` refused it.** A detached cancel folds the log and returns `false` for a terminal
  status, so the stranded execution could not even be stopped.
- **Retention treated it as finished.** `LogLifecycle` retains, archives and deletes terminal
  executions only; `failed` qualified. `eraseSubject` likewise classified it as settled.
- **A parked execution could not be resumed or woken** (above).
- **A2A peers were told it failed.** `LoomAgentExecutor.get` maps the folded status onto the A2A
  task status on every poll. A peer polling a live execution after a caught failure got `failed`
  with error `"unknown error"` (no `_error` exists yet), and `A2AClientEffect` stops polling on
  `failed`.
- **`loom trace`, `handle.getState()`, the wire ABI's `execution.getState` and
  `@loom/live-query`** showed a live execution as failed, so a subscriber waiting for a terminal
  state stopped early.

The log already distinguishes the outcomes. When a failure escapes the runner,
`WorkflowRuntime.execute` commits `EXECUTION_FAILED { error: String(err) }` — the only writer of
that event, and it always records `error` — and its fold sets `status = "failed"` and `_error`.
The step event never needed to guess.

## Decisions

### D1 — `STEP_FAILED` folds the frame only

`STEP_FAILED` sets `frames[stepId]` (status `failed`, `error`, and for a typed failure
`errorChannel`/`errorPayload`) and `updatedAt`, and leaves the execution `status` untouched —
the same contract as `STEP_CANCELLED`. The execution status is moved only by execution-level
events: `EXECUTION_STARTED`, `EXECUTION_SUSPENDED`, `EXECUTION_RESUMED`, `EXECUTION_COMPLETED`,
`EXECUTION_FAILED`, `EXECUTION_CANCELLED`. The kernel spec states this as a MUST, and a
property test holds every `STEP_*` kind `knownEventTypes()` reports, from each non-terminal
status, to it (`replay-vm/src/stepFailureStatus.test.ts`); a wire-ABI fold vector pins it for
foreign folds.

`EXECUTION_FAILED` is unchanged and remains the terminal failure. An escaped failure writes
`STEP_FAILED` then `EXECUTION_FAILED`, which folds to `failed` exactly as before.

`inspectStrayPassthroughs` (ADR 0104) mirrors the fold's status in its own pass; its
`STEP_FAILED → failed` line is removed with the fold's.

### D2 — every status consumer, and what it sees now

The fix is in the fold, so these consumers needed no code change; each was checked against what
it should see after a caught (or late sibling) step failure.

| Consumer | Reads | Before | Now |
|---|---|---|---|
| `recoverAbandoned` | fold status ∈ {running, pending} | skipped (unrecoverable) | recovered, runs to completion |
| `LocalWorkerRuntime` redispatch | same | returned `null` (no re-drive) | re-driven |
| `resume` with `EXECUTION_RECOVERED` | same | refused (`not-suspended`) | re-driven |
| `resume` at a gate (late sibling failure) | fold status = suspended | refused (`not-suspended`) | answers the gate |
| `resumeAs` / `answerEvents` | fold status | wrote a status-only `EXECUTION_RESUMED(null)` (terminal branch) | answers the parked gate with the caller's payload, with every gate check (D3) |
| `TimerService` wake | status = suspended ∧ `wakeAt` | never woke a timed park after a late sibling failure | wakes |
| `orphanCensus`, `retireAbandonedBranches` | fold status (+ suspended) | skipped as terminal | counted / retirable |
| `cancel` (detached) | fold status terminal? | `false`, not cancellable | cancelled |
| `LogLifecycle` retention, `eraseSubject` | fold status terminal? | eligible for pruning / "settled" | `not-terminal` / live |
| `@loom/deploy-sim` `flow-hash` census | status ∈ {suspended, running} | a live caught-failure execution skipped the drain-or-pin check | checked |
| A2A `LoomAgentExecutor` / `toTaskResult` (polled) | fold status | `failed`, `"unknown error"` | `working` |
| wire ABI `execution.getState` (`carrier.stateView`) | fold status | `failed` | `running` / `suspended` |
| `loom trace`, `handle.getState()`, `@loom/live-query` subscribers | fold status | `failed`, subscriber stopped early | `running`, waits for the real terminal |
| `loom eval` goldens (`evaluateGoldens`, `expect.status`) | fold status of a recorded log | a golden that pinned `failed` for a log ending after a caught failure | now `running`: such a golden fails loudly and must be re-recorded — it pinned the bug |
| `InProcessA2ABus` | fold status after dispatch settles | unaffected: it maps the state `waitForCompletion`/`waitForSuspend` settled with, which a caught failure never produced as `failed` | unchanged |
| `@loom/analytics` (`analyze`, `introspect`, `profile`), `@loom/learning` trajectories, `@loom/telemetry`, `@loom/orchestration` child outcomes, DST invariants, audit-chain, CLI glyphs | the EVENTS (`EXECUTION_FAILED`) | already correct | unchanged |

The last row is the tell: every consumer that derived status from the events themselves already
treated only `EXECUTION_FAILED` as the execution's failure. The fold was the outlier.

### D3 — EVENT_SCHEMA 1.21.0; KERNEL_ABI unchanged

The K5 version tells a reader that a stored log folds differently. The kernel writes the same
events, and for a log that ends after a caught failure the only difference is the derived
status. But one existing log shape now replays differently, and it reaches a replay input:

```
EXECUTION_SUSPENDED {on: "Approval"} · STEP_FAILED (late sibling) · … · EXECUTION_RESUMED(null)
```

1.20.0 folded the failure to `failed`, so `isStatusOnlyResume` read the `null` as a status-only
re-open and added no passthrough. 1.21.0 keeps the execution `suspended`, so the same `null` is
the parked gate's answer (`_resumePayloads: [null]`). And a 1.20.0 kernel WROTE exactly this
shape: `resumeAs` onto what its fold called a `failed` execution took the terminal branch of
`answerEvents` and recorded `EXECUTION_RESUMED(null)`. Replayed by 1.21.0, that entry is served
to the gate as its approval — ADR 0104's stray-answer class. So the version bumps (1.21.0; no new
kind, no payload field), and:

- **`inspectStrayPassthroughs` reports it** (`ambiguousNullResumes`): a `null` resume into a
  gate park after a `STEP_FAILED` that landed while parked. The runtime warns once per execution
  on resume. It is reported, not refused: no log records which kernel wrote an entry, and a
  1.21.0 caller answering the gate with an explicit `null` writes the same shape, which is
  legitimate. The operator decides (cancel, or inspect and continue).
- The window is narrow — the 1.20.0 status-only `null` exists only since ADR 0104, and only a
  `resumeAs` after a late sibling failure wrote it here. A log a pre-1.20.0 kernel wrote folds as
  it did under that kernel: `resumeAs` then recorded the operator's payload, which every fold
  before 1.20.0 treated as the gate's answer.

No syscall changed: KERNEL_ABI stays 1.1.0.

### D4 — legacy logs, snapshots and the upgrade

Every legacy log folds to the same status it did before, except where a `STEP_FAILED` is not
followed by a status-setting event:

- **Completed / suspended-then-resumed / cancelled / escaped-failure logs:** a later lifecycle
  event set the status then and sets it now. Identical.
- **A log that ends between a caught failure and the next lifecycle event** — the crashed
  execution this ADR is about — now folds `running` and is recoverable. Recovery replays it: an
  untyped failure re-executes (ADR 0060 G2 at-least-once, like any non-completed step on
  recovery), a typed failure is substituted without calling the effect, the flow takes its catch
  branch again, and continues.
- **A late sibling failure while parked** now folds `suspended`: the gate can be answered, and a
  timed park wakes. A following `null` resume is covered by D3.
- **The process died after `STEP_FAILED` was durable but before `EXECUTION_FAILED` was
  written**, or **storage died** (`journal.failed`: the kernel deliberately writes no
  `EXECUTION_FAILED` into a store that cannot accept it). Both used to fold `failed`; both now
  fold `running`, and recovery re-drives them. That is correct: the execution never durably
  reached a terminal decision.
- **The `EXECUTION_FAILED` write itself failed.** The kernel used to drain it best-effort
  (`.catch(() => {})`) and reject the caller with the step's error, so the caller was told
  "failed" while the log folds `running` and a later recovery could complete it. The run now
  rejects with `StorageWriteError` (`cause` = the store's error), as the storage-died branch
  already did: the caller learns the outcome is not durable.

**Snapshots.** A snapshot is a stored fold, so one saved by an older fold inside that window
still holds `status: "failed"` — a cadence snapshot (`snapshotEvery`), a fork seed, or a
suspend snapshot a sibling's commit raced (Context). It is repaired on read, in O(1) on the
common path: `normalizeSnapshotState` (`@loom/replay-vm`) reads `failed` with no
`variables._error` and a failed step frame as the old fold's artifact — the kernel's only
`EXECUTION_FAILED` writer always records `error` — and restores `suspended` when the snapshot
is parked (`suspendedOn` survives only while parked), `running` otherwise. Every snapshot read
path uses it: `resume`, `resumeAs`, `loadState`/`foldState`, `fork`, `LogLifecycle` and the
replay inspector. It cannot repair one case: an execution that genuinely failed, was re-opened
by `resumeAs` (which keeps `_error`), and then caught a step failure under an older fold — its
snapshot carries `_error`. Deleting that execution's snapshots (`snapshotStore.deleteExecution`)
makes the log authoritative.

**Upgrade blast radius.** On the first deploy of 1.21.0, every stored execution whose log ends
after a caught step failure changes from `failed` to `running`, all at once:

- the first `recoverAbandoned` pass with a staleness predicate (`updatedAt` older than N)
  selects ALL of them, however old, and re-drives each — re-executing its untyped failing
  effect; an execution whose flow code changed since throws `FlowCodeMismatchError` on every
  pass;
- `LogLifecycle` stops pruning them (they are no longer terminal).

Before enabling recovery on the new version: run `orphanCensus` or
`recoverAbandoned({ dryRun: true })` to see the set; bound `isAbandoned` by age (and by
workflow) so years-old executions are not re-driven; cancel what should not resume; and set
`maxRecoveries` (D5) so a poison execution stops costing every pass.

### D5 — `recoverAbandoned({ maxRecoveries })`

This fix widens what recovery re-drives, including executions that can never succeed (a step
whose error text its store refuses — Postgres `jsonb` rejects `\u0000` — crashes every re-drive
the same way). `recoverAbandoned` had no bound, so each pass paid another at-least-once run of
the interrupted step, forever. It now takes an optional `maxRecoveries`, counted from the log's
`EXECUTION_RECOVERED` events (so the bound holds across passes, processes and nodes); an
execution at the bound is skipped, counted in `summary.exhausted`, and reported through
`onExhausted(executionId, recoveries)`. The default is unchanged: unbounded. Setting it costs
one log read per candidate.

## Consequences

- A flow that catches a step failure and then crashes is recovered by `recoverAbandoned`, can be
  cancelled, and is not pruned by retention while unfinished. A parked execution whose sibling
  failed after the park can be resumed and woken.
- `status === "failed"` now means one thing everywhere: the execution failed
  (`EXECUTION_FAILED` is in its log and `_error` is set). A step's failure is read from its
  frame.
- A caller whose run's terminal failure could not be written gets `StorageWriteError`, not the
  step's error.
- Tests: `replay-vm/src/stepFailureStatus.test.ts` (the fold; the status property over every
  `STEP_*` kind × pending/running/suspended; the 1.21.0 `[SUSPENDED, STEP_FAILED,
  RESUMED(null)]` pin; `normalizeSnapshotState`, with negatives), `wire-abi` fold vector
  "a caught step failure fails the frame, not the execution",
  `workflow-runtime/src/caughtStepFailure.test.ts` (two-process crash → recovery for untyped and
  typed failures — the typed one never re-invokes the effect —, through a mid-run snapshot and a
  hand-built pre-1.21.0 snapshot; cancel; the late sibling failure stays resumable; the
  undurable `EXECUTION_FAILED` rejects with `StorageWriteError`; `maxRecoveries`; the negative:
  an escaped failure is `failed`, never a recovery candidate, not cancellable), and
  `strayPassthroughs.test.ts` (the ambiguous `null`, with three negatives).
