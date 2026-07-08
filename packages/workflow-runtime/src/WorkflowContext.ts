import { createA2UIEmitter } from "@loom/a2ui";
import type { A2UIEmitter } from "@loom/a2ui";
import { SuspendError } from "@loom/core";
import type { ExecutableTask, StepDefinition } from "@loom/core";
import type { EffectRuntime } from "@loom/effect-runtime";
import type { ReplayVM } from "@loom/replay-vm";
import { parallelLimit } from "@loom/scheduler";
import type { ExecutionJournal } from "./ExecutionJournal";
import type { SuspendConfig, WorkflowContext } from "./types";

export class WorkflowContextImpl implements WorkflowContext {
  readonly executionId: string;
  readonly workflowId: string;
  readonly ui: A2UIEmitter;
  private suspendPassthroughConsumed = false;

  constructor(
    executionId: string,
    workflowId: string,
    private readonly vm: ReplayVM,
    // The per-execution write pipeline: allocates sequences, folds the VM, fires
    // onEvent, and persists durably. Shared with WorkflowRuntime so sequence
    // allocation has a single source of truth.
    private readonly journal: ExecutionJournal,
    private readonly effectRuntime: EffectRuntime,
    // Cooperative cancellation for this execution. Threaded into every effect
    // context so long-running I/O (LLM/tool/A2A) can abort. Undefined = never
    // cancelled (existing behaviour).
    private readonly signal: AbortSignal | undefined = undefined
  ) {
    this.executionId = executionId;
    this.workflowId = workflowId;
    // A2UI patches flow through the normal event pipeline, so UI updates are
    // durable and replay deterministically alongside every other event.
    this.ui = createA2UIEmitter((eventType, payload) => this.emit(eventType, payload));
  }

  // Synchronous: the journal allocates a sequence, folds the VM, fires onEvent,
  // and enqueues the durable write. The async persistence is drained at barriers.
  emit(eventType: string, payload: unknown): void {
    this.journal.commit(eventType, payload);
  }

  // Loom 2.0 — the generalized durable primitive. `run` is now a thin alias that
  // forwards a StepDefinition (the 'step' task kind) here. All task kinds resolve
  // through the EffectRuntime by toolId, and the wire events stay STEP_* so
  // existing logs replay byte-identically.
  async execute<TIn = unknown, TOut = unknown>(
    task: ExecutableTask<TIn, TOut>,
    input: TIn
  ): Promise<TOut> {
    const id = task.id;
    if (this.vm.hasCompleted(id)) {
      return this.vm.getOutput(id) as TOut;
    }

    this.emit("STEP_STARTED", { stepId: id, input });

    const effectCtx = {
      executionId: this.executionId,
      stepId: id,
      workflowId: this.workflowId,
      attempt: this.vm.getState().frames[id]?.attempts ?? 1,
      emit: (eventType: string, payload: unknown) => this.emit(eventType, payload),
      ...(this.signal !== undefined && { signal: this.signal }),
    };

    const toolId = task.toolId ?? id;

    let output: TOut;
    try {
      output = await this.effectRuntime.execute<TIn, TOut>(toolId, input, effectCtx);
    } catch (err) {
      if (err instanceof SuspendError) {
        throw err;
      }
      // A cancelled execution surfaces here as an effect rejection. Record it as
      // a cancelled step (not a failure) so the event log and replayed state stay
      // truthful; EXECUTION_CANCELLED owns the execution-level status.
      if (this.signal?.aborted === true) {
        this.emit("STEP_CANCELLED", { stepId: id });
        throw err;
      }
      this.emit("STEP_FAILED", { stepId: id, error: String(err) });
      throw err;
    }

    this.emit("STEP_COMPLETED", { stepId: id, output });
    return output;
  }

  run<TIn = unknown, TOut = unknown>(step: StepDefinition<TIn, TOut>, input: TIn): Promise<TOut> {
    return this.execute<TIn, TOut>(step, input);
  }

  async parallel<TResults extends unknown[]>(
    pairs: { [K in keyof TResults]: [StepDefinition<unknown, TResults[K]>, unknown] },
    options?: { limit?: number }
  ): Promise<TResults> {
    // parallelLimit preserves input order in the result array (deterministic
    // replay) and degenerates to Promise.all when no limit is set. Each step
    // already threads this.signal via its effect context, so we don't forward
    // parallelLimit's per-task signal here.
    const tasks = (pairs as Array<[StepDefinition, unknown]>).map(
      ([step, input]) =>
        () =>
          this.run(step, input)
    );
    const results = await parallelLimit(tasks, {
      ...(options?.limit !== undefined && { limit: options.limit }),
      ...(this.signal !== undefined && { signal: this.signal }),
    });
    return results as TResults;
  }

  stream(eventType: string, delta: string, done = false): void {
    this.emit(eventType, { delta, done });
  }

  suspend(_config: SuspendConfig): Promise<never> {
    // During resume replay, _resumePayload marks that this suspend was already
    // triggered and the workflow was subsequently resumed. Pass through instead of
    // re-throwing so execution continues past the suspend point.
    const state = this.vm.getState();
    if ("_resumePayload" in state.variables && !this.suspendPassthroughConsumed) {
      this.suspendPassthroughConsumed = true;
      return Promise.resolve(state.variables._resumePayload) as unknown as Promise<never>;
    }
    throw new SuspendError(_config);
  }
}
