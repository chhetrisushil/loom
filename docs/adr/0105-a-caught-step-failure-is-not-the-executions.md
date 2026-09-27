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
  reads, the terminal-failure write, the recovery bound and the timer reconcile pass that repairs
  what the old fold made the timer service discard). No 1P or 3P surface could hold it:
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
(`not-suspended`), `TimerService` retired a timed park's timer row as obsolete (it fires only a `suspended`
execution) so it never woke, and
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
| `resumeAs` / `answerEvents` | fold status | wrote a status-only `EXECUTION_RESUMED(null)` (terminal branch) | answers the parked gate with the caller's payload, with every gate check; a `null` payload after a while-parked failure is status-only and the gate re-parks (D3) |
| `TimerService` wake | status = suspended ∧ `wakeAt` | treated a timed park after a late sibling failure as obsolete and RETIRED its row | a failure after 1.21.0 keeps the row and wakes; a row a pre-1.21.0 service already retired is gone — `reconcileTimers` (D4) re-arms it |
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

### D3 — the fail-closed `null`; EVENT_SCHEMA 1.21.0; KERNEL_ABI unchanged

**The shape D1 alone would have misread.**

```
EXECUTION_SUSPENDED {on: "Approval"} · STEP_FAILED (late sibling) · … · EXECUTION_RESUMED(null)
```

1.20.0 folded the failure to `failed`, so `isStatusOnlyResume` read the `null` as a status-only
re-open and recorded no gate passthrough. A 1.20.0 kernel also WROTE this shape: `resumeAs` onto
what its fold called a `failed` execution took the terminal branch of `answerEvents` and recorded
`EXECUTION_RESUMED(null)`. With D1 alone the execution stays `suspended`, so the same `null`
would become the parked gate's answer (`_resumePayloads: [null]`) — ADR 0104's stray-answer
class. Worse, the outcome would depend on where the fold started: a 1.20.0 suspend snapshot
taken after that `resumeAs` never counted the `null`, so a resume through it gave the gate the
operator's answer, while a fold of the log alone (no snapshot, an earlier one, a fork) gave it
the `null` and the gate passed with no approval. That breaks snapshot + tail ≡ full log, a kernel
invariant.

**Rule.** A `STEP_FAILED` that lands while the execution is `suspended` sets the reserved fold
key `variables._failedWhileParked = true` (exported as `FAILED_WHILE_PARKED`). The next
`EXECUTION_SUSPENDED` or `EXECUTION_RESUMED` removes it; it is absent otherwise, so a log without
such a failure never gains it. An `EXECUTION_RESUMED` whose payload is `null` is status-only when
the execution is not `suspended`, is parked in doubt (1.20.0), **or carries
`_failedWhileParked`** (1.21.0). `inspectStrayPassthroughs` mirrors exactly this condition (its
own `failedWhileParked`, set on a `STEP_FAILED` while its mirrored status is `suspended`, cleared
at every park and resume), so its entry count still lines up with `_resumePayloads`.
`normalizeSnapshotState` sets the key when it repairs a parked 1.20.0 artifact: `failed` with
`suspendedOn` can only mean the failure landed after the park, because a resume removes
`suspendedOn` and a park overwrites an earlier `failed`.

**Cost (fail-closed).** A 1.21.0 caller that answers such a gate with an explicit `null` does not
have it recorded as the gate's answer: the gate re-parks, and the next non-null resume answers
it. Re-parking is recoverable and visible; a gate passing with no approval is neither. A `null`
answer to a gate with no failure since it parked is unaffected.

**Re-derived: what now differs between a 1.20.0 and a 1.21.0 reader.** Every gate passthrough is
identical: `_resumePayloads` folds the same for every log (a `null` after a while-parked failure
is status-only in both; every other resume is unchanged). What differs:

- the derived `status` after a `STEP_FAILED` that no lifecycle event has yet followed —
  `running` or `suspended` where 1.20.0 said `failed` — and everything that reads it (D2);
- the new reserved fold key `_failedWhileParked`, present while such a park is open.

That is a change in how existing logs fold plus a new fold key, which K5 versions (1.16.0 bumped
for an additive fold key alone). So the bump stays: **EVENT_SCHEMA 1.21.0**, no new event kind,
no payload field. No syscall changed: **KERNEL_ABI stays 1.1.0.**

**What this removed.** An earlier revision of this ADR served that `null` to the gate and added
machinery to cope: an `ambiguousNullResumes` report and warning, and a route into ADR 0104's
`ambiguous-legacy-answers` refusal for a human park. With the fail-closed rule the shape can no
longer be misread, by the fold or by its mirror, so both were deleted rather than left as checks
of a case that cannot arise.

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
  timed park whose failure lands after the upgrade wakes. One that a pre-1.21.0 `TimerService`
  already polled did NOT keep its timer: that service saw "failed" and retired the row as
  obsolete, so after the upgrade the execution reads `suspended` with a past `wakeAt` and no
  row, and nothing wakes it. `reconcileTimers(runtime, { source, timers })` (new,
  `@loom/workflow-runtime`) re-arms every suspended execution's `wakeAt` row. It needs no lookup
  in the TimerStore, because `schedule` is idempotent per (executionId, wakeAt): a healthy row is
  a no-op and a missing one is restored, and `TimerService`'s own still-waiting guard makes a
  duplicate fire a no-op. A following `null` resume is status-only (D3).
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
  The handle and `onEvent` are the kernel's IN-MEMORY view: `journal.commit` folds and publishes
  `EXECUTION_FAILED` before its write settles (as it does every event — a projection is fed in
  commit order, and holding one event back until its drain would reorder it against a
  sibling's later commit). So `handle.getState()` and an `onEvent` projection read `failed`
  while the log folds `running`. The rejection (and `onStorageError`) is what tells the caller
  which is durable; `loadState` and every recovery path read the log.

**Snapshots.** A snapshot is a stored fold, so one saved by an older fold inside that window
still holds `status: "failed"` — a cadence snapshot (`snapshotEvery`), a fork seed, or a
suspend snapshot a sibling's commit raced (Context). It is repaired on read, in O(1) on the
common path: `normalizeSnapshotState` (`@loom/replay-vm`) reads `failed` with no
`variables._error` and a failed step frame as the old fold's artifact — the kernel's only
`EXECUTION_FAILED` writer always records `error` — and restores `suspended` when the snapshot
is parked (`suspendedOn` survives only while parked), `running` otherwise. Every stored-fold
read path uses it: `resume`, `resumeAs`, `loadState`/`foldState`, `fork`, `restoreFromState`
(a preloaded state), `LogLifecycle` and the replay inspector. It cannot repair one case: an execution that genuinely failed, was re-opened
by `resumeAs` (which keeps `_error`), and then caught a step failure under an older fold — its
snapshot carries `_error`. Deleting that execution's snapshots (`snapshotStore.deleteExecution`)
makes the log authoritative.

**Upgrade blast radius.** On the first deploy of 1.21.0, every stored execution whose log ends
after a caught step failure changes from `failed` to `running`, all at once:

- the first `recoverAbandoned` pass with a staleness predicate (`updatedAt` older than N)
  selects ALL of them, however old, and re-drives each — re-executing its untyped failing
  effect; an execution whose flow code changed since throws `FlowCodeMismatchError` on every
  pass;
- `LogLifecycle` stops pruning them (they are no longer terminal);
- executions parked on a timer whose sibling failed under the old fold read `suspended` again
  but have NO timer row (the old service retired it), so nothing wakes them until
  `reconcileTimers` runs.

Before enabling recovery on the new version: run `orphanCensus` or
`recoverAbandoned({ dryRun: true })` to see the set; bound `isAbandoned` by age (and by
workflow) so years-old executions are not re-driven; cancel what should not resume; set
`maxRecoveries` (D5) so a poison execution stops costing every pass; and run
`reconcileTimers` once, so timed parks a pre-1.21.0 `TimerService` retired are re-armed (their
wake is already past, so they fire on the next poll).

### D5 — `recoverAbandoned({ maxRecoveries })`

This fix widens what recovery re-drives, including executions that can never succeed (a step
whose error text its store refuses — Postgres `jsonb` rejects `\u0000` — crashes every re-drive
the same way). `recoverAbandoned` had no bound, so each pass paid another at-least-once run of
the interrupted step, forever. It now takes an optional `maxRecoveries`:

- **Consecutive, not lifetime.** It counts the `EXECUTION_RECOVERED` events at the tail of the
  log since the last sign of progress — `STEP_COMPLETED`, `EXECUTION_SUSPENDED` or
  `EXECUTION_RESUMED`. A long-lived execution recovered many times over months, each re-drive
  moving on, is never stranded; only one whose re-drives keep dying the same way is. (A
  re-drive's replayed steps write nothing, so only real progress resets the count.)
- **Only for claimed candidates.** It is checked after `isAbandoned` (or the expired lease)
  claimed the execution and before this pass takes a lease, so a live execution is never
  reported and there is no lease to release. Skipped executions are counted in
  `summary.exhausted`, reported through `onExhausted(executionId, n)`, and left `running` for an
  operator; the next pass reports them again.
- **Cost:** a backward, paged read of the log's tail (`readRange`), stopping at the first progress
  event or at the bound — O(events since progress), not O(log).
- **Compaction** (`truncatePrefix`) can only hide older events, so it can undercount (one more
  re-drive), never overcount.
- **`≥ 1`, refused otherwise.** `0` would skip every candidate: a pass that recovers nothing
  while reading as if it ran. The default is unchanged: unbounded.
- `loom recover --max-recoveries N` exposes it and lists the exhausted executions.

## Consequences

- A flow that catches a step failure and then crashes is recovered by `recoverAbandoned`, can be
  cancelled, and is not pruned by retention while unfinished. A parked execution whose sibling
  failed after the park can be resumed and woken.
- `status === "failed"` now means one thing everywhere: the execution failed
  (`EXECUTION_FAILED` is in its log and `_error` is set). A step's failure is read from its
  frame.
- A caller whose run's terminal failure could not be written gets `StorageWriteError`, not the
  step's error.
- A gate never passes on a `null` resume recorded after a sibling failed while it was parked,
  whichever snapshot the fold starts from.
- Tests: `replay-vm/src/stepFailureStatus.test.ts` (the fold; the status property over every
  `STEP_*` kind × pending/running/suspended; the fail-closed `null` and its negatives; the
  property snapshot + tail ≡ full log from EVERY sequence, for snapshots written by the current
  fold and by a 1.20.0 replica read through `normalizeSnapshotState`, with the gate passthroughs
  equal to 1.20.0's; `normalizeSnapshotState`), `wire-abi` fold vectors for a caught failure and
  for the fail-closed `null`, `workflow-runtime/src/caughtStepFailure.test.ts` (two-process crash
  → recovery for untyped and typed failures — the typed one never re-invokes the effect —,
  through a mid-run snapshot and a hand-built pre-1.21.0 snapshot; cancel; the late sibling
  failure stays resumable; an explicit `null` answer in that position re-parks and the next
  answer lands (the D3 cost); the undurable `EXECUTION_FAILED` rejects with `StorageWriteError`
  while the handle keeps the in-memory view; `restoreFromState` repairs a preloaded pre-1.21.0
  state; `maxRecoveries` — consecutive, only for claimed candidates, two REAL passes over a
  poison flow, `0` refused; the negative: an escaped failure is `failed`, never a recovery
  candidate, not cancellable), `strayPassthroughs.test.ts` (the mirror reads the 1.20.0 shape
  as clean at a gate and at a human park; a `null` answer with no failure while parked is still
  an entry), `reconcileTimers.test.ts` (a row the old service retired is re-armed and wakes;
  idempotent), `legacyFoldResumeAs.test.ts` (a real `resumeAs` under a replica of the 1.20.0
  fold, replayed by 1.21.0 through the 1.20.0 snapshot and from the log alone: the same
  outcome, the operator's real answer) and the CLI's `--max-recoveries`.
