import { SuspendError } from "@loom/core";
import type { EventEnvelope, ExecutionState } from "@loom/core";
import { LazyEffect } from "@loom/effect-runtime";
import type { Effect, EffectRuntime } from "@loom/effect-runtime";
import type { BranchRegistry, EventStore } from "@loom/event-runtime";
import { ReplayVM } from "@loom/replay-vm";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import { ulid } from "ulid";
import { ExecutionJournal } from "./ExecutionJournal";
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

/** An event to commit through the journal before the flow runner starts. */
interface BootstrapEvent {
  eventType: string;
  payload: unknown;
}

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
  /**
   * Optional observability hook fired when a durable event write rejects (a new
   * failure mode of the async storage layer). The run is aborted and
   * waitForCompletion/waitForSuspend reject with a StorageWriteError regardless;
   * this is purely for logging/metrics.
   */
  onStorageError?: (executionId: string, err: unknown) => void;
}

export class WorkflowRuntime {
  private readonly eventStore: EventStore;
  private readonly snapshotStore: SnapshotStore;
  private readonly effectRuntime: EffectRuntime;
  private readonly onEvent: ((event: EventEnvelope) => void) | undefined;
  private readonly branchRegistry: BranchRegistry | undefined;
  private readonly onStorageError: ((executionId: string, err: unknown) => void) | undefined;
  private readonly flows = new Map<string, RegisteredFlow>();

  constructor(deps: WorkflowRuntimeDeps) {
    this.eventStore = deps.eventStore;
    this.snapshotStore = deps.snapshotStore;
    this.effectRuntime = deps.effectRuntime;
    this.onEvent = deps.onEvent;
    this.branchRegistry = deps.branchRegistry;
    this.onStorageError = deps.onStorageError;
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

  /**
   * Resolve a registered flow by its definition id. This is the "code by id"
   * lookup a worker uses to run an {@link ExecutionPackage} whose `flowId`
   * references a flow the worker was booted with — `start()` needs the concrete
   * RegisteredFlow, while `resume()` already resolves it internally.
   */
  getFlow(flowId: string): RegisteredFlow | undefined {
    return this.flows.get(flowId);
  }

  /** All registered flow ids — used by tooling (e.g. boot-time flow-graph validation). */
  getFlowIds(): string[] {
    return [...this.flows.keys()];
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
    const originalInput = preloadedState.variables._input;
    return this.execute(
      preloadedState.executionId,
      preloadedState.workflowId,
      vm,
      flow.runner as FlowRunner<unknown, unknown>,
      originalInput,
      resumeEvent ? [{ eventType: resumeEvent.eventType, payload: resumeEvent.payload }] : []
    );
  }

  async start<TIn = unknown, TOut = unknown>(
    flow: RegisteredFlow<TIn, TOut>,
    input: TIn,
    options?: RunOptions
  ): Promise<ExecutionHandle> {
    const executionId = options?.executionId ?? ulid();
    const { definition, runner } = flow;

    // Empty VM seeded with identity only; the EXECUTION_STARTED bootstrap event
    // (committed in execute) is what folds status → "running" at sequence 0.
    const vm = new ReplayVM([], {
      executionId,
      workflowId: definition.id,
      workflowVersion: definition.version,
    });

    return this.execute(
      executionId,
      definition.id,
      vm,
      runner as FlowRunner<unknown, unknown>,
      input,
      [{ eventType: "EXECUTION_STARTED", payload: { input } }]
    );
  }

  async resume(executionId: string, resumeEvent: ResumeEvent): Promise<ExecutionHandle> {
    const allEvents = await this.eventStore.read(executionId);
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

    const snapshot = await this.snapshotStore.loadLatest(executionId);
    let vm: ReplayVM;

    if (snapshot) {
      const eventsAfterSnapshot = await this.eventStore.readFrom(
        executionId,
        snapshot.sequence + 1
      );
      vm = new ReplayVM(eventsAfterSnapshot, snapshot.state);
    } else {
      vm = new ReplayVM(allEvents, {
        executionId,
        workflowId: flow.definition.id,
        workflowVersion: flow.definition.version,
      });
    }

    return this.execute(
      executionId,
      workflowId,
      vm,
      flow.runner as FlowRunner<unknown, unknown>,
      originalInput,
      [
        { eventType: resumeEvent.eventType, payload: resumeEvent.payload },
        { eventType: "EXECUTION_RESUMED", payload: resumeEvent.payload },
      ]
    );
  }

  /**
   * Fold the current durable state of an execution WITHOUT running it. Returns
   * `null` if no events exist for the id. Used by workers to make redispatch
   * idempotent: on a recovery dispatch they inspect the persisted status and
   * decide whether to resume (crashed mid-flight → "running") or return the
   * state as-is (already "completed"/"failed"/"suspended") — no re-run, no
   * duplicate effects, no restart.
   */
  async loadState(executionId: string): Promise<ExecutionState | null> {
    const allEvents = await this.eventStore.read(executionId);
    if (allEvents.length === 0) {
      return null;
    }
    const snapshot = await this.snapshotStore.loadLatest(executionId);
    if (snapshot) {
      const tail = await this.eventStore.readFrom(executionId, snapshot.sequence + 1);
      return new ReplayVM(tail, snapshot.state).getState();
    }
    const workflowId = allEvents[0]!.workflowId;
    const flow = this.flows.get(workflowId);
    return new ReplayVM(allEvents, {
      executionId,
      workflowId,
      workflowVersion: flow?.definition.version ?? "",
    }).getState();
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
    const parentEvents = await this.eventStore.read(parentExecutionId);
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
    const forkState = await this.materializeStateAt(
      parentExecutionId,
      atSequence,
      parentEvents,
      childId,
      workflowId,
      workflowVersion
    );

    // 2. Copy the prefix [0..atSequence] into the child log. Re-stamp id +
    //    executionId, record provenance in metadata. This BYPASSES the journal —
    //    the envelopes are verbatim, pre-sequenced copies, so they must not be
    //    re-sequenced. No synthetic EXECUTION_FORKED event either — inserting one
    //    would perturb sequence numbering and break the prefix-identity guarantee.
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
      await this.eventStore.append(copy);
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
    await this.snapshotStore.save(seed);

    // 4. Record lineage + optional movable ref.
    const branchName = opts?.branchName ?? childId;
    if (this.branchRegistry) {
      await this.branchRegistry.recordLineage({
        executionId: childId,
        parentExecutionId,
        forkSequence: atSequence,
      });
      if (opts?.branchName !== undefined) {
        const now = Date.now();
        await this.branchRegistry.putRef({
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
  private async materializeStateAt(
    parentExecutionId: string,
    atSequence: number,
    parentEvents: EventEnvelope[],
    childId: string,
    workflowId: string,
    workflowVersion: string
  ): Promise<ExecutionState> {
    const base = await this.snapshotStore.loadLatestBefore(parentExecutionId, atSequence);
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
    vm: ReplayVM,
    runner: FlowRunner<unknown, unknown>,
    input: unknown,
    bootstrapEvents: BootstrapEvent[]
  ): ExecutionHandle {
    let resolveCompletion!: (state: ReturnType<typeof vm.getState>) => void;
    let rejectCompletion!: (err: unknown) => void;
    let resolveSuspend!: (state: ReturnType<typeof vm.getState>) => void;
    let rejectSuspend!: (err: unknown) => void;

    const completionPromise = new Promise<ReturnType<typeof vm.getState>>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const suspendPromise = new Promise<ReturnType<typeof vm.getState>>((resolve, reject) => {
      resolveSuspend = resolve;
      rejectSuspend = reject;
    });

    // A run has two terminal promises (suspend, completion) but a caller typically
    // awaits only one. Attach no-op guards so rejecting the un-awaited one (e.g. a
    // storage failure at the suspend barrier rejects both) is not reported as an
    // unhandled rejection — real awaiters still receive the error.
    completionPromise.catch(() => {});
    suspendPromise.catch(() => {});

    // Ephemeral cancellation for this live run. The controller's signal is
    // threaded into every effect context; cancel() aborts it and records a
    // durable EXECUTION_CANCELLED event. Durable state is untouched, so resume
    // semantics are unaffected.
    const controller = new AbortController();
    let cancelled = false;

    // The per-execution write pipeline: sole sequence allocator + the only thing
    // that calls eventStore.append. A durable-write rejection aborts the run and
    // is surfaced at the next drain barrier as a StorageWriteError.
    const journal = new ExecutionJournal(this.eventStore, vm, this.onEvent, (err) => {
      this.onStorageError?.(executionId, err);
      if (!cancelled) controller.abort(err);
    });

    // Commit bootstrap events (EXECUTION_STARTED / resume+RESUMED / restore) so
    // they flow through the same sequencer + writer as everything else.
    for (const b of bootstrapEvents) {
      journal.commit(b.eventType, b.payload);
    }

    const ctx = new WorkflowContextImpl(
      executionId,
      workflowId,
      vm,
      journal,
      this.effectRuntime,
      controller.signal
    );

    const cancel = (reason?: unknown): void => {
      if (cancelled) return;
      cancelled = true;
      controller.abort(reason);
      // Synchronous: enqueue the durable CANCELLED write (drained by run()'s
      // cancelled branch) and reject the caller immediately.
      journal.commit("EXECUTION_CANCELLED", {
        ...(reason !== undefined && { reason: String(reason) }),
      });
      rejectCompletion(reason instanceof Error ? reason : new Error("Execution cancelled"));
    };

    const run = async () => {
      try {
        const output = await runner(ctx, input);

        journal.commit("EXECUTION_COMPLETED", { output });
        await journal.drain(); // durability barrier
        resolveCompletion(vm.getState());
      } catch (err) {
        if (err instanceof SuspendError) {
          journal.commit("EXECUTION_SUSPENDED", { condition: err.condition });
          // MUST drain before snapshotting: a snapshot must never reference
          // events that are not yet durably in the log.
          try {
            await journal.drain();
          } catch (drainErr) {
            rejectSuspend(drainErr);
            rejectCompletion(drainErr);
            return;
          }
          const snap: Snapshot = {
            id: ulid(),
            executionId,
            workflowId,
            sequence: vm.getState().sequence,
            state: vm.getState(),
            createdAt: Date.now(),
          };
          await this.snapshotStore.save(snap);
          resolveSuspend(vm.getState());
          return;
        }

        // Cancelled: cancel() already committed EXECUTION_CANCELLED and rejected
        // completion. Drain to make that write durable, then stop.
        if (cancelled) {
          await journal.drain().catch(() => {}); // write error already surfaced via onStorageError
          return;
        }

        // Storage died mid-run (a durable write rejected → the run aborted).
        // Surface the write failure; do NOT fabricate an EXECUTION_FAILED event
        // into a log that the store can't accept anyway.
        if (journal.failed) {
          await journal.drain().catch((drainErr) => rejectCompletion(drainErr));
          return;
        }

        journal.commit("EXECUTION_FAILED", { error: String(err) });
        await journal.drain().catch(() => {}); // best-effort persist; prefer the original error
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
