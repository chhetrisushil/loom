import { createSurfaceEmitter } from "@loom/agent-surface";
import type { SurfaceEmitter } from "@loom/agent-surface";
import { SuspendError, TypedFailure } from "@loom/core";
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

// Audit MEM-HIGH (DE-4 follow-up) — typed-failure payloads land inline in the
// log and the folded frame with no claim-check path (middleware inspects only
// RETURNED results, never thrown errors). Cap them at the same 16 KiB the
// claim-check default uses; a domain outcome bigger than this should carry a
// content ref, not the bytes. Measured as JSON string length (chars ≈ bytes
// for the payloads this governs; exactness is not load-bearing).
const TYPED_FAILURE_PAYLOAD_CAP = 16 * 1024;

/** JSON length of a value, or MAX_SAFE_INTEGER when it cannot be encoded (over any cap). */
function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export class WorkflowContextImpl implements WorkflowContext {
  readonly executionId: string;
  readonly workflowId: string;
  readonly ui: SurfaceEmitter;
  private suspendPassthroughsConsumed = 0;
  // ADR 0102 — flow-level emits issued by THIS run (the next ordinal), and how many
  // effects/deciders of this context are running right now (emits made inside one
  // take the effect path; see `emit`).
  private flowEmitsIssued = 0;
  private liveOnlyDepth = 0;

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
    // agent-surface patches flow through the normal event pipeline, so UI updates are
    // durable and replay deterministically alongside every other event.
    this.ui = createSurfaceEmitter((eventType, payload) => this.emit(eventType, payload));
    // `decide` is the one context method routinely passed AS A VALUE rather than
    // called: `TieredMemory.recall({ decide })`, `recallRelevant({ decide })`,
    // any decider-taking helper. Unbound, `decide: ctx.decide` loses its receiver
    // and fails at the first `this.vm` — a TypeError with no mention of binding,
    // from a line that reads exactly like the documentation. Bound here so the
    // documented spelling is the working one; every existing `ctx.decide(…)` call
    // site is unaffected.
    this.decide = this.decide.bind(this);
  }

  /**
   * The `emit` syscall — and so `stream` and `ui`, which are emits — appends ONCE per
   * execution (ADR 0102). A flow re-runs from the top on resume and on recovery (ADR
   * 0057), and `execute`/`decide`/`suspend` are served from the fold on that re-run;
   * this is the same for emits. The i-th flow-level emit of a run is matched
   * ORDINALLY against the log (the rule `suspend` already uses for gates): it is
   * stamped `metadata.flowEmit = i`, the fold keeps `_flowEmits` = the high-water mark,
   * and a re-run serves emit i from the log when `i < _flowEmits`.
   *
   * An emit made while an effect or a decider of this context is running takes the
   * EFFECT path instead (appended, never stamped, never counted): it belongs to that
   * step/decision and happens only when it runs — a closure over `ctx` inside an
   * effect's `onDelta` is the documented case. Counting it would shift every later
   * ordinal down on a re-run where the step is served, silently dropping a LIVE emit.
   *
   * A legacy (unstamped) log counts nothing, so it re-emits its prefix once more,
   * stamped, and is stable from then on.
   */
  emit(eventType: string, payload: unknown): void {
    if (this.liveOnlyDepth > 0) {
      this.commit(eventType, payload);
      return;
    }
    const ordinal = this.flowEmitsIssued++;
    // Served from the log: an earlier run of this execution already appended flow-level
    // emit #ordinal before it suspended or crashed.
    if (ordinal < ((this.vm.getState().variables._flowEmits as number | undefined) ?? 0)) return;
    this.journal.commit(eventType, payload, { metadata: { flowEmit: ordinal } });
  }

  // Synchronous: the journal allocates a sequence, folds the VM, fires onEvent,
  // and enqueues the durable write. The async persistence is drained at barriers.
  // The kernel's own facts (STEP_*, DECISION_RECORDED, EFFECT_INDOUBT) and
  // `EffectContext.emit` come through here, never through the flow-level `emit`:
  // their callers are already served from the fold on a re-run, and they must not
  // consume a flow-emit ordinal (ADR 0102).
  private commit(eventType: string, payload: unknown): void {
    this.journal.commit(eventType, payload);
  }

  // Loom 2.0 — the generalized durable primitive. `run` is now a thin alias that
  // forwards a StepDefinition (the 'step' task kind) here. All task kinds resolve
  // through the EffectRuntime by toolId, and the wire events stay STEP_* so
  // existing logs replay byte-identically.
  //
  // STEP IDENTITY (ADR 0061): frames are keyed by `task.id` — the completed
  // short-circuit and the typed-failure substitution below both serve the FIRST
  // recorded outcome for an id. The sequence of ids an execution produces must
  // be a pure function of logged inputs; a task invoked more than once with
  // different intent must mint a deterministic distinct id (`${id}#${index}`).
  async execute<TIn = unknown, TOut = unknown>(
    task: ExecutableTask<TIn, TOut>,
    input: TIn
  ): Promise<TOut> {
    const id = task.id;
    if (this.vm.hasCompleted(id)) {
      return this.vm.getOutput(id) as TOut;
    }

    // DE-4 (ADR 0060) — typed-failure substitution, the failure twin of the
    // completed short-circuit above: a recorded declared-channel failure is
    // rethrown WITHOUT re-invoking the effect (zero events, zero middleware), so
    // the flow deterministically re-takes the same catch branch on replay. This
    // applies to LIVE re-invocation of the same id too — a deliberate retry must
    // mint a new id (`${id}#retry:N`), per the step-identity rule (ADR 0061).
    // Untyped failures leave no errorChannel and keep legacy re-execution.
    const typed = this.vm.getTypedFailure(id);
    if (typed !== undefined) {
      throw new TypedFailure(
        typed.channel,
        typed.payload,
        typeof typed.error === "string" ? typed.error : undefined
      );
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
          this.commit("EFFECT_INDOUBT", {
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
        this.commit("STEP_COMPLETED", { stepId: id, output: verdict.output });
        return verdict.output as TOut;
      }
      if (verdict.resolution === "fail") {
        const error = String(
          verdict.error ?? `effect in doubt: step "${id}" settled as failed by operator verdict`
        );
        this.commit("STEP_FAILED", { stepId: id, error });
        throw new Error(error);
      }
      // "retry-fresh" — fall through to a normal run. The EFFECT_INDOUBT fact
      // that parked us advanced the durable key epoch, so the provider sees a
      // NEW logical attempt (fresh idempotency key).
    }

    this.commit("STEP_STARTED", { stepId: id, input });

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
        this.commit("STEP_FAILED", { stepId: id, error: String(timeoutErr) });
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
      emit: (eventType: string, payload: unknown) => this.commit(eventType, payload),
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
    // ADR 0102 — while this effect runs, a flow-level emit made from inside it (a
    // closure over `ctx`) belongs to the step and takes the effect path.
    this.liveOnlyDepth++;
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
        this.commit("STEP_CANCELLED", { stepId: id });
        throw err;
      }
      // DE-4 — a TypedFailure on a DECLARED channel is a domain outcome: record
      // it with its schema-validated payload so replay substitutes it (frame
      // gains errorChannel). Declaration resolution: step `errors:` wins, the
      // registered effect's map is the fallback (the K9.3 idiom). A payload that
      // fails its channel's schema, exceeds the inline cap, or rides an
      // undeclared channel degrades LOUDLY to the legacy untyped failure, which
      // keeps at-least-once re-execution.
      if (err instanceof TypedFailure) {
        const schema = (task.errors ?? this.effectRuntime.declaredErrors(toolId))?.[err.channel];
        if (schema !== undefined) {
          const parsed = schema.safeParse(err.payload);
          if (parsed.success) {
            // Audit MEM-HIGH (ADR 0054 economics) — a typed-failure payload is
            // recorded inline in the immutable log AND retained in the folded
            // frame; claim-check middleware never sees thrown errors, so this
            // seam must enforce the inline cap itself. Over-cap degrades to the
            // untyped path: no channel/payload recorded, legacy semantics.
            const payloadSize = safeJsonLength(parsed.data);
            if (payloadSize <= TYPED_FAILURE_PAYLOAD_CAP) {
              this.commit("STEP_FAILED", {
                stepId: id,
                error: String(err),
                channel: err.channel,
                payload: parsed.data,
              });
              throw err;
            }
            this.commit("STEP_FAILED", {
              stepId: id,
              error: `typed-failure payload for channel "${err.channel}" exceeds the inline cap (${payloadSize} > ${TYPED_FAILURE_PAYLOAD_CAP} JSON chars) — degraded to untyped; carry a content ref in the payload instead (ADR 0054/0060)`,
            });
            throw err;
          }
          this.commit("STEP_FAILED", {
            stepId: id,
            error: `typed-failure payload for channel "${err.channel}" failed validation: ${parsed.error.message}`,
          });
          throw err;
        }
      }
      this.commit("STEP_FAILED", { stepId: id, error: String(err) });
      throw err;
    } finally {
      this.liveOnlyDepth--;
      deadline?.cleanup();
    }

    this.commit("STEP_COMPLETED", { stepId: id, output });
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

    // ADR 0102 — a decider runs only when the decision is made (served on a re-run),
    // so an emit inside it belongs to the decision and takes the effect path.
    this.liveOnlyDepth++;
    let choice: T;
    try {
      choice = await decider();
    } finally {
      this.liveOnlyDepth--;
    }

    this.commit("DECISION_RECORDED", {
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
      // ADR 0079 — the learning half of the D1 metadata: what the policy SAW and
      // which policy it was. Descriptive only; `getDecision` still returns `choice`.
      ...(opts?.context !== undefined && { context: opts.context }),
      ...(opts?.policy !== undefined && { policy: opts.policy }),
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

  suspend<T = never>(_config: SuspendConfig): Promise<T> {
    // During resume replay, gates that were already resumed pass through IN
    // ORDER, each receiving ITS OWN recorded payload — the fold's ordered
    // `_resumePayloads` list (1.16.0, ADR 0057). The i-th suspend call in a
    // re-run consumes payload i; a gate beyond the recorded resumes throws and
    // parks as before. (The single-latest `_resumePayload` fed gate 1 the LAST
    // gate's payload in multi-gate flows — the silent bug the list fixes.)
    // Legacy fallback: a pre-1.16 snapshot folded only `_resumePayload`; treat
    // it as a one-entry list so single-gate flows resume byte-identically.
    const variables = this.vm.getState().variables;
    const recorded =
      (variables._resumePayloads as unknown[] | undefined) ??
      ("_resumePayload" in variables ? [variables._resumePayload] : []);
    if (this.suspendPassthroughsConsumed < recorded.length) {
      const payload = recorded[this.suspendPassthroughsConsumed];
      this.suspendPassthroughsConsumed++;
      return Promise.resolve(payload) as Promise<T>;
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
    if (signal?.aborted) {
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
