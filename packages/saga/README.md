# @loom/saga — saga / compensation for Loom flows

Register compensating actions as a flow makes forward progress, then run them in **reverse** if the
flow fails. Compensators are ordinary `ctx.run` steps — which are already replay-guarded — so
rollback is **replay-safe with no new syscall, no new event type, and no fold change** (P10). See
[ADR 0041](../../docs/adr/0041-saga-compensation.md).

```ts
import { withSaga } from "@loom/saga";

const runner = async (ctx, input) =>
  withSaga(ctx, async (saga) => {
    const r = await saga.run(reserveStep, input, releaseStep); // release(r) undoes reserve
    const c = await saga.run(chargeStep, { id: r.id }, refundStep); // refund(c) undoes charge
    await ctx.run(shipStep, { id: c.id }); // if this throws → rollback runs refund, then release
    return { ok: true };
  });
```

## Guarantees

- **Reverse-order rollback** on a real error, then the error re-throws (`EXECUTION_FAILED`).
- **Replay-safe**: the compensation stack is rebuilt deterministically on a resume/recovery re-run;
  compensators run as `ctx.run` steps, so a crash mid-rollback recovers without re-running a
  compensator that COMPLETED (verified by a DST no-double-compensation property under seeded crashes).
  A compensator that FAILED (an untyped `STEP_FAILED`) is not a completion: it is retried on resume,
  so compensators must be idempotent (at-least-once on failure).
- **A compensator is any declared step**: a `toolId` step or a `handler$`-only step. Each runs under a
  derived, replay-stable journal id (`<id>#compensate:<i>`), but its effect — and so any grant or
  middleware keyed on a tool id — resolves on the step's DECLARED id (`toolId ?? id`), the same one the
  forward step uses.
- **A failing compensator does not stop the rollback**: the remaining compensators still run, then a
  `SagaCompensationError` is thrown (`compensationErrors` = each failure, in run order). Out of
  `withSaga` its `cause` is the ORIGINAL error that triggered the rollback. A `SuspendError` from a
  compensator (a human-gated undo) still propagates at once, as does any runtime signal
  (cancellation / abort, lost lease or stale fence, replay divergence, storage failure): it is
  re-thrown unwrapped, no further compensator runs, and it is never folded into `compensationErrors`.
  **Behaviour change:** a failed rollback out of `withSaga` is a `SagaCompensationError` (original
  error as `cause`), not the original error itself, so a caller matching the original type
  (e.g. a `TypedFailure`) must look at `err.cause`. When every compensator succeeds the original
  error is re-thrown unchanged. `createSaga().rollback()` throws a `SagaCompensationError` with no
  `cause`, and a second `rollback()` on the same saga is a no-op.
- **Byte-identical on success**: if the flow succeeds, no compensator runs and no compensation events
  exist — indistinguishable from a non-saga flow (G2).
- **Suspension ≠ failure**: `withSaga` never rolls back on a `SuspendError`; the flow suspends/resumes
  normally and the stack rebuilds on the resume re-run.

## Scope

Compensation is scoped to a `withSaga` block (or an explicit `createSaga` + `rollback()`), so undo
boundaries are explicit. Auto-compensating an unhandled failure outside a saga scope is intentionally
not supported — wrap the compensable work in `withSaga`.
