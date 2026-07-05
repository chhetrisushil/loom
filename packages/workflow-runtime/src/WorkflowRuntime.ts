import { SuspendError } from "@loom/core";
import type { EventEnvelope, ExecutionState } from "@loom/core";
import { LazyEffect } from "@loom/effect-runtime";
import type { Effect, EffectRuntime } from "@loom/effect-runtime";
import type { BranchRegistry, EventStore } from "@loom/event-runtime";
import { ReplayVM } from "@loom/replay-vm";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import { ulid } from "ulid";
import { WorkflowContextImpl } from "./WorkflowContext";
import type {
  ExecutionHandle,
  FlowRunner,
  ForkOptions,
  ForkResult,
  RegisteredFlow,
  ResumeEvent,
  RunOptions,
} from "./types";

export interface WorkflowRuntimeDeps {
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  effectRuntime: EffectRuntime;
  onEvent?: (event: EventEnvelope) => void;
  /**
   * Optional branch registry. When provided, `fork()` records fork lineage and
   * (if a branchName is given) a movable ref. Without it, `fork()` still copies
   * the prefix and seeds the child snapshot — it just skips ref/lineage bookkeeping.
   */
  branchRegistry?: BranchRegistry;
}

export class WorkflowRuntime {
  private readonly eventStore: EventStore;
  private readonly snapshotStore: SnapshotStore;
  private readonly effectRuntime: EffectRuntime;
  private readonly onEvent: ((event: EventEnvelope) => void) | undefined;
  private readonly branchRegistry: BranchRegistry | undefined;
  private readonly flows = new Map<string, RegisteredFlow>();

  constructor(deps: WorkflowRuntimeDeps) {
    this.eventStore = deps.eventStore;
    this.snapshotStore = deps.snapshotStore;
    this.effectRuntime = deps.effectRuntime;
    this.onEvent = deps.onEvent;
    this.branchRegistry = deps.branchRegistry;
  }

  register(toolId: string, effect: Effect): void {
    this.effectRuntime.register(toolId, effect);
  }

  registerFlow<TIn, TOut>(
    definition: RegisteredFlow<TIn, TOut>["definition"],
    runner: FlowRunner<TIn, TOut>
  ): void {
    this.flows.set(definition.id, { definition, runner } as RegisteredFlow);
    for (const step of definition.steps) {
      const toolId = step.toolId ?? step.id;
      if (step.handler !== undefined && !this.effectRuntime.has(toolId)) {
        this.effectRuntime.register(toolId, new LazyEffect(step.handler));
      }
    }
  }

  async restoreFromState(
    preloadedState: ExecutionState,
    resumeEvent?: ResumeEvent
  ): Promise<ExecutionHandle> {
    const flow = this.flows.get(preloadedState.workflowId);
    if (!flow) {
      throw new Error(`No flow registered for workflowId: "${preloadedState.workflowId}"`);
    }
    const vm = new ReplayVM([], preloadedState);
    if (resumeEvent) {
      const envelope: EventEnvelope = {
        id: `${preloadedState.executionId}-restore-${Date.now()}`,
        workflowId: preloadedState.workflowId,
        executionId: preloadedState.executionId,
        eventType: resumeEvent.eventType,
        sequence: preloadedState.sequence + 1,
        timestamp: Date.now(),
        payload: resumeEvent.payload,
      };
      this.eventStore.append(envelope);
      vm.applyEvent(envelope);
      this.onEvent?.(envelope);
    }
    const originalInput = preloadedState.variables._input;
    return this.execute(
      preloadedState.executionId,
      preloadedState.workflowId,
      preloadedState.workflowVersion,
      vm,
      flow.runner as FlowRunner<unknown, unknown>,
      originalInput
    );
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

  /**
   * Fork an execution at `atSequence` into a new, independent branch for
   * speculative/what-if work. Branch-only — there is no merge; select a winner
   * with `branchRegistry.promote()`.
   *
   * Storage model (physical prefix copy): the parent's events [0..atSequence]
   * are copied verbatim into the child executionId — only `id` and
   * `executionId` change, and foldEvents reads neither, so the copied prefix
   * folds to a byte-identical state. The child then gets a seed snapshot at the
   * fork point so a later resume folds an empty tail. The parent log is never
   * touched, so the parent stays intact and independently resumable.
   *
   * Drive the branch down a new path via `restoreFromState(result.state, …)`,
   * or `resume(result.executionId, …)` if the fork point is a suspend.
   */
  async fork(
    parentExecutionId: string,
    atSequence: number,
    opts?: ForkOptions
  ): Promise<ForkResult> {
    const parentEvents = this.eventStore.read(parentExecutionId);
    if (parentEvents.length === 0) {
      throw new Error(`No execution found for id: ${parentExecutionId}`);
    }

    const tip = parentEvents[parentEvents.length - 1]!.sequence;
    if (atSequence < 0 || atSequence > tip) {
      throw new Error(
        `Invalid fork point ${atSequence} for execution ${parentExecutionId} (valid range 0..${tip})`
      );
    }

    const childId = opts?.executionId ?? ulid();
    const workflowId = parentEvents[0]!.workflowId;
    const workflowVersion = this.flows.get(workflowId)?.definition.version ?? "";

    // 1. Materialize state at the fork point (reusing the nearest prior snapshot).
    const forkState = this.materializeStateAt(
      parentExecutionId,
      atSequence,
      parentEvents,
      childId,
      workflowId,
      workflowVersion
    );

    // 2. Copy the prefix [0..atSequence] into the child log. Re-stamp id +
    //    executionId, record provenance in metadata. No synthetic EXECUTION_FORKED
    //    event — inserting one would perturb sequence numbering and break the
    //    prefix-identity guarantee the determinism argument relies on.
    for (const e of parentEvents) {
      if (e.sequence > atSequence) break;
      const copy: EventEnvelope = {
        ...e,
        executionId: childId,
        id: `${childId}-${e.sequence}`,
        metadata: {
          ...e.metadata,
          forkedFrom: parentExecutionId,
          forkSequence: atSequence,
        },
      };
      this.eventStore.append(copy);
      this.onEvent?.(copy);
    }

    // 3. Seed the child snapshot at the fork point so resume(child) folds an
    //    empty tail instead of replaying from sequence 0.
    const seed: Snapshot = {
      id: ulid(),
      executionId: childId,
      workflowId,
      sequence: atSequence,
      state: forkState,
      createdAt: Date.now(),
    };
    this.snapshotStore.save(seed);

    // 4. Record lineage + optional movable ref.
    const branchName = opts?.branchName ?? childId;
    if (this.branchRegistry) {
      this.branchRegistry.recordLineage({
        executionId: childId,
        parentExecutionId,
        forkSequence: atSequence,
      });
      if (opts?.branchName !== undefined) {
        const now = Date.now();
        this.branchRegistry.putRef({
          name: opts.branchName,
          executionId: childId,
          tip: atSequence,
          parentExecutionId,
          forkSequence: atSequence,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    return {
      executionId: childId,
      parentExecutionId,
      forkSequence: atSequence,
      branchName,
      state: forkState,
    };
  }

  /**
   * Materialize ExecutionState at `atSequence` for a fork, stamped with the
   * child executionId. Folds from the nearest snapshot at/below the fork point
   * (falling back to a full prefix fold) so long histories don't replay from zero.
   */
  private materializeStateAt(
    parentExecutionId: string,
    atSequence: number,
    parentEvents: EventEnvelope[],
    childId: string,
    workflowId: string,
    workflowVersion: string
  ): ExecutionState {
    const base = this.snapshotStore.loadLatestBefore(parentExecutionId, atSequence);
    let vm: ReplayVM;
    if (base) {
      const tail = parentEvents.filter(
        (e) => e.sequence > base.sequence && e.sequence <= atSequence
      );
      vm = new ReplayVM(tail, base.state);
    } else {
      const prefix = parentEvents.filter((e) => e.sequence <= atSequence);
      vm = new ReplayVM(prefix, { executionId: childId, workflowId, workflowVersion });
    }
    return { ...vm.getState(), executionId: childId };
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

    const completionPromise = new Promise<ReturnType<typeof vm.getState>>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const suspendPromise = new Promise<ReturnType<typeof vm.getState>>((resolve) => {
      resolveSuspend = resolve;
    });

    // Ephemeral cancellation for this live run. The controller's signal is
    // threaded into every effect context; cancel() aborts it and records a
    // durable EXECUTION_CANCELLED event. Durable state is untouched, so resume
    // semantics are unaffected.
    const controller = new AbortController();
    let cancelled = false;

    const ctx = new WorkflowContextImpl(
      executionId,
      workflowId,
      vm,
      this.eventStore,
      this.effectRuntime,
      this.onEvent,
      controller.signal
    );

    const cancel = (reason?: unknown): void => {
      if (cancelled) return;
      cancelled = true;
      controller.abort(reason);

      const seq = this.eventStore.nextSequence(executionId);
      const cancelledEnvelope: EventEnvelope = {
        id: `${executionId}-${seq}`,
        workflowId,
        executionId,
        eventType: "EXECUTION_CANCELLED",
        sequence: seq,
        timestamp: Date.now(),
        payload: { ...(reason !== undefined && { reason: String(reason) }) },
      };
      this.eventStore.append(cancelledEnvelope);
      vm.applyEvent(cancelledEnvelope);
      this.onEvent?.(cancelledEnvelope);

      rejectCompletion(reason instanceof Error ? reason : new Error("Execution cancelled"));
    };

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

        // If the run was cancelled, cancel() already recorded EXECUTION_CANCELLED
        // and rejected completion. The error bubbling up here is the abort itself
        // (or a downstream effect observing the signal) — don't double-record it
        // as a failure.
        if (cancelled) return;

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
      cancel,
    };
  }
}
