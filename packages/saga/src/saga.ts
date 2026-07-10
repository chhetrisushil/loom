import { SuspendError } from "@loom/core";
import type { StepDefinition } from "@loom/core";
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
  /** Run all registered compensators in REVERSE order, as replay-safe `ctx.run` steps. */
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
      for (let i = stack.length - 1; i >= 0; i--) {
        const { step, input } = stack[i] as Compensation;
        const compStep: AnyStep = { ...step, id: `${step.id}#compensate:${i}` };
        await ctx.run(compStep, input);
      }
    },
  };
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
    await saga.rollback();
    throw err;
  }
}
