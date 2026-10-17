import { StorageWriteError, SuspendError } from "@loom/core";
import type { StepDefinition } from "@loom/core";
import {
  ExecutionCancelledError,
  FlowDivergenceError,
  LeaseHeldError,
  LeaseLostError,
  SealedPayloadUnreadableError,
} from "@loom/workflow-runtime";
import type { ExecutionContext } from "@loom/workflow-runtime";

// ── Saga / compensation ───────────────────────────────────────────────────────
//
// Register compensating actions as a flow makes forward progress, then run them in
// REVERSE if the flow fails — the classic saga pattern. Crucially this needs NO new
// syscall and NO new event type: compensators run as ordinary `ctx.run` steps, which
// are already replay-guarded (`vm.hasCompleted`). So the whole thing is replay-safe
// for free:
//   • the compensation stack is a plain local array, rebuilt deterministically when a
//     resume/recovery re-runs the flow (completed forward steps are served from the
//     log, and each `compensate(...)` re-pushes as the flow replays);
//   • a crash mid-rollback recovers correctly — already-run compensators are served
//     from the log, the rest run.
// (An unhandled failure only auto-compensates inside a `withSaga` scope — compensation
// boundaries are explicit, which is a feature, not a limitation. A suspension is NOT a
// failure, so `withSaga` never rolls back on `SuspendError`.)

// Errors that are the RUNTIME talking, not a compensator failing: a suspension, a
// cancellation / abort, a lost lease or stale fence (this driver no longer owns the
// execution), replay divergence, an unreadable sealed payload, a storage failure. They
// propagate at once — folding them into `compensationErrors` would keep calling
// `ctx.run` on a dead context and mask the real cause. Classes from packages saga does
// not depend on (`StaleFenceError`) are matched by their stable `name`.
const RUNTIME_ERROR_NAMES = new Set([
  "StaleFenceError",
  "ExecutionCancelledError",
  "AbortError",
  "LeaseLostError",
  "LeaseHeldError",
  "StartFencedOutError",
  "StartLeaseHeldError",
]);

function isRuntimeSignal(err: unknown): boolean {
  if (
    err instanceof SuspendError ||
    err instanceof ExecutionCancelledError ||
    err instanceof LeaseLostError ||
    err instanceof LeaseHeldError ||
    err instanceof FlowDivergenceError ||
    err instanceof SealedPayloadUnreadableError ||
    err instanceof StorageWriteError
  ) {
    return true;
  }
  return err instanceof Error && RUNTIME_ERROR_NAMES.has(err.name);
}

type AnyStep = StepDefinition<unknown, unknown>;

interface Compensation {
  step: AnyStep;
  input: unknown;
}

/** A running saga scope over an execution context. */
export interface Saga {
  /**
   * Run a forward step, and (optionally) register a compensator for it. The
   * compensator receives the forward step's OUTPUT as its input — the usual "undo
   * what was just created" shape. Use {@link compensate} for a custom input.
   */
  run<TIn, TOut>(
    step: StepDefinition<TIn, TOut>,
    input: TIn,
    compensator?: StepDefinition<TOut, unknown>
  ): Promise<TOut>;
  /** Register a compensator to run (in reverse) if the saga rolls back. */
  compensate<T>(step: StepDefinition<T, unknown>, input: T): void;
  /**
   * Run all registered compensators in REVERSE order, as replay-safe `ctx.run` steps. A
   * failing compensator does not stop the rest; throws {@link SagaCompensationError} after.
   */
  rollback(): Promise<void>;
  /** Number of compensators currently registered. */
  readonly pending: number;
}

/** Create a {@link Saga} bound to an execution context. */
export function createSaga(ctx: Pick<ExecutionContext, "run">): Saga {
  const stack: Compensation[] = [];
  let rolledBack = false;

  return {
    get pending() {
      return stack.length;
    },
    async run(step, input, compensator) {
      const output = await ctx.run(step, input);
      if (compensator !== undefined) {
        stack.push({ step: compensator as AnyStep, input: output });
      }
      return output;
    },
    compensate(step, input) {
      stack.push({ step: step as AnyStep, input });
    },
    async rollback() {
      if (rolledBack) return; // idempotent within a run
      rolledBack = true;
      // Reverse order. Each compensator gets a UNIQUE, STABLE step id so its fold
      // frame never collides with the forward step or another compensation, and the
      // ids are identical across replay (same stack → same order → same suffixes).
      // The derived id is JOURNAL identity only: the effect is still resolved on the
      // compensator's DECLARED id (`toolId ?? id`) — the runtime registers a `handler$`
      // under that id, never under the derived one — so grants and middleware keyed on
      // the original tool id apply unchanged.
      //
      // A compensator that fails does NOT stop the rollback: the remaining ones still
      // run (undo is best-effort per step; abandoning the rest would leave forward side
      // effects uncompensated), and the failures are thrown together afterwards. A
      // `SuspendError` or any other runtime signal (cancellation, lost lease / stale fence,
      // divergence, storage failure — see `isRuntimeSignal`) is not the compensator's own
      // failure and propagates at once, unwrapped, with no further compensator run.
      const failures: unknown[] = [];
      for (let i = stack.length - 1; i >= 0; i--) {
        const { step, input } = stack[i] as Compensation;
        const compStep: AnyStep = {
          ...step,
          id: `${step.id}#compensate:${i}`,
          toolId: step.toolId ?? step.id,
        };
        try {
          await ctx.run(compStep, input);
        } catch (err) {
          if (isRuntimeSignal(err)) throw err;
          failures.push(err);
        }
      }
      if (failures.length > 0) throw new SagaCompensationError(failures);
    },
  };
}

/**
 * One or more compensators failed during rollback. The remaining compensators still ran.
 * When thrown out of {@link withSaga}, `cause` is the ORIGINAL error that triggered the
 * rollback and `compensationErrors` holds each compensator failure (in run order).
 */
export class SagaCompensationError extends Error {
  readonly compensationErrors: readonly unknown[];
  constructor(compensationErrors: readonly unknown[], ...original: [] | [cause: unknown]) {
    const first = compensationErrors[0];
    const firstNote = first instanceof Error ? ` (first: ${first.message})` : "";
    super(
      `saga rollback: ${compensationErrors.length} compensator(s) failed${firstNote}`,
      original.length === 0 ? undefined : { cause: original[0] }
    );
    this.name = "SagaCompensationError";
    this.compensationErrors = compensationErrors;
  }
}

/**
 * Run `body` as a saga: if it throws a real error, roll back (run registered
 * compensators in reverse) and re-throw. A `SuspendError` is NOT a failure — it
 * propagates untouched so the flow suspends/resumes normally (the stack is rebuilt on
 * the resume re-run).
 */
export async function withSaga<T>(
  ctx: Pick<ExecutionContext, "run">,
  body: (saga: Saga) => Promise<T>
): Promise<T> {
  const saga = createSaga(ctx);
  try {
    return await body(saga);
  } catch (err) {
    if (err instanceof SuspendError) throw err; // suspension, not failure
    try {
      await saga.rollback();
    } catch (rollbackErr) {
      if (rollbackErr instanceof SagaCompensationError) {
        // Keep the ORIGINAL error reachable (as `cause`) — never replace it.
        // (`err` may legitimately be `undefined` — a thrown `undefined` is still the cause.)
        throw new SagaCompensationError(rollbackErr.compensationErrors, err);
      }
      throw rollbackErr; // SuspendError from a human-gated compensator
    }
    throw err;
  }
}
