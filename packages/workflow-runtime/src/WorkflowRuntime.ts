import { SuspendError } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import type { Effect, EffectRuntime } from "@loom/effect-runtime";
import type { EventStore } from "@loom/event-runtime";
import { ReplayVM } from "@loom/replay-vm";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import { ulid } from "ulid";
import { WorkflowContextImpl } from "./WorkflowContext";
import type {
  ExecutionHandle,
  FlowRunner,
  RegisteredFlow,
  ResumeEvent,
  RunOptions,
} from "./types";

export interface WorkflowRuntimeDeps {
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  effectRuntime: EffectRuntime;
  onEvent?: (event: EventEnvelope) => void;
}

export class WorkflowRuntime {
  private readonly eventStore: EventStore;
  private readonly snapshotStore: SnapshotStore;
  private readonly effectRuntime: EffectRuntime;
  private readonly onEvent: ((event: EventEnvelope) => void) | undefined;
  private readonly flows = new Map<string, RegisteredFlow>();

  constructor(deps: WorkflowRuntimeDeps) {
    this.eventStore = deps.eventStore;
    this.snapshotStore = deps.snapshotStore;
    this.effectRuntime = deps.effectRuntime;
    this.onEvent = deps.onEvent;
  }

  register(toolId: string, effect: Effect): void {
    this.effectRuntime.register(toolId, effect);
  }

  registerFlow<TIn, TOut>(
    definition: RegisteredFlow<TIn, TOut>["definition"],
    runner: FlowRunner<TIn, TOut>
  ): void {
    this.flows.set(definition.id, { definition, runner } as RegisteredFlow);
  }

  async start<TIn = unknown, TOut = unknown>(
    flow: RegisteredFlow<TIn, TOut>,
    input: TIn,
    options?: RunOptions
  ): Promise<ExecutionHandle> {
    const executionId = options?.executionId ?? ulid();
    const { definition, runner } = flow;

    const startEnvelope: EventEnvelope = {
      id: `${executionId}-0`,
      workflowId: definition.id,
      executionId,
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: Date.now(),
      payload: { input },
    };
    this.eventStore.append(startEnvelope);
    this.onEvent?.(startEnvelope);

    const vm = new ReplayVM([startEnvelope], {
      executionId,
      workflowId: definition.id,
      workflowVersion: definition.version,
    });

    return this.execute(
      executionId,
      definition.id,
      definition.version,
      vm,
      runner as FlowRunner<unknown, unknown>,
      input
    );
  }

  async resume(executionId: string, resumeEvent: ResumeEvent): Promise<ExecutionHandle> {
    const allEvents = this.eventStore.read(executionId);
    if (allEvents.length === 0) {
      throw new Error(`No execution found for id: ${executionId}`);
    }

    const firstEvent = allEvents[0]!;
    const startPayload = firstEvent.payload as { input?: unknown };
    const originalInput = startPayload.input;

    const workflowId = firstEvent.workflowId;
    const flow = this.flows.get(workflowId);
    if (!flow) {
      throw new Error(`No flow registered for workflowId: "${workflowId}"`);
    }

    const snapshot = this.snapshotStore.loadLatest(executionId);
    let vm: ReplayVM;

    if (snapshot) {
      const eventsAfterSnapshot = this.eventStore.readFrom(executionId, snapshot.sequence + 1);
      vm = new ReplayVM(eventsAfterSnapshot, snapshot.state);
    } else {
      vm = new ReplayVM(allEvents, {
        executionId,
        workflowId: flow.definition.id,
        workflowVersion: flow.definition.version,
      });
    }

    const resumeEnvelope: EventEnvelope = {
      id: `${executionId}-resume-${Date.now()}`,
      workflowId,
      executionId,
      eventType: resumeEvent.eventType,
      sequence: this.eventStore.nextSequence(executionId),
      timestamp: Date.now(),
      payload: resumeEvent.payload,
    };
    this.eventStore.append(resumeEnvelope);
    vm.applyEvent(resumeEnvelope);
    this.onEvent?.(resumeEnvelope);

    const resumedEnvelope: EventEnvelope = {
      id: `${executionId}-resumed-${Date.now()}`,
      workflowId,
      executionId,
      eventType: "EXECUTION_RESUMED",
      sequence: this.eventStore.nextSequence(executionId),
      timestamp: Date.now(),
      payload: resumeEvent.payload,
    };
    this.eventStore.append(resumedEnvelope);
    vm.applyEvent(resumedEnvelope);
    this.onEvent?.(resumedEnvelope);

    return this.execute(
      executionId,
      workflowId,
      flow.definition.version,
      vm,
      flow.runner as FlowRunner<unknown, unknown>,
      originalInput
    );
  }

  private execute(
    executionId: string,
    workflowId: string,
    _workflowVersion: string,
    vm: ReplayVM,
    runner: FlowRunner<unknown, unknown>,
    input: unknown
  ): ExecutionHandle {
    let resolveCompletion!: (state: ReturnType<typeof vm.getState>) => void;
    let rejectCompletion!: (err: unknown) => void;
    let resolveSuspend!: (state: ReturnType<typeof vm.getState>) => void;

    const completionPromise = new Promise<ReturnType<typeof vm.getState>>(
      (resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      }
    );

    const suspendPromise = new Promise<ReturnType<typeof vm.getState>>((resolve) => {
      resolveSuspend = resolve;
    });

    const ctx = new WorkflowContextImpl(
      executionId,
      workflowId,
      vm,
      this.eventStore,
      this.effectRuntime,
      this.onEvent
    );

    const run = async () => {
      try {
        const output = await runner(ctx, input);

        const seq = this.eventStore.nextSequence(executionId);
        const completedEnvelope: EventEnvelope = {
          id: `${executionId}-${seq}`,
          workflowId,
          executionId,
          eventType: "EXECUTION_COMPLETED",
          sequence: seq,
          timestamp: Date.now(),
          payload: { output },
        };
        this.eventStore.append(completedEnvelope);
        vm.applyEvent(completedEnvelope);
        this.onEvent?.(completedEnvelope);

        resolveCompletion(vm.getState());
      } catch (err) {
        if (err instanceof SuspendError) {
          const suspendEnvelope: EventEnvelope = {
            id: `${executionId}-suspend-${Date.now()}`,
            workflowId,
            executionId,
            eventType: "EXECUTION_SUSPENDED",
            sequence: this.eventStore.nextSequence(executionId),
            timestamp: Date.now(),
            payload: { condition: err.condition },
          };
          this.eventStore.append(suspendEnvelope);
          vm.applyEvent(suspendEnvelope);
          this.onEvent?.(suspendEnvelope);

          const snap: Snapshot = {
            id: ulid(),
            executionId,
            workflowId,
            sequence: vm.getState().sequence,
            state: vm.getState(),
            createdAt: Date.now(),
          };
          this.snapshotStore.save(snap);

          resolveSuspend(vm.getState());
          return;
        }

        const seq = this.eventStore.nextSequence(executionId);
        const failedEnvelope: EventEnvelope = {
          id: `${executionId}-${seq}`,
          workflowId,
          executionId,
          eventType: "EXECUTION_FAILED",
          sequence: seq,
          timestamp: Date.now(),
          payload: { error: String(err) },
        };
        this.eventStore.append(failedEnvelope);
        vm.applyEvent(failedEnvelope);
        this.onEvent?.(failedEnvelope);

        rejectCompletion(err);
      }
    };

    void run();

    return {
      executionId,
      waitForCompletion: () => completionPromise,
      waitForSuspend: () => suspendPromise,
      getState: () => vm.getState(),
    };
  }
}
