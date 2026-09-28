# ADR 0004 — Failure Recovery (idempotent redispatch)

- Status: Accepted (Step 4 of 5 — Cloud Run compute provider)
- Date: 2026-07-07
- Builds on: [ADR 0003](0003-cloud-run-worker-runtime.md)

## Context

Remote workers (Cloud Run instances) can crash or hang mid-execution. Recovery
must continue the execution — not restart it, and not re-run steps that already
committed (their effects had real side effects). Loom's durable event log +
snapshots already make this possible; Step 4 wires detection + idempotent
redispatch on top.

## Decision

**Detection (dispatcher).** `LocalDispatcher` gains `executeTimeoutMs`: an
attempt that throws (transport error / dead instance) OR exceeds the deadline
(wedged instance) is a failed attempt. With `maxAttempts > 1` the dispatcher
redispatches the same package. A flow-level `"failed"` result is NOT a failed
attempt — it is a normal terminal outcome and is returned, not retried.

**Idempotent recovery (worker).** Redispatch is safe because the worker inspects
durable state and does the right thing, via new `WorkflowRuntime.loadState()`
(folds current durable state without running):

- no durable events → **start** (fresh).
- status `running`/`pending` (crashed mid-flight, no terminal event) → **resume**
  from the latest snapshot. `WorkflowContext.run` skips completed steps
  (`vm.hasCompleted`), so their effects do NOT re-run; only the in-flight tail
  re-executes (at-least-once for the one interrupted step).
- status `completed`/`failed`/`suspended` (a "lost response" redispatch) →
  return the folded state **as-is**: no re-run, no duplicate `EXECUTION_STARTED`.

This makes `execute` idempotent under redispatch regardless of where the previous
attempt died, matching the plan's algorithm: *find latest snapshot → replay →
redispatch → continue*.

## Consequences

- No workflow restart and no duplicate side effects for completed steps — the
  core correctness guarantee for remote execution.
- The single interrupted step may run twice (unavoidable at-least-once);
  effect authors already design steps to tolerate replay, and completed steps are
  fully protected.
- The dispatcher stays cloud-agnostic: detection is timeout/throw-based over the
  `WorkerRuntime` SPI; nothing Cloud Run-specific leaks in.

## Verification

- `LocalDispatcher`: a hung worker (past `executeTimeoutMs`) is redispatched and
  the second attempt succeeds.
- `worker-runtime-local` recovery: a genuine mid-flight crash — instance A
  commits step A then hangs in step B and is abandoned; a *fresh* instance B over
  the same SQLite files redispatches the original package, resumes, runs only
  step B, completes, and leaves exactly one `EXECUTION_STARTED` (step A not
  re-run). Plus lost-response idempotency on an already-completed execution.
- Full repo: build + typecheck clean, 64/64 test tasks green, biome clean.

---

## Amendment (2026-09-14) — the boundary this ADR does not cover

The decision above recovers a dead or wedged **worker**, and it works: the dispatcher's
`executeTimeoutMs` turns a hung attempt into a failed one, redispatches, and the worker's
`loadState()` branch resumes idempotently. Nothing there changes.

What it does not cover is the **supervisor** dying. Detection lives in the dispatcher's
process memory — `private inFlight` and an awaited deadline — and `WorkerLease` is a
compute-allocation handle (`{ leaseId }`), not a durable record of who owns an execution. So
if the process holding the dispatcher is killed, nothing survives that knows an execution was
in flight. It stays `running` in the log with no owner.

**Why the log alone cannot fix this.** A `running` execution owned by a healthy node on
another machine and one orphaned by a dead supervisor are *byte-identical* in the log. No
fold distinguishes them, because the difference is not a fact about the execution — it is a
fact about the cluster. Only the deployment knows.

**What ships.** `recoverAbandoned(runtime, { source, isAbandoned })` in
`@loom/workflow-runtime`: a maintenance pass that enumerates via the shared
`iterateExecutionIds` loop, filters to `running`/`pending`, asks the caller's predicate, and
resumes what it claims through the **same** `EXECUTION_RECOVERED` path the worker uses under
redispatch. It re-checks status immediately before acting, so an execution that settled
between enumeration and decision is skipped rather than re-driven; a resume that throws is
left for the next pass.

`isAbandoned` is **required, with no default**, and that is the whole design. Defaulting to
`true` would preempt live work on other nodes; defaulting to `false` would be a pass that
silently recovers nothing while reading like it does — the vacuous-check pattern. A predicate
that wrongly claims a live execution still cannot corrupt the log (fencing, K9.4), but its
in-flight effect may land, so the interrupted step runs twice. That is the same at-least-once
this ADR already accepts for a genuine crash; the difference is paying it for a step that was
never interrupted.

**What deliberately does NOT ship.** A `LeaseStore`/heartbeat SPI that would let Loom answer
"is this orphaned?" itself. That is the correct end state and it is in-pattern (it would
mirror `TimerStore`/`TimerService` exactly), but it is new optional SPI plus a conformance
kit plus renewal during long effects — and the only concrete consumer today is this one pass.
Per [ADR 0083](0083-second-consumer-rule.md), it waits for a second, unrelated consumer;
"only one node should run this execution" is the likely candidate.

**Positioning consequence.** Loom has *in-process* supervision, not *durable* supervision.
That is an honest thing to say out loud: a dead worker is handled; a dead supervisor is a
deployment concern, the same as it is for any library rather than a hosted control plane.

---

## Amendment (2026-09-28) — a superseded dispatch is not a failed attempt (L20)

"An attempt that throws is a failed attempt" was too broad. Two throws mean *another holder
owns this execution*, not *this attempt failed*:

- `ExecutionAlreadyExistsError` — a start lost the sequence-0 race ([ADR 0103](0103-durable-bootstrap-for-caller-chosen-ids.md));
- `StaleFenceError`, bare or as the `cause` of a `StorageWriteError` — a newer `acquireFence`
  (another dispatch, a recovery pass, a fenced wake, a cancel) superseded this attempt's token.

Redispatching either is harmful, not merely wasted: `LocalWorkerRuntime.allocate` fences every
attempt, so the retry supersedes the holder that won, which is fenced out and retries in turn.
Measured on a one-step flow with `maxAttempts: 3` on two dispatchers: fences 1→6 and the step's
effect ran 5 times (sequence-0 race) or 6 (duplicate dispatch after the bootstrap);
`SupervisingDispatcher({ maxRestarts: 2 })` over them, 18. The bound this ADR states — *the
single interrupted step may run twice* — held only at `maxAttempts: 1`.

**Decision.** `isSupersededRefusal(err, executionId)` in `@loom/worker-runtime` names that
refusal, and a dispatcher MUST NOT retry or redispatch on it (Dispatcher SPI **1.1.0**, a
conformance-kit case enabled by `runExecutionDispatcherConformance(…, { overWorker })`).
`LocalDispatcher` rethrows it on the attempt that saw it; `SupervisingDispatcher` rethrows it
without a restart and without counting it against the circuit (losing to another holder is not
the target's fault — though an earlier genuine failure in the same dispatch still counts). The
predicate is precise on two axes:

- it requires the error to **name this execution**. A coalesced batch rejects every caller in it
  with one writer's error (ADR 0074, L1), so a stale fence naming another execution is, for
  this one, a genuine storage failure — still retried. That leaves one accepted imprecision: a
  batch holding writes for TWO fenced-out executions names only the first, so the second
  retries once, may supersede its live holder and re-run that step once more, and the holder it
  fenced out then settles. One bounded extra bounce per such batch, not a ping-pong;
- every other error, including every other `StorageWriteError`, is still a failed attempt.
  Nothing genuine is swallowed.

It matches by `name` rather than class, because the SPI package sits below the packages that
define those errors, and so a second bundled copy of one cannot hide a refusal (the rule
`isStaleFence` already follows). Because it matches the id, every layer between the store and
the dispatcher must report the CALLER's id: `TenantScopedEventStore` used to forward the store's
refusal naming the scoped key (`acme:x`), which read as a genuine failure and brought the
ping-pong back in full under tenancy. It now re-raises `StaleFenceError`,
`DuplicateSequenceError` and `DuplicateEnvelopeIdError` with the ids unscoped (same class and
name, original as `cause`); the predicate was deliberately not loosened to suffix matching.

**A start fenced out by a holder that wrote nothing is NOT superseded.** If a dispatcher takes
a fence and dies before its sequence 0, a racing start is refused on the fence with sequence 0
absent on both of `writeBootstrap`'s tries. Settling that as superseded lost the start outright:
an empty log, `loadState` null, invisible to `recoverAbandoned`. `writeBootstrap` now raises
`StorageWriteError` caused by `StartFencedOutError` there, which the predicate rejects, so the
dispatcher retries (nothing ran; the retry takes a newer fence and starts). A LIVE racer that
writes its sequence 0 meanwhile makes that retry lose cleanly as `ExecutionAlreadyExistsError`.

**What settling does and does not promise.** A superseded refusal TRANSFERS ownership to the
newer fence holder, and nothing checks that holder is alive. If it is a duplicate dispatcher
that dies mid-run — or one that times out at `maxAttempts: 1` while its wedged instance keeps
the fence — the execution sits in `running` with the refused dispatcher already settled. Its
liveness is then covered only by the new holder's own dispatcher policy and, beyond it, by
`recoverAbandoned` (the amendment above), which **a deployment MUST run** to cover dead holders.
The newer holder can even be the caller's own earlier HTTP attempt that timed out but kept
running: the execution completes there while `dispatch()` rejects with the refusal. So a
caller that needs the outcome treats the refusal as *await by id* (`loadState` / `subscribe`),
not as the execution failing. `executeGraph`, `InProcessA2ABus` and `dispatchPlan` do not do
that for you, and were left as they are: `executeGraph` holds only a dispatcher (no store to
await by id), `InProcessA2ABus` mints its own task ids (a collision needs a caller-supplied
`executionId`, and an injected dispatcher may place the run on stores its local runtime cannot
read), and `dispatchPlan` calls an app callback. The refusal surfaces to their caller as a
dispatch error, documented on `ExecutionDispatcher.dispatch` and `executeGraph`.

**Across the wire.** The HTTP worker ([ADR 0002](0002-http-worker-and-remote-worker-runtime.md))
used to answer the refusal as an opaque 500, which a remote caller could not tell from a crash.
It now answers `409 { error: "execution superseded", code: "superseded", executionId }` (and
calls `onSuperseded` so operators see it — it never reaches `onError`), and
`RemoteWorkerRuntime` (and so `CloudRunWorkerRuntime`, which delegates to it) rethrows that as
`ExecutionSupersededError` only when both the code and the executionId match. Any other 409
stays an ordinary failure.

**Takeover is unchanged.** Redispatching an execution whose holder is dead is a successful
`allocate` + `EXECUTION_RECOVERED` resume, never a refusal, so it still recovers; the zombie,
when it wakes, is fenced out and now settles instead of re-taking the execution. Defaults were
already safe (`maxAttempts: 1`, `maxRestarts: 0`).

**Verification.** `packages/worker-runtime-local/src/dispatcherSupersede.test.ts`, every case
over a plain store AND a `TenantScopedEventStore` — two real dispatchers over one store,
`maxAttempts: 3`, deterministic (no timers): the sequence-0 race runs the effect once, the
duplicate-after-bootstrap twice with fences `[1, 2]`, the supervised stack twice with its
circuit closed; a dead holder's execution is taken over with exactly one re-run while the
zombie (itself `maxAttempts: 3`) does not take it back; and a start fenced out by a holder that
never wrote completes. Mutation-checked: reverting the dispatcher checks restores 5 / 6 / 18,
reverting the tenant unscoping fails the tenant variants, reverting the `StartFencedOutError`
cause fails the lost-start cases. Unit cases pin the predicate's negatives, the unscoped
errors, and the 409 mapping end to end.
