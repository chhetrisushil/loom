import { createSurfaceEmitter } from "@loom/agent-surface";
import type { SurfaceEmitter } from "@loom/agent-surface";
import { SuspendError, TypedFailure, fnv1a64 } from "@loom/core";
import type { ExecutableTask, StepDefinition } from "@loom/core";
import type { EffectRuntime, PrincipalChain } from "@loom/effect-runtime";
import type { ReplayVM } from "@loom/replay-vm";
import { parallelLimit } from "@loom/scheduler";
import type { ExecutionJournal } from "./ExecutionJournal";
import { asInDoubtVerdict, inDoubtDecisionId } from "./inDoubt";
import { discardDecisionId } from "./strayPassthroughs";
import { EFFECT_INDOUBT_RESOLVED, StepTimeoutError, TIMER_FIRED } from "./types";
import type {
  DecideOptions,
  EffectInDoubtResolution,
  ResourceDimension,
  SuspendConfig,
  WorkflowContext,
} from "./types";
import { assertFlowDecisionId, guardUserspaceEmit } from "./userspaceEmit";

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

// ── ADR 0102 — the content digest a flow-level emit is matched by ──────────────
//
// Canonical JSON of `[eventType, payload]` as it would be PERSISTED (JSON.stringify
// semantics: `toJSON` applied, function/symbol/undefined members dropped, `undefined`
// array slots → null), with object keys sorted, prefixed by the emit's gate SEGMENT
// (how many resume passthroughs the run had consumed), hashed with FNV-1a-64. A `Map` or
// `Set` has no enumerable keys and canonicalises to `{}` — harmless, because that is also
// how it persists. `undefined` when the payload has no JSON form (a BigInt, a cycle,
// pathological depth): such an emit is never matched and never stamped — it is appended
// every time (duplicate beats loss).
const DIGEST_MAX_DEPTH = 256;

function canonicalPersisted(raw: unknown, depth: number): string | undefined {
  let value = raw;
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { toJSON?: unknown }).toJSON === "function"
  ) {
    value = (value as { toJSON: () => unknown }).toJSON();
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "undefined":
    case "function":
    case "symbol":
      return undefined; // omitted as a member, null in an array (callers handle)
    case "bigint":
      throw new TypeError("no JSON form");
    default: {
      if (depth >= DIGEST_MAX_DEPTH) throw new TypeError("too deep");
      if (Array.isArray(value)) {
        const parts = value.map((v) => canonicalPersisted(v, depth + 1) ?? "null");
        return `[${parts.join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const k of Object.keys(record).sort()) {
        const v = canonicalPersisted(record[k], depth + 1);
        if (v !== undefined) parts.push(`${JSON.stringify(k)}:${v}`);
      }
      return `{${parts.join(",")}}`;
    }
  }
}

/** Exported for tests only. `segment` = resume passthroughs consumed at the emit. */
export function flowEmitDigest(
  eventType: string,
  payload: unknown,
  segment = 0
): string | undefined {
  try {
    return fnv1a64(
      `${segment}|[${JSON.stringify(eventType)},${canonicalPersisted(payload, 1) ?? "null"}]`
    );
  } catch {
    return undefined; // no JSON form (BigInt, cycle past the depth cap)
  }
}

export class WorkflowContextImpl implements WorkflowContext {
  readonly executionId: string;
  readonly workflowId: string;
  readonly ui: SurfaceEmitter;
  private suspendPassthroughsConsumed = 0;
  // ADR 0102 — how many flow-level emits of each content digest THIS run has made
  // (served or appended), and how many of this context's effects/deciders are running
  // right now (an emit appended meanwhile is left unstamped; see `emit`).
  private readonly flowEmitsSeen = new Map<string, number>();
  private inFlight = 0;
  // ADR 0102 D4 — `segmentLive`: some syscall of THIS segment was executed live in this
  // run (a step not served from the log, a decider actually invoked), so nothing later in
  // the segment can be proven a replay; reset at the next gate passthrough.
  // `unsettled`: some step/decider of THIS run ended in an outcome a re-run does not
  // serve (an untyped failure, a timeout, a cancellation, an in-doubt park, a throwing
  // decider), so a later re-run may take a different path; every emit appended after it,
  // in any segment, is left unstamped. Sticky for the run.
  private segmentLive = false;
  // ADR 0104 — a userspace DECISION_RECORDED may not change a decision already recorded.
  // A choice with no JSON form (a BigInt, a cycle) has no digest and cannot be proven equal, so
  // it counts as a conflict: unprovable means refused, never "equal".
  private readonly decisionConflict = (decisionId: string, choice: unknown): boolean => {
    if (!this.vm.hasDecision(decisionId)) return false;
    const recorded = flowEmitDigest("choice", this.vm.getDecision(decisionId));
    const offered = flowEmitDigest("choice", choice);
    return recorded === undefined || offered === undefined || recorded !== offered;
  };
  private unsettled = false;

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
   * so are the emits the log PROVES were already made.
   *
   * Identity: a digest of `(segment, eventType, payload)`, where the segment is the
   * number of gate passthroughs this run had consumed. The n-th emit of digest d is
   * SERVED (nothing appended) iff
   *   (1) the log holds more than n STAMPED emits of d, and
   *   (2) no syscall of this segment has been executed live in this run (every step
   *       and decision so far in the segment was served from the log).
   * Otherwise it is appended. An appended emit is STAMPED (so it can serve a later
   * re-run) only if it goes beyond the logged count, no effect or decider of this
   * context is in flight (it could come from inside one, and would not recur when that
   * step is served), and nothing earlier in this run ended unsettled (so the path that
   * led to it is one a re-run reproduces from logged facts).
   *
   * Consequence: a stamp exists only for an emit whose path a re-run reproduces, so a
   * stamp can serve only its own re-emission. What cannot be proven is appended — a
   * duplicate, never a loss (the residual conditions are in ADR 0102 D2).
   */
  emit(eventType: string, rawPayload: unknown): void {
    const payload = guardUserspaceEmit(eventType, rawPayload, {
      kind: "flow",
      conflicts: this.decisionConflict,
    }); // ADR 0104
    const digest = flowEmitDigest(eventType, payload, this.suspendPassthroughsConsumed);
    if (digest === undefined) {
      this.commit(eventType, payload); // cannot be matched: always append (never stamped)
      return;
    }
    const seen = this.flowEmitsSeen.get(digest) ?? 0;
    this.flowEmitsSeen.set(digest, seen + 1);
    const logged = this.vm.flowEmitCount(digest);
    if (seen < logged && !this.segmentLive) return; // proven: a replay of a logged emit
    if (seen < logged || this.inFlight > 0 || this.unsettled) {
      this.commit(eventType, payload); // appended, unstamped: serves nothing later
      return;
    }
    this.journal.commit(eventType, payload, { metadata: { flowEmit: digest } });
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
    // ADR 0104 — a `kind: "human"` step (HumanEffect) is a SUSPEND POINT: its effect parks the
    // execution and the resume that answers it is a `_resumePayloads` entry. It consumes that
    // entry in order with every `ctx.suspend`, live AND on replay past the completed step —
    // otherwise the entry was served to the flow's next gate as its approval.
    const isHuman = this.effectRuntime.kindOf(task.toolId ?? id) === "human";
    if (this.vm.hasCompleted(id)) {
      if (isHuman) {
        // It took its answer — after any entries the operator discarded for it — so a
        // replay past it takes the same number (ADR 0104).
        for (let k = this.discardedFor(id); k >= 0; k--) this.takePassthrough();
      }
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

    // ADR 0102 — from here the step is executed LIVE, not served: nothing later in this
    // segment is provably a replay. An outcome a re-run will not serve (anything but a
    // completion or a recorded typed failure) leaves the rest of the run unsettled.
    this.segmentLive = true;
    try {
      return await this.executeLive(task, input, id);
    } catch (err) {
      if (this.vm.getTypedFailure(id) === undefined) this.unsettled = true;
      throw err;
    }
  }

  private async executeLive<TIn, TOut>(
    task: ExecutableTask<TIn, TOut>,
    input: TIn,
    id: string
  ): Promise<TOut> {
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
      const verdict = this.readInDoubtVerdict(id, priorFrame.attempts);
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

    // Only a human step that has PARKED (its frame exists) takes an answer: an answer is
    // recorded after the park, so an entry available to a step that never started is not
    // its answer — it is a pre-0104 stray, which a human approval must never be (the runtime
    // refuses to resume such a log, `ambiguous-legacy-answers`).
    const isHuman = this.effectRuntime.kindOf(toolId) === "human";
    if (
      isHuman &&
      priorFrame !== undefined &&
      this.remainingPassthroughs() > this.discardedFor(id)
    ) {
      for (let k = this.discardedFor(id); k > 0; k--) this.takePassthrough(); // operator-discarded
      const answer = this.takePassthrough();
      if (answer !== undefined) {
        this.commit("STEP_COMPLETED", { stepId: id, output: answer.payload });
        this.segmentLive = true; // ADR 0102 — a step outcome committed live, not served
        return answer.payload as TOut;
      }
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
      emit: (eventType: string, payload: unknown) =>
        this.commit(
          eventType,
          guardUserspaceEmit(eventType, payload, {
            kind: "effect",
            stepId: id,
            attempt: this.vm.getState().frames[id]?.attempts ?? 1,
            conflicts: this.decisionConflict,
          })
        ), // ADR 0104
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
      // ADR 0102 — the effect counts as in flight until IT settles, not until this
      // await does: a step whose deadline won keeps a zombie effect running, and an emit
      // from it must not be stamped either.
      this.inFlight++;
      let effectPromise: Promise<TOut>;
      try {
        effectPromise = this.effectRuntime.execute<TIn, TOut>(toolId, input, effectCtx);
      } catch (syncErr) {
        this.inFlight--;
        throw syncErr;
      }
      const settled = (): void => {
        this.inFlight--;
      };
      effectPromise.then(settled, settled);
      if (deadline !== undefined) {
        effectPromise.catch(() => {}); // a late rejection after the deadline won is settled
        output = await Promise.race([effectPromise, deadline.promise]);
      } else {
        output = await effectPromise;
      }
    } catch (err) {
      if (err instanceof SuspendError) {
        // ADR 0104 — a human step's park names the step, so the answer can be attributed to
        // it (and a pre-0104 park, which never did, told apart).
        if (isHuman) throw new SuspendError({ ...err.condition, stepId: id });
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
    // Checked before the replay lookup too: a reserved id is never a flow's to read either.
    assertFlowDecisionId(decisionId);
    if (this.vm.hasDecision(decisionId)) {
      return this.vm.getDecision(decisionId) as T;
    }

    // ADR 0102 — a decider runs only when the decision is made (served on a re-run):
    // the decision is live for this segment, an emit appended while it runs is left
    // unstamped, and a decider that throws records nothing a re-run could serve.
    this.segmentLive = true;
    this.inFlight++;
    let choice: T;
    try {
      choice = await decider();
    } catch (err) {
      this.unsettled = true;
      throw err;
    } finally {
      this.inFlight--;
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
    const answer = this.takePassthrough();
    if (answer !== undefined) return Promise.resolve(answer.payload) as Promise<T>;
    // `stepId` marks a KERNEL human-step park (ADR 0104); a flow cannot claim it.
    const { stepId: _kernelOnly, ...condition } = _config as SuspendConfig & { stepId?: unknown };
    throw new SuspendError(condition);
  }

  /** Recorded gate answers not yet consumed by this run. */
  private remainingPassthroughs(): number {
    return this.recordedPassthroughs().length - this.suspendPassthroughsConsumed;
  }

  private recordedPassthroughs(): unknown[] {
    const variables = this.vm.getState().variables;
    return (
      (variables._resumePayloads as unknown[] | undefined) ??
      ("_resumePayload" in variables ? [variables._resumePayload] : [])
    );
  }

  /**
   * ADR 0104 — how many recorded entries the operator discarded at this human step
   * (`discardLegacyAnswers`, a kernel decision under the reserved `__loom_discard__:` id).
   */
  private discardedFor(stepId: string): number {
    const decisionId = discardDecisionId(stepId);
    if (!this.vm.hasDecision(decisionId)) return 0;
    const n = this.vm.getDecision(decisionId);
    return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : 0;
  }

  /** The next recorded gate answer, consumed in order; `undefined` when none is left. */
  private takePassthrough(): { payload: unknown } | undefined {
    const recorded = this.recordedPassthroughs();
    if (this.suspendPassthroughsConsumed >= recorded.length) return undefined;
    this.segmentLive = false; // ADR 0102 — a new gate segment starts served
    return { payload: recorded[this.suspendPassthroughsConsumed++] };
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
   * The operator verdict answering THIS step's in-doubt park at THIS attempt, if any.
   *
   * Since ADR 0104 the kernel records a verdict as a `DECISION_RECORDED` keyed by step and
   * attempt, so a verdict answers exactly the park it was given for: after a "retry-fresh"
   * attempt itself crashes, the step is in doubt at a NEW attempt, no verdict matches, and it
   * re-parks instead of calling the non-idempotent tool again.
   *
   * Pre-0104 logs carried the verdict as the latest resume payload. That is still honoured,
   * but only while the step's latest EFFECT_INDOUBT fact is for the current attempt — the
   * pre-0104 recovery overwrote the key with `{}`, which hid a stale verdict being re-read.
   */
  private readInDoubtVerdict(
    stepId: string,
    attempts: number
  ): EffectInDoubtResolution | undefined {
    // A verdict answers a park, so it needs the park: the kernel's own EFFECT_INDOUBT fact for
    // this step AT this attempt. A verdict-shaped decision without one (written before the
    // step was ever in doubt) is not a verdict, whoever wrote it.
    if (this.lastInDoubtFor(stepId)?.attempts !== attempts) return undefined;
    const decisionId = inDoubtDecisionId(stepId, attempts);
    if (this.vm.hasDecision(decisionId)) {
      return asInDoubtVerdict(this.vm.getDecision(decisionId), stepId);
    }
    const vars = this.vm.getState().variables;
    if (!("_resumePayload" in vars)) return undefined;
    return asInDoubtVerdict(vars._resumePayload, stepId);
  }
}
