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
  compensators run as `ctx.run` steps, so a crash mid-rollback recovers without double-undoing
  (verified by a DST no-double-compensation property under seeded crashes).
- **Byte-identical on success**: if the flow succeeds, no compensator runs and no compensation events
  exist — indistinguishable from a non-saga flow (G2).
- **Suspension ≠ failure**: `withSaga` never rolls back on a `SuspendError`; the flow suspends/resumes
  normally and the stack rebuilds on the resume re-run.

## Scope

Compensation is scoped to a `withSaga` block (or an explicit `createSaga` + `rollback()`), so undo
boundaries are explicit. Auto-compensating an unhandled failure outside a saga scope is intentionally
not supported — wrap the compensable work in `withSaga`.
