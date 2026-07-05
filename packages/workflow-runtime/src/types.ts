import type { A2UIEmitter } from "@loom/a2ui";
import type { ExecutionState, FlowDefinition, StepDefinition } from "@loom/core";

export interface SuspendConfig {
  on: string;
  timeout?: number;
  correlationKey?: string;
}

export interface WorkflowContext {
  readonly executionId: string;
  readonly workflowId: string;

  run<TIn = unknown, TOut = unknown>(step: StepDefinition<TIn, TOut>, input: TIn): Promise<TOut>;

  parallel<TResults extends unknown[]>(
    pairs: { [K in keyof TResults]: [StepDefinition<unknown, TResults[K]>, unknown] },
    // Optional bounded concurrency. Omit for the current unbounded behaviour.
    // Results are always returned in input order regardless of `limit`, which is
    // load-bearing for deterministic replay.
    options?: { limit?: number }
  ): Promise<TResults>;

  suspend(config: SuspendConfig): Promise<never>;

  emit(eventType: string, payload: unknown): void;

  stream(eventType: string, delta: string, done?: boolean): void;

  // A2UI — drive the UI with durable, replayable patch/event updates.
  // ctx.ui.set(path, value) / append / merge / increment / remove / patch.
  readonly ui: A2UIEmitter;
}

export interface RunOptions {
  executionId?: string;
}

export interface ExecutionHandle {
  executionId: string;
  waitForCompletion(): Promise<ExecutionState>;
  waitForSuspend(): Promise<ExecutionState>;
  getState(): ExecutionState;
  /**
   * Cancel this live execution. Aborts the signal handed to in-flight effects,
   * records a durable EXECUTION_CANCELLED event, and rejects waitForCompletion.
   * Only affects in-flight work — already-persisted state and resume semantics
   * are unchanged. Idempotent.
   */
  cancel(reason?: unknown): void;
}

export type FlowRunner<TIn, TOut> = (ctx: WorkflowContext, input: TIn) => Promise<TOut>;

export interface RegisteredFlow<TIn = unknown, TOut = unknown> {
  definition: FlowDefinition<TIn, TOut>;
  runner: FlowRunner<TIn, TOut>;
}

export interface ResumeEvent {
  eventType: string;
  payload: unknown;
}

export interface ForkOptions {
  /** Optional branch name to register a movable ref for the new branch. */
  branchName?: string;
  /** Optional explicit executionId for the child (defaults to a fresh ULID). */
  executionId?: string;
}

export interface ForkResult {
  /** The child (forked) execution id. */
  executionId: string;
  parentExecutionId: string;
  /** The sequence the branch forked at. */
  forkSequence: number;
  /** The branch name registered, if any (else the child executionId). */
  branchName: string;
  /**
   * Materialized ExecutionState at the fork point, already stamped with the
   * child executionId. Hand directly to `restoreFromState` to drive the branch
   * down an alternate path, or call `resume(child.executionId, …)`.
   */
  state: ExecutionState;
}
