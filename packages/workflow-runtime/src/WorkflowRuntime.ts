import { SuspendError, flowContentHash } from "@loom/core";
import type { EventEnvelope, ExecutionState } from "@loom/core";
import { LazyEffect } from "@loom/effect-runtime";
import type { Effect, EffectRuntime } from "@loom/effect-runtime";
import type { BranchRegistry, EventStore } from "@loom/event-runtime";
// Import the pure sequence helper from the browser-safe subpath, not the barrel:
// the barrel eagerly re-exports the SQLite store (better-sqlite3 / node:fs), which
// would otherwise leak into every browser app that builds on the WorkflowRuntime.
import { sliceBySequence } from "@loom/event-runtime/sequence";
import { ReplayVM } from "@loom/replay-vm";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import { ulid } from "ulid";
import { ExecutionJournal } from "./ExecutionJournal";
import { WorkflowContextImpl } from "./WorkflowContext";
import { FlowCodeMismatchError } from "./types";
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
  /**
   * Take a mid-run snapshot every N committed events, bounding the replay tail so
   * a resume/recovery folds only ~N events instead of the whole log. Omit (or 0)
   * to keep the default cadence (snapshots only at suspend + fork). A larger N
   * means fewer writes but a longer worst-case replay.
   */
  snapshotEvery?: number;
}

export class WorkflowRuntime {
  private readonly eventStore: EventStore;
  private readonly snapshotStore: SnapshotStore;
  private readonly effectRuntime: EffectRuntime;
  private readonly onEvent: ((event: EventEnvelope) => void) | undefined;
  private readonly branchRegistry: BranchRegistry | undefined;
  private readonly onStorageError: ((executionId: string, err: unknown) => void) | undefined;
  private readonly snapshotEvery: number | undefined;
  private readonly flows = new Map<string, RegisteredFlow>();
  // K11.1 — content hash of each registered flow's fold-relevant structure.
  private readonly flowHashes = new Map<string, string>();
  // K8.2 — live executions this runtime instance is currently driving, so
  // cancel() can reach an in-flight run by id. Entries are removed when the run
  // settles (completes / suspends / fails / cancels).
  private readonly liveHandles = new Map<string, ExecutionHandle>();

  constructor(deps: WorkflowRuntimeDeps) {
    this.eventStore = deps.eventStore;
    this.snapshotStore = deps.snapshotStore;
    this.effectRuntime = deps.effectRuntime;
    this.onEvent = deps.onEvent;
    this.branchRegistry = deps.branchRegistry;
    this.onStorageError = deps.onStorageError;
    this.snapshotEvery = deps.snapshotEvery;
  }

  register(toolId: string, effect: Effect): void {
    this.effectRuntime.register(toolId, effect);
  }

  registerFlow<TIn, TOut>(
    definition: RegisteredFlow<TIn, TOut>["definition"],
    runner: FlowRunner<TIn, TOut>
  ): void {
    this.flows.set(definition.id, { definition, runner } as RegisteredFlow);
    // K11.1 — fingerprint the flow's fold-relevant structure once at
    // registration; recorded on EXECUTION_STARTED, compared on resume/recovery.
    this.flowHashes.set(definition.id, flowContentHash(definition));
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

  // K11.1 — refuse to fold a log under flow code it wasn't recorded with. Only
  // executions whose log recorded a `flowHash` are checked (legacy logs resume
  // exactly as before, G2); `allowFlowCodeMismatch` is the explicit operator-ack.
  private checkFlowCode(
    executionId: string,
    workflowId: string,
    state: ExecutionState,
    options: RunOptions | undefined
  ): void {
    if (options?.allowFlowCodeMismatch === true) return;
    const recorded = state.variables._flowHash;
    if (typeof recorded !== "string") return;
    const registered = this.flowHashes.get(workflowId);
    if (registered !== undefined && registered !== recorded) {
      throw new FlowCodeMismatchError(executionId, workflowId, recorded, registered);
    }
  }

  /**
   * K9.4 — acquire the next monotonic fencing token for an execution, when the
   * event store supports fencing. Returns `undefined` on a non-fencing store
   * (e.g. single-node SQLite), so callers can thread it opportunistically:
   * `start(flow, input, { fence: await runtime.acquireFence(id) ?? undefined })`.
   */
  async acquireFence(executionId: string): Promise<number | undefined> {
    if (this.eventStore.acquireFence === undefined) return undefined;
    return this.eventStore.acquireFence(executionId);
  }

  /**
   * K8.2 — cancel an execution BY ID, wherever it stands:
   *
   *  - **live in this runtime** → abort the in-flight effect (signal) and record
   *    the durable `EXECUTION_CANCELLED`, exactly like `handle.cancel()`;
   *  - **not live here** (suspended, or running on a presumed-dead node) →
   *    **fence-then-cancel**: acquire a newer fencing token first (on a fencing
   *    store, K9.4) so a partitioned worker still driving this execution can no
   *    longer write, then append `EXECUTION_CANCELLED` durably. The status folds
   *    to terminal `cancelled`; a later `resume()` refuses.
   *
   * Returns `true` if a cancellation was performed, `false` if the execution was
   * already terminal (completed / failed / cancelled). Throws if the id is
   * unknown. Replay reconstructs the cancellation at the same sequence (G1).
   */
  async cancel(executionId: string, reason?: unknown): Promise<boolean> {
    const live = this.liveHandles.get(executionId);
    if (live !== undefined) {
      live.cancel(reason);
      return true;
    }
    const state = await this.loadState(executionId);
    if (state === null) {
      throw new Error(`No execution found for id: ${executionId}`);
    }
    if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
      return false;
    }
    const fence = await this.acquireFence(executionId);
    const sequence = state.sequence + 1;
    const envelope: EventEnvelope = {
      id: `${executionId}-${sequence}`,
      workflowId: state.workflowId,
      executionId,
      eventType: "EXECUTION_CANCELLED",
      sequence,
      timestamp: Date.now(),
      payload: { ...(reason !== undefined && { reason: String(reason) }) },
      ...(fence !== undefined && { metadata: { fence } }),
    };
    await this.eventStore.append(envelope);
    this.onEvent?.(envelope);
    return true;
  }

  async restoreFromState(
    preloadedState: ExecutionState,
    resumeEvent?: ResumeEvent,
    options?: RunOptions
  ): Promise<ExecutionHandle> {
    const flow = this.flows.get(preloadedState.workflowId);
    if (!flow) {
      throw new Error(`No flow registered for workflowId: "${preloadedState.workflowId}"`);
    }
    // K11.1 — the preloaded state carries the recorded flow-code fingerprint;
    // restoring onto changed code is refused exactly like a resume.
    this.checkFlowCode(
      preloadedState.executionId,
      preloadedState.workflowId,
      preloadedState,
      options
    );
    const vm = new ReplayVM([], preloadedState);
    const originalInput = preloadedState.variables._input;
    return this.execute(
      preloadedState.executionId,
      preloadedState.workflowId,
      vm,
      flow.runner as FlowRunner<unknown, unknown>,
      originalInput,
      resumeEvent ? [{ eventType: resumeEvent.eventType, payload: resumeEvent.payload }] : [],
      options?.fence,
      options?.deadlineMs ?? flow.definition.deadlineMs
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

    // K11.1 — record the flow-code fingerprint this execution starts under
    // (additive payload field; legacy logs without it resume unchecked).
    const flowHash = this.flowHashes.get(definition.id);
    return this.execute(
      executionId,
      definition.id,
      vm,
      runner as FlowRunner<unknown, unknown>,
      input,
      [
        {
          eventType: "EXECUTION_STARTED",
          payload: { input, ...(flowHash !== undefined && { flowHash }) },
        },
      ],
      options?.fence,
      options?.deadlineMs ?? definition.deadlineMs
    );
  }

  async resume(
    executionId: string,
    resumeEvent: ResumeEvent,
    options?: RunOptions
  ): Promise<ExecutionHandle> {
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

    // K8.2 — cancelled is TERMINAL: a cancel-by-id of a suspended/detached
    // execution must not be undone by a later resume.
    if (vm.getState().status === "cancelled") {
      throw new Error(`Execution ${executionId} was cancelled; resume refused (terminal status)`);
    }

    // K11.1 — never silently fold an in-flight log with flow code it wasn't
    // recorded under. Applies only when the log recorded a hash (legacy = G2).
    this.checkFlowCode(executionId, workflowId, vm.getState(), options);

    return this.execute(
      executionId,
      workflowId,
      vm,
      flow.runner as FlowRunner<unknown, unknown>,
      originalInput,
      [
        { eventType: resumeEvent.eventType, payload: resumeEvent.payload },
        { eventType: "EXECUTION_RESUMED", payload: resumeEvent.payload },
      ],
      options?.fence,
      options?.deadlineMs ?? flow.definition.deadlineMs
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
    const forkMeta = { forkedFrom: parentExecutionId, forkSequence: atSequence };
    const restamp = (e: EventEnvelope): EventEnvelope => ({
      ...e,
      executionId: childId,
      id: `${childId}-${e.sequence}`,
      metadata: { ...e.metadata, ...forkMeta },
    });

    if (this.eventStore.copyPrefix) {
      // Fast path: bulk-copy the prefix in the store (no per-event JS re-serialize).
      await this.eventStore.copyPrefix(parentExecutionId, childId, atSequence, forkMeta);
      // Fire live projections from the in-memory prefix we already read.
      if (this.onEvent) {
        for (const e of parentEvents) {
          if (e.sequence > atSequence) break;
          this.onEvent(restamp(e));
        }
      }
    } else {
      for (const e of parentEvents) {
        if (e.sequence > atSequence) break;
        const copy = restamp(e);
        await this.eventStore.append(copy);
        this.onEvent?.(copy);
      }
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
      // parentEvents is sorted by sequence — binary-search the [base+1..at] tail
      // instead of scanning the whole (possibly huge) log.
      const tail = sliceBySequence(parentEvents, base.sequence + 1, atSequence);
      vm = new ReplayVM(tail, base.state);
    } else {
      const prefix = sliceBySequence(parentEvents, 0, atSequence);
      vm = new ReplayVM(prefix, { executionId: childId, workflowId, workflowVersion });
    }
    const state = vm.getState();
    return { ...state, executionId: childId };
  }

  private execute(
    executionId: string,
    workflowId: string,
    vm: ReplayVM,
    runner: FlowRunner<unknown, unknown>,
    input: unknown,
    bootstrapEvents: BootstrapEvent[],
    fence?: number,
    deadlineMs?: number
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
    // Snapshot cadence: every `snapshotEvery` committed events, checkpoint the
    // folded state so a later resume/recovery folds only a bounded tail instead of
    // the whole log (O(K·S) instead of O(N·S)). At most one save is in flight at a
    // time; if the cadence fires while a save is pending it is skipped and caught
    // by the next tick. Fire-and-forget — a failed checkpoint only means a longer
    // replay, so it is reported (onStorageError) but never aborts the run.
    let snapshotInFlight = false;
    const maybeSnapshot = (sequence: number): void => {
      const every = this.snapshotEvery;
      if (!every || sequence <= 0 || sequence % every !== 0 || snapshotInFlight) return;
      // Never checkpoint state whose events failed to persist (e.g. a fenced
      // zombie, K9.4): a snapshot must only ever reference durable events.
      if (journal.failed) return;
      snapshotInFlight = true;
      const state = vm.getState(); // stable: copy-on-write folds never mutate a prior state
      void this.snapshotStore
        .save({ id: ulid(), executionId, workflowId, sequence, state, createdAt: Date.now() })
        .catch((err: unknown) => this.onStorageError?.(executionId, err))
        .finally(() => {
          snapshotInFlight = false;
        });
    };

    const journal = new ExecutionJournal(
      this.eventStore,
      vm,
      this.onEvent,
      (err) => {
        this.onStorageError?.(executionId, err);
        if (!cancelled) controller.abort(err);
      },
      maybeSnapshot,
      fence
    );

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

    // K8.3 — execution deadline, anchored to the LOGGED EXECUTION_STARTED
    // timestamp (already folded from the bootstrap above on a fresh start, or
    // from the original log on resume) — a crash/resume never resets the clock,
    // and resuming past the deadline cancels immediately. Breach is a
    // kernel-driven cancel: durable EXECUTION_CANCELLED, in-flight effect aborted.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (deadlineMs !== undefined) {
      const startedAt = vm.getState().startedAt || Date.now();
      const remaining = deadlineMs - (Date.now() - startedAt);
      const breach = () =>
        cancel(new Error(`execution deadline exceeded (deadlineMs=${deadlineMs})`));
      if (remaining <= 0) breach();
      else deadlineTimer = setTimeout(breach, remaining);
    }

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
          const state = vm.getState();
          const snap: Snapshot = {
            id: ulid(),
            executionId,
            workflowId,
            sequence: state.sequence,
            state,
            createdAt: Date.now(),
          };
          await this.snapshotStore.save(snap);
          resolveSuspend(state);
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

    const handle: ExecutionHandle = {
      executionId,
      waitForCompletion: () => completionPromise,
      waitForSuspend: () => suspendPromise,
      getState: () => vm.getState(),
      cancel,
    };

    // K8.2 — reachable by id while live; released when the run settles (any path).
    this.liveHandles.set(executionId, handle);
    void run().finally(() => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      this.liveHandles.delete(executionId);
    });

    return handle;
  }
}
