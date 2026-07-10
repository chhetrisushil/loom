import { createA2UIEmitter } from "@loom/a2ui";
import type { A2UIEmitter } from "@loom/a2ui";
import { SuspendError } from "@loom/core";
import type { ExecutableTask, StepDefinition } from "@loom/core";
import type { EffectRuntime, PrincipalChain } from "@loom/effect-runtime";
import type { ReplayVM } from "@loom/replay-vm";
import { parallelLimit } from "@loom/scheduler";
import type { ExecutionJournal } from "./ExecutionJournal";
import { EFFECT_INDOUBT_RESOLVED, StepTimeoutError, TIMER_FIRED } from "./types";
import type {
  DecideOptions,
  EffectInDoubtResolution,
  ResourceDimension,
  SuspendConfig,
  WorkflowContext,
} from "./types";

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
    private readonly signal: AbortSignal | undefined = undefined,
    // K12.1 — the execution's authenticated principal chain, threaded opaquely
    // into every effect's authorization. Undefined = no principal.
    private readonly principal: PrincipalChain | undefined = undefined
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

    // K8 — a cancelled execution starts no further steps: bail before the
    // STEP_STARTED is even logged (EXECUTION_CANCELLED owns the outcome).
    this.throwIfCancelled();

    const toolId = task.toolId ?? id;

    // K9.3 — in-doubt guard. A frame left "running" by a previous process run
    // means the prior attempt's effect is in an UNKNOWN state (STEP_STARTED,
    // never a terminal step event). For tools explicitly declared
    // `idempotent: false`, refuse the silent re-run: record EFFECT_INDOUBT and
    // suspend for an operator verdict. Undeclared tools keep the legacy
    // at-least-once re-run byte-identically (G2).
    const priorFrame = this.vm.getState().frames[id];
    if (
      priorFrame?.status === "running" &&
      this.effectRuntime.declaredIdempotence(toolId) === false
    ) {
      const verdict = this.readInDoubtVerdict(id);
      if (verdict === undefined) {
        // Park once per unknown attempt: a re-dispatch of an already-parked
        // execution re-suspends without appending a duplicate audit fact.
        if (this.lastInDoubtFor(id)?.attempts !== priorFrame.attempts) {
          this.emit("EFFECT_INDOUBT", {
            stepId: id,
            toolId,
            attempts: priorFrame.attempts,
            idempotencyKey: this.idempotencyKeyFor(id),
          });
        }
        throw new SuspendError({ on: EFFECT_INDOUBT_RESOLVED, correlationKey: id });
      }
      if (verdict.resolution === "completed-with-result") {
        // The operator confirmed the prior attempt's effect took place: adopt
        // its result durably without re-running the tool.
        this.emit("STEP_COMPLETED", { stepId: id, output: verdict.output });
        return verdict.output as TOut;
      }
      if (verdict.resolution === "fail") {
        const error = String(
          verdict.error ?? `effect in doubt: step "${id}" settled as failed by operator verdict`
        );
        this.emit("STEP_FAILED", { stepId: id, error });
        throw new Error(error);
      }
      // "retry-fresh" — fall through to a normal run. The EFFECT_INDOUBT fact
      // that parked us advanced the durable key epoch, so the provider sees a
      // NEW logical attempt (fresh idempotency key).
    }

    this.emit("STEP_STARTED", { stepId: id, input });

    // K8.3 — declared step deadline (`timeoutMs`), anchored to the step's FIRST
    // logged start so a crash-recovery re-run resumes the countdown rather than
    // resetting it. Enforcement is kernel-side: the step signal aborts (for
    // cooperative effects) AND the await is raced (for effects that ignore it —
    // settlement truth is the durable STEP_FAILED, not physical termination).
    const timeoutMs = task.timeoutMs;
    let stepSignal = this.signal;
    let deadline: { promise: Promise<never>; cleanup: () => void } | undefined;
    if (timeoutMs !== undefined) {
      const frame = this.vm.getState().frames[id];
      const anchor = frame?.firstStartedAt ?? frame?.startedAt ?? Date.now();
      const remaining = timeoutMs - (Date.now() - anchor);
      if (remaining <= 0) {
        const timeoutErr = new StepTimeoutError(id, timeoutMs);
        this.emit("STEP_FAILED", { stepId: id, error: String(timeoutErr) });
        throw timeoutErr;
      }
      const controller = new AbortController();
      const onParentAbort = (): void => controller.abort(this.signal?.reason);
      if (this.signal !== undefined) {
        if (this.signal.aborted) controller.abort(this.signal.reason);
        else this.signal.addEventListener("abort", onParentAbort, { once: true });
      }
      let timer!: ReturnType<typeof setTimeout>;
      const promise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const timeoutErr = new StepTimeoutError(id, timeoutMs);
          controller.abort(timeoutErr);
          reject(timeoutErr);
        }, remaining);
      });
      promise.catch(() => {}); // un-awaited when the effect settles first
      deadline = {
        promise,
        cleanup: () => {
          clearTimeout(timer);
          this.signal?.removeEventListener("abort", onParentAbort);
        },
      };
      stepSignal = controller.signal;
    }

    const effectCtx = {
      executionId: this.executionId,
      stepId: id,
      workflowId: this.workflowId,
      attempt: this.vm.getState().frames[id]?.attempts ?? 1,
      emit: (eventType: string, payload: unknown) => this.emit(eventType, payload),
      ...(stepSignal !== undefined && { signal: stepSignal }),
      // K12.1 — the principal chain flows to the K2 authorizer (carried opaque).
      ...(this.principal !== undefined && { principal: this.principal }),
      // K9.2 — deterministic idempotency key (`executionId:stepId`, plus a
      // durable epoch after an in-doubt "retry-fresh") so tool authors can
      // deduplicate at the provider: crash-recovery re-runs of the same logical
      // attempt carry the SAME key.
      idempotencyKey: this.idempotencyKeyFor(id),
      // K3 — running resource totals (from the durable fold) so accounting/quota
      // middleware can meter and enforce budgets deterministically.
      resources: (this.vm.getState().variables._resources as
        | { tokens: number; costUsd: number; ms: number; count: number; exceeded?: boolean }
        | undefined) ?? { tokens: 0, costUsd: 0, ms: 0, count: 0 },
    };

    let output: TOut;
    try {
      const effectPromise = this.effectRuntime.execute<TIn, TOut>(toolId, input, effectCtx);
      if (deadline !== undefined) {
        effectPromise.catch(() => {}); // a late rejection after the deadline won is settled
        output = await Promise.race([effectPromise, deadline.promise]);
      } else {
        output = await effectPromise;
      }
    } catch (err) {
      if (err instanceof SuspendError) {
        throw err;
      }
      // A cancelled execution surfaces here as an effect rejection. Record it as
      // a cancelled step (not a failure) so the event log and replayed state stay
      // truthful; EXECUTION_CANCELLED owns the execution-level status. (A step
      // timeout is NOT a cancellation — this.signal stays quiet — so it falls to
      // the ordinary STEP_FAILED below.)
      if (this.signal?.aborted === true) {
        this.emit("STEP_CANCELLED", { stepId: id });
        throw err;
      }
      this.emit("STEP_FAILED", { stepId: id, error: String(err) });
      throw err;
    } finally {
      deadline?.cleanup();
    }

    this.emit("STEP_COMPLETED", { stepId: id, output });
    return output;
  }

  run<TIn = unknown, TOut = unknown>(step: StepDefinition<TIn, TOut>, input: TIn): Promise<TOut> {
    return this.execute<TIn, TOut>(step, input);
  }

  // Loom 2.0 (P9) — the Decision seam. Twin of `execute`'s replay short-circuit:
  // a recorded decision is served from the log; otherwise the decider runs once and
  // its choice is committed as DECISION_RECORDED. Optimizers therefore change
  // outcomes across runs, but a given run always replays the same choice.
  async decide<T = unknown>(
    decisionId: string,
    decider: () => T | Promise<T>,
    opts?: DecideOptions
  ): Promise<T> {
    if (this.vm.hasDecision(decisionId)) {
      return this.vm.getDecision(decisionId) as T;
    }

    const choice = await decider();

    this.emit("DECISION_RECORDED", {
      decisionId,
      choice,
      ...(opts?.rationale !== undefined && { rationale: opts.rationale }),
      ...(opts?.source !== undefined && { source: opts.source }),
      ...(opts?.alternatives !== undefined && { alternatives: opts.alternatives }),
      ...(opts?.estimatedCostUsd !== undefined && { estimatedCostUsd: opts.estimatedCostUsd }),
      ...(opts?.estimatedLatencyMs !== undefined && {
        estimatedLatencyMs: opts.estimatedLatencyMs,
      }),
      ...(opts?.confidence !== undefined && { confidence: opts.confidence }),
    });

    return choice;
  }

  // ADR 0032 (R2) — bounded, logged budget negotiation. The grant is resolved through
  // the decision seam, so it is recorded once and served identically on replay (P9). It
  // is advisory: it hands the flow a durable number, but never enforces (metering owns
  // QUOTA_EXCEEDED). `grant = min(request, ceiling − spent)` when a ceiling is given.
  negotiateBudget(
    dimension: ResourceDimension,
    request: number,
    opts?: { id?: string; ceiling?: number; rationale?: unknown }
  ): Promise<number> {
    const id = opts?.id ?? `negotiate:${dimension}`;
    return this.decide<number>(
      id,
      () => {
        const spent = this.currentResource(dimension);
        const remaining = opts?.ceiling !== undefined ? Math.max(0, opts.ceiling - spent) : request;
        return Math.min(request, remaining);
      },
      {
        source: "negotiate",
        ...(opts?.rationale !== undefined && { rationale: opts.rationale }),
      }
    );
  }

  /** Current spend for a dimension, read from the deterministic `_resources` fold (0 if unset). */
  private currentResource(dimension: ResourceDimension): number {
    const r = this.vm.getState().variables._resources as Record<string, number> | undefined;
    return r?.[dimension] ?? 0;
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

  // T1 — durable sleep. The absolute wake time is computed ONCE on the live
  // call and recorded in the EXECUTION_SUSPENDED condition (P9 — wall clock
  // enters the log exactly once); on resume replay the suspend passthrough
  // returns before this recomputes anything, so the fold never sees drift.
  async sleep(ms: number): Promise<void> {
    await this.sleepUntil(Date.now() + ms);
  }

  async sleepUntil(wakeAt: number): Promise<void> {
    await this.suspend({ on: TIMER_FIRED, wakeAt });
  }

  // K8 — abort fast when the owning execution has been cancelled. Scoped to a
  // helper so the signal narrowing doesn't leak into callers (the signal flips
  // asynchronously; call sites must re-check it each time).
  private throwIfCancelled(): void {
    const signal = this.signal;
    if (signal !== undefined && signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("execution cancelled");
    }
  }

  // ── K9 helpers ──────────────────────────────────────────────────────────────

  /**
   * The deterministic idempotency key for a step: `executionId:stepId`, suffixed
   * with `:rN` once N EFFECT_INDOUBT facts exist for the step (each "retry-fresh"
   * verdict is a durable new-logical-attempt boundary). Derived purely from the
   * fold, so recovery replays of the same logical attempt compute the same key.
   */
  private idempotencyKeyFor(stepId: string): string {
    const indoubt = this.vm.getState().variables._indoubt as Array<{ stepId?: string }> | undefined;
    if (indoubt === undefined) {
      return `${this.executionId}:${stepId}`;
    }
    let epoch = 0;
    for (const entry of indoubt) {
      if (entry.stepId === stepId) epoch++;
    }
    return epoch === 0
      ? `${this.executionId}:${stepId}`
      : `${this.executionId}:${stepId}:r${epoch}`;
  }

  /** The most recent EFFECT_INDOUBT audit entry for a step, if any. */
  private lastInDoubtFor(stepId: string): { stepId?: string; attempts?: number } | undefined {
    const indoubt = this.vm.getState().variables._indoubt as
      | Array<{ stepId?: string; attempts?: number }>
      | undefined;
    if (indoubt === undefined) return undefined;
    for (let i = indoubt.length - 1; i >= 0; i--) {
      if (indoubt[i]?.stepId === stepId) return indoubt[i];
    }
    return undefined;
  }

  /**
   * An in-doubt verdict is a resume payload that names THIS step and carries a
   * valid resolution. Matching on shape (not mere payload presence) keeps
   * ordinary resumes — approvals, EXECUTION_RECOVERED's empty payload — from
   * being mistaken for verdicts; a parked execution resumed without a matching
   * verdict simply re-parks. Verdicts are durable (the resume event is in the
   * log), so replay re-applies them deterministically.
   */
  private readInDoubtVerdict(stepId: string): EffectInDoubtResolution | undefined {
    const vars = this.vm.getState().variables;
    if (!("_resumePayload" in vars)) return undefined;
    const p = vars._resumePayload as Partial<EffectInDoubtResolution> | null;
    if (p === null || typeof p !== "object" || p.stepId !== stepId) return undefined;
    if (
      p.resolution !== "completed-with-result" &&
      p.resolution !== "retry-fresh" &&
      p.resolution !== "fail"
    ) {
      return undefined;
    }
    return p as EffectInDoubtResolution;
  }
}
