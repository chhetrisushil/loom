# ADR 0135 — `waitForSuspend()` rejects when the run terminates before it parks

- Status: **Accepted** (2026-10-31) — owner decision on issue #710.
- Date: 2026-10-31
- Placement: **`@loom/workflow-runtime` public handle contract only. Kernel unchanged: KERNEL_ABI and
  EVENT_SCHEMA unchanged** (no event, fold or syscall changes; the handle is not part of the kernel manifest).

## Context

`ExecutionHandle.waitForSuspend()` resolved only when the run parked. A run that ended without parking
(it completed, failed, was cancelled, or continued as new) left it pending forever, so a caller that
awaited it alone hung. Issue #710 reported this as "the second resume of a compacted execution never
resolves": the second resume answered the LAST gate, so the run completed. Compaction was not involved.
Only the `continueAsNew` doc mentioned the behaviour ("never resolves `waitForSuspend()`").

## Decision

When the run terminates before parking, `waitForSuspend()` REJECTS with `ExecutionTerminatedError`
(exported from `@loom/workflow-runtime`):

- `state`: the folded state at the terminal (`completed`, `failed`, `cancelled`, `continued`); for a
  completion, the very state `waitForCompletion()` resolves with.
- `status`: `state.status`.
- `cause`: the error `waitForCompletion()` rejects with, for a failure or a cancellation.

Ordering: `waitForCompletion()` settles first, then `waitForSuspend()` rejects, in every terminal path, so
`Promise.race([waitForCompletion(), waitForSuspend()])` (either order) resolves as it always did. The
in-repo racers (`runAgentOnce`, the worker runtime, the timer service, orchestration, the CLI lifecycle)
need no change. A storage, lease or seal failure is not a termination: both promises still reject with that
error. The internal no-op `.catch` on the suspend promise stays, so a caller that never calls
`waitForSuspend()` gets no unhandled rejection.

## Consequences

- Behaviour change: code that awaited `waitForSuspend()` alone on a run that may finish used to hang and now
  throws. That is a visible failure in place of a silent one; such code should race the two promises or catch
  `ExecutionTerminatedError`.
- Rejected alternative: resolve `waitForSuspend()` with the terminal state. It would make "suspended" and
  "finished" indistinguishable by promise alone, and a caller that then resumed would resume a terminal run.
- Rejected alternative: leave it pending and document it. The hang is undetectable from the caller's side.
