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
