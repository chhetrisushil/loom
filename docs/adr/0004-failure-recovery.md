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
