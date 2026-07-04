import { SuspendError } from "@loom/core";
import type { EventEnvelope, StepDefinition } from "@loom/core";
import { createA2UIEmitter } from "@loom/a2ui";
import type { A2UIEmitter } from "@loom/a2ui";
import type { EffectRuntime } from "@loom/effect-runtime";
import type { EventStore } from "@loom/event-runtime";
import type { ReplayVM } from "@loom/replay-vm";
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
    private readonly eventStore: EventStore,
    private readonly effectRuntime: EffectRuntime,
    private readonly onEventEmitted: ((event: EventEnvelope) => void) | undefined = undefined
  ) {
    this.executionId = executionId;
    this.workflowId = workflowId;
    // A2UI patches flow through the normal event pipeline, so UI updates are
    // durable and replay deterministically alongside every other event.
    this.ui = createA2UIEmitter((eventType, payload) => this.emit(eventType, payload));
  }

  emit(eventType: string, payload: unknown): void {
    const sequence = this.eventStore.nextSequence(this.executionId);
    const envelope: EventEnvelope = {
      id: `${this.executionId}-${sequence}`,
      workflowId: this.workflowId,
      executionId: this.executionId,
      eventType,
      sequence,
      timestamp: Date.now(),
      payload,
    };
    this.eventStore.append(envelope);
    this.vm.applyEvent(envelope);
    this.onEventEmitted?.(envelope);
  }

  async run<TIn = unknown, TOut = unknown>(
    step: StepDefinition<TIn, TOut>,
    input: TIn
  ): Promise<TOut> {
    if (this.vm.hasCompleted(step.id)) {
      return this.vm.getOutput(step.id) as TOut;
    }

    this.emit("STEP_STARTED", { stepId: step.id, input });

    const effectCtx = {
      executionId: this.executionId,
      stepId: step.id,
      workflowId: this.workflowId,
      attempt: this.vm.getState().frames[step.id]?.attempts ?? 1,
      emit: (eventType: string, payload: unknown) => this.emit(eventType, payload),
    };

    const toolId = step.toolId ?? step.id;

    let output: TOut;
    try {
      output = await this.effectRuntime.execute<TIn, TOut>(toolId, input, effectCtx);
    } catch (err) {
      if (err instanceof SuspendError) {
        throw err;
      }
      this.emit("STEP_FAILED", { stepId: step.id, error: String(err) });
      throw err;
    }

    this.emit("STEP_COMPLETED", { stepId: step.id, output });
    return output;
  }

  async parallel<TResults extends unknown[]>(
    pairs: { [K in keyof TResults]: [StepDefinition<unknown, TResults[K]>, unknown] }
  ): Promise<TResults> {
    const results = await Promise.all(
      (pairs as Array<[StepDefinition, unknown]>).map(([step, input]) =>
        this.run(step, input)
      )
    );
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
      return Promise.resolve(state.variables["_resumePayload"]) as unknown as Promise<never>;
    }
    throw new SuspendError(_config);
  }
}
