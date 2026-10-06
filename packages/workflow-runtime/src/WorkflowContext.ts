import { createSurfaceEmitter } from "@loom/agent-surface";
import type { SurfaceEmitter } from "@loom/agent-surface";
import { SuspendError, TypedFailure, fnv1a64 } from "@loom/core";
import type { ExecutableTask, StepDefinition } from "@loom/core";
import type { EffectRuntime, PrincipalChain, ResourceSnapshot } from "@loom/effect-runtime";
import type { ReplayVM } from "@loom/replay-vm";
import { linkSignals, parallelLimit } from "@loom/scheduler";
import type { ExecutionJournal } from "./ExecutionJournal";
import { armDeadline, assertValidBudget, remainingBudget } from "./deadlineTimer";
import { asInDoubtVerdict, inDoubtDecisionId } from "./inDoubt";
import { markKernelHumanPark } from "./kernelPark";
import { discardDecisionId } from "./strayPassthroughs";
import {
  DecideScopeClosedError,
  EFFECT_INDOUBT_RESOLVED,
  ExecutionCancelledError,
  ParallelScopeFailedError,
  StepTimeoutError,
  TIMER_FIRED,
} from "./types";
import type {
  BranchContext,
  DecideOptions,
  DecideScope,
  EffectInDoubtResolution,
  ParallelOptions,
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

// ── ADR 0112 — cancellation scopes ─────────────────────────────────────────────────────────────

/** Default bound on the park barrier's drain (ADR 0112 D3). */
export const DEFAULT_PARK_DRAIN_MS = 30_000;
/** The post-abort grace: how long aborted work gets to unwind before a scope/park stops waiting. */
const ABORT_GRACE_CAP_MS = 1_000;
/** Most step ids a `PARALLEL_COMPLETED` carries (the record is bounded, ≈1 KiB). */
const SCOPE_CANCELLED_CAP = 32;
const SCOPE_ERROR_CAP = 512;

/** Errors that are the scope's own cancellation noise, never "the first real error". */
const CANCEL_NOISE = new WeakSet<object>();

function noise<E extends Error>(err: E): E {
  CANCEL_NOISE.add(err);
  return err;
}

/** The abort reason of a scope that failed fast (or aborted on a park). */
class ScopeAbortedError extends Error {
  constructor(scopePath: string, why: string) {
    super(`parallel scope "${scopePath}" aborted (${why})`);
    this.name = "ScopeAbortedError";
    Object.setPrototypeOf(this, ScopeAbortedError.prototype);
    noise(this);
  }
}

/** A branch of a scope served from its journaled outcome tried to START work: it never does. */
class ScopeServedError extends Error {
  constructor(stepId: string, scopePath: string) {
    super(
      `step "${stepId}" not started: parallel scope "${scopePath}" is served from its recorded outcome`
    );
    this.name = "ScopeServedError";
    Object.setPrototypeOf(this, ScopeServedError.prototype);
    noise(this);
  }
}

/** A `parallel` branch: a `[step, input]` pair or a branch function. */
type Branch = [StepDefinition, unknown] | ((branch: BranchContext) => Promise<unknown>);

/** One `parallel` call: its controller, and what the call has learned about its branches. */
interface ScopeGroup {
  readonly controller: AbortController;
  parked: boolean;
  /** Step ids that recorded `STEP_CANCELLED` under this scope (descendants included). */
  readonly cancelled: string[];
}

/** A branch's place in the scope tree: its path, its signal, and its group chain. */
interface Scope {
  readonly path: string;
  readonly parent: Scope | undefined;
  readonly group: ScopeGroup | undefined;
  /** The execution signal ∧ every enclosing scope's ∧ the park-drain abort. */
  readonly signal: AbortSignal | undefined;
  /** Ordinal of the next `parallel` call made in this scope. */
  parallelCount: number;
  /** This scope replays a journaled outcome: it serves frames and never starts work. */
  readonly servedOnly: boolean;
}

function scopeIsParked(scope: Scope | undefined): boolean {
  for (let s = scope; s !== undefined; s = s.parent) if (s.group?.parked === true) return true;
  return false;
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
  // L30 — ordinal for a decider scope call's `callKey` (unique across every decide() in this context).
  private scopeCallSeq = 0;
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
  // ADR 0112 — the root scope (path ""), the park barrier's state, and the in-flight set.
  private readonly parkController = new AbortController();
  private readonly rootScope: Scope;
  private activeWork = 0;
  private idleWaiters: Array<() => void> = [];
  private frozen = false;
  private sealed = false;
  private warnedSealed = false;
  private readonly parkDrainMs: number;
  private readonly onWarn: (message: string) => void;

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
    private readonly principal: PrincipalChain | undefined = undefined,
    // The runtime's injectable clock (`WorkflowRuntimeDeps.now`). Step deadlines are
    // anchored to journal timestamps written with THIS clock, so the remaining budget
    // must be measured with it too — never with a raw `Date.now()`.
    private readonly now: () => number = Date.now,
    opts: { parkDrainMs?: number; onWarn?: (message: string) => void } = {}
  ) {
    this.parkDrainMs = opts.parkDrainMs ?? DEFAULT_PARK_DRAIN_MS;
    this.onWarn = opts.onWarn ?? (() => {});
    this.rootScope = {
      path: "",
      parent: undefined,
      group: undefined,
      signal: linkSignals(this.signal, this.parkController.signal),
      parallelCount: 0,
      servedOnly: false,
    };
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
    if (this.isSealed(eventType)) return;
    this.journal.commit(eventType, payload, { metadata: { flowEmit: digest } });
  }

  // Synchronous: the journal allocates a sequence, folds the VM, fires onEvent,
  // and enqueues the durable write. The async persistence is drained at barriers.
  // The kernel's own facts (STEP_*, DECISION_RECORDED, EFFECT_INDOUBT) and
  // `EffectContext.emit` come through here, never through the flow-level `emit`:
  // their callers are already served from the fold on a re-run, and they must not
  // consume a flow-emit ordinal (ADR 0102).
  private commit(eventType: string, payload: unknown): void {
    if (this.isSealed(eventType)) return;
    this.journal.commit(eventType, payload);
  }

  /**
   * ADR 0112 D3 — after the park is committed (or its drain gave up), nothing this context's
   * work appends reaches the log: a late sibling's effect ran, its result is dropped, and it
   * re-runs on resume under the same idempotency key. A typed, logged warning, never a write.
   */
  private isSealed(eventType: string): boolean {
    if (!this.sealed) return false;
    if (!this.warnedSealed) {
      this.warnedSealed = true;
      this.onWarn(
        `execution "${this.executionId}": a ${eventType} from work still running after the park was committed was DROPPED (journal sealed, ADR 0112) — it re-runs on resume under the same idempotency key`
      );
    }
    return true;
  }

  // ── ADR 0112 D3 — the park barrier (called by the runtime around the park commit) ─────────

  private beginWork(): void {
    this.activeWork++;
  }

  private endWork(): void {
    if (--this.activeWork > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /** Resolves true when the in-flight set is empty, false when `ms` elapse first. */
  private async idleWithin(ms: number): Promise<boolean> {
    if (this.activeWork === 0) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((w) => w !== onIdle);
        resolve(false);
      }, ms);
      const onIdle = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.idleWaiters.push(onIdle);
    });
  }

  /**
   * Called when a park is DECIDED (a `SuspendError` reached the runner): freeze new step
   * starts, then wait for every in-flight step to settle so its event lands BEFORE
   * `EXECUTION_SUSPENDED`. Bounded by `parkDrainMs`: past it the stragglers are aborted and
   * given a short grace; whatever is still running after that is sealed out by {@link seal}.
   * Synchronous (no await, no extra tick) when nothing is in flight.
   */
  parkBarrier(): Promise<void> | undefined {
    this.frozen = true;
    if (this.activeWork === 0) return undefined;
    return (async () => {
      if (await this.idleWithin(this.parkDrainMs)) return;
      this.parkController.abort(new ScopeAbortedError("", "park drain exceeded parkDrainMs"));
      if (!(await this.idleWithin(Math.min(this.parkDrainMs, ABORT_GRACE_CAP_MS)))) {
        // Still running after the abort and its grace: stop listening to it. The step's effect
        // ran, its result is not recorded, and it re-runs on resume under the same key.
        this.sealed = true;
      }
    })();
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
  execute<TIn = unknown, TOut = unknown>(
    task: ExecutableTask<TIn, TOut>,
    input: TIn
  ): Promise<TOut> {
    return this.executeIn(this.rootScope, task, input);
  }

  /** `execute` as a step of `scope` (ADR 0112): the scope's signal governs it, its path names it. */
  private async executeIn<TIn, TOut>(
    scope: Scope,
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

    // ADR 0112 — a scope served from its journaled outcome never STARTS work: a step that is
    // not already completed (or a recorded typed failure, above) is one the first run
    // cancelled, failed or never reached, and starting it would make replay timing-dependent.
    if (scope.servedOnly) throw new ScopeServedError(id, scope.path);

    // K8 — a cancelled execution starts no further steps: bail before the
    // STEP_STARTED is even logged (EXECUTION_CANCELLED owns the outcome).
    this.throwIfCancelled(scope.signal);

    // ADR 0112 D3 — a park is decided (the runner caught it, or a sibling's park is
    // unwinding this scope): no NEW step starts between the decision and the commit. The call
    // waits for the park; the resume re-runs the flow and the step-identity rule re-issues it.
    if (this.frozen || scopeIsParked(scope)) return new Promise<TOut>(() => {});

    // ADR 0102 — from here the step is executed LIVE, not served: nothing later in this
    // segment is provably a replay. An outcome a re-run will not serve (anything but a
    // completion or a recorded typed failure) leaves the rest of the run unsettled.
    this.segmentLive = true;
    this.beginWork();
    try {
      return await this.executeLive(scope, task, input, id);
    } catch (err) {
      if (this.vm.getTypedFailure(id) === undefined) this.unsettled = true;
      throw err;
    } finally {
      this.endWork();
    }
  }

  private async executeLive<TIn, TOut>(
    scope: Scope,
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
    const priorFrame = this.vm.peekState().frames[id];
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

    assertValidBudget("timeoutMs", task.timeoutMs, `step "${id}"`); // before anything is logged
    this.commit("STEP_STARTED", { stepId: id, input });

    // K8.3 — declared step deadline (`timeoutMs`), anchored to the step's FIRST
    // logged start so a crash-recovery re-run resumes the countdown rather than
    // resetting it. Enforcement is kernel-side: the step signal aborts (for
    // cooperative effects) AND the await is raced (for effects that ignore it —
    // settlement truth is the durable STEP_FAILED, not physical termination).
    const timeoutMs = task.timeoutMs;
    const scopeSignal = scope.signal;
    let stepSignal = scopeSignal;
    let deadline: { promise: Promise<never>; cleanup: () => void } | undefined;
    if (timeoutMs !== undefined) {
      const frame = this.vm.peekState().frames[id];
      const anchor = frame?.firstStartedAt ?? frame?.startedAt ?? this.now();
      // Same clock as the anchor (journal timestamps). Only the DIFFERENCE is used, and
      // the setTimeout below arms with real milliseconds, so `now` must advance in real
      // time for a deadline to fire (see `WorkflowRuntimeDeps.now`).
      const remaining = remainingBudget(timeoutMs, anchor, this.now);
      if (remaining <= 0) {
        const timeoutErr = new StepTimeoutError(id, timeoutMs);
        this.commit("STEP_FAILED", { stepId: id, error: String(timeoutErr) });
        throw timeoutErr;
      }
      const controller = new AbortController();
      const onParentAbort = (): void => controller.abort(scopeSignal?.reason);
      if (scopeSignal !== undefined) {
        if (scopeSignal.aborted) controller.abort(scopeSignal.reason);
        else scopeSignal.addEventListener("abort", onParentAbort, { once: true });
      }
      let clearTimer: () => void = () => {};
      const promise = new Promise<never>((_, reject) => {
        clearTimer = armDeadline(
          () => remainingBudget(timeoutMs, anchor, this.now),
          () => {
            const timeoutErr = new StepTimeoutError(id, timeoutMs);
            controller.abort(timeoutErr);
            reject(timeoutErr);
          }
        );
      });
      promise.catch(() => {}); // un-awaited when the effect settles first
      deadline = {
        promise,
        cleanup: () => {
          clearTimer();
          scopeSignal?.removeEventListener("abort", onParentAbort);
        },
      };
      stepSignal = controller.signal;
    }

    const effectCtx = {
      executionId: this.executionId,
      stepId: id,
      workflowId: this.workflowId,
      attempt: this.vm.peekState().frames[id]?.attempts ?? 1,
      emit: (eventType: string, payload: unknown) =>
        this.commit(
          eventType,
          guardUserspaceEmit(eventType, payload, {
            kind: "effect",
            stepId: id,
            attempt: this.vm.peekState().frames[id]?.attempts ?? 1,
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
      resources: this.resourceSnapshot(),
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
        if (isHuman) {
          throw markKernelHumanPark(new SuspendError({ ...err.condition, stepId: id }));
        }
        throw err;
      }
      // A cancelled execution surfaces here as an effect rejection. Record it as
      // a cancelled step (not a failure) so the event log and replayed state stay
      // truthful; EXECUTION_CANCELLED owns the execution-level status. (A step
      // timeout is NOT a cancellation — this.signal stays quiet — so it falls to
      // the ordinary STEP_FAILED below.)
      if (scopeSignal?.aborted === true) {
        this.commit("STEP_CANCELLED", { stepId: id });
        // ADR 0112 D2 — the scope it ran in (and every enclosing one) reports it cancelled, and
        // the error it unwinds with is the scope's noise, never "the first real error".
        for (let g: Scope | undefined = scope; g !== undefined; g = g.parent) {
          g.group?.cancelled.push(id);
        }
        if (typeof err === "object" && err !== null) CANCEL_NOISE.add(err);
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
  decide<T = unknown>(
    decisionId: string,
    decider: (scope: DecideScope) => T | Promise<T>,
    opts?: DecideOptions
  ): Promise<T> {
    return this.decideIn(this.rootScope, decisionId, decider, opts);
  }

  private async decideIn<T>(
    cancelScope: Scope,
    decisionId: string,
    decider: (scope: DecideScope) => T | Promise<T>,
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
    this.beginWork();
    let choice: T;
    // L30 — the decider's transient invoker, stamped with THIS execution. The scope owns
    // an AbortController composed into every call's signal and aborted when the decider
    // settles, so a call started and never awaited cannot outlive the decision.
    let scopeOpen = true;
    const scopeCtl = new AbortController();
    const scope: DecideScope = {
      invokeTransient: (toolId, input, o) => {
        if (!scopeOpen) {
          return Promise.reject(
            new DecideScopeClosedError(
              decisionId,
              `decide("${decisionId}"): the decider's scope is closed (decider settled)`
            )
          );
        }
        // Execution cancellation + the decider's own signal + the scope's lifetime: all
        // three abort the call (the decider's signal ADDS to the execution's, never replaces).
        const signal = linkSignals(cancelScope.signal, o?.signal, scopeCtl.signal);
        // stepId stays the toolId (as a bare call) so every stepId-keyed consumer —
        // redaction, pricing, per-tool middleware config — matches; `callKey` carries the
        // decision attribution + an ordinal for sites that mint ids. The ordinal is per
        // CONTEXT, not per decide(), so two live decide() calls sharing an id (e.g. under
        // Promise.all) still mint distinct keys.
        return this.effectRuntime.invokeTransient(toolId, input, {
          as: {
            workflowId: this.workflowId,
            executionId: this.executionId,
            callKey: `decide:${decisionId}:${this.scopeCallSeq++}`,
          },
          // Admission control sees the execution's running spend (the charge is dropped
          // by the no-op emit, so spend made here is invisible to the budget).
          resources: this.resourceSnapshot(),
          ...(signal !== undefined && { signal }),
          ...(this.principal !== undefined && { principal: this.principal }),
        });
      },
    };
    try {
      choice = await decider(scope);
    } catch (err) {
      this.unsettled = true;
      throw err;
    } finally {
      scopeOpen = false;
      scopeCtl.abort(new DecideScopeClosedError(decisionId));
      this.inFlight--;
      this.endWork();
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

  /** The running resource totals from the durable fold (K3), zeroed when nothing metered. */
  private resourceSnapshot(): ResourceSnapshot {
    return (
      (this.vm.peekState().variables._resources as ResourceSnapshot | undefined) ?? {
        tokens: 0,
        costUsd: 0,
        ms: 0,
        count: 0,
      }
    );
  }

  /** Current spend for a dimension, read from the deterministic `_resources` fold (0 if unset). */
  private currentResource(dimension: ResourceDimension): number {
    const r = this.vm.peekState().variables._resources as Record<string, number> | undefined;
    return r?.[dimension] ?? 0;
  }

  parallel<TResults extends unknown[]>(
    branches: {
      [K in keyof TResults]:
        | [StepDefinition<unknown, TResults[K]>, unknown]
        | ((branch: BranchContext) => Promise<TResults[K]>);
    },
    options?: ParallelOptions
  ): Promise<TResults> {
    return this.parallelIn(
      this.rootScope,
      branches as unknown as Branch[],
      options
    ) as Promise<TResults>;
  }

  /** The context a branch function receives: this context, with the branch's scope bound in. */
  private branchContext(scope: Scope): BranchContext {
    const overrides: Record<string, unknown> = {
      scopePath: scope.path,
      execute: (task: ExecutableTask, input: unknown) => this.executeIn(scope, task, input),
      run: (step: StepDefinition, input: unknown) => this.executeIn(scope, step, input),
      decide: (id: string, decider: (s: DecideScope) => unknown, o?: DecideOptions) =>
        this.decideIn(scope, id, decider, o),
      parallel: (b: Branch[], o?: ParallelOptions) => this.parallelIn(scope, b, o),
    };
    return new Proxy(this, {
      get(target, prop) {
        if (typeof prop === "string" && Object.hasOwn(overrides, prop)) return overrides[prop];
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as BranchContext;
  }

  /**
   * ADR 0112 D1/D2 — one `parallel` call as a cancellation scope.
   *
   * Identity: the call is `"<parent>/<k>"` (`k` = how many `parallel` calls the parent scope has
   * made), its branches `"<parent>/<k>.<i>"` — a pure function of the flow's control flow.
   * A first REAL branch failure (not a park, not cancellation noise) aborts the scope's signal;
   * the call settles once every branch has (bounded by a grace for work that ignores the
   * signal), journals `PARALLEL_COMPLETED`, and rethrows the first real error by input order.
   * A re-run that finds the scope in `_scopes` is SERVED from the record: branches serve
   * their frames, none starts work, and the recorded error is rethrown.
   */
  private async parallelIn(
    parent: Scope,
    branches: Branch[],
    options?: ParallelOptions
  ): Promise<unknown[]> {
    const k = parent.parallelCount++;
    const scopePath = `${parent.path}/${k}`;
    const n = branches.length;
    const results = new Array<unknown>(n);
    if (n === 0) return results;
    const failFast = options?.failFast ?? true;
    const onPark = options?.onPark ?? "drain";
    const rawLimit = options?.limit;
    const limit = Math.min(rawLimit === undefined || rawLimit <= 0 ? n : rawLimit, n);

    const recorded = this.recordedScope(scopePath);
    const group: ScopeGroup = { controller: new AbortController(), parked: false, cancelled: [] };
    const groupSignal = linkSignals(parent.signal, group.controller.signal);
    const execAborted = (): boolean => parent.signal?.aborted === true;

    const errors = new Array<{ err: unknown } | undefined>(n);
    let firstPark: SuspendError | undefined;
    let triggered = false; // a real failure aborted the scope
    let started = 0;
    let running = 0;
    let settled = 0;
    let finish: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const isReal = (err: unknown): boolean =>
      !(err instanceof SuspendError) &&
      !(typeof err === "object" && err !== null && CANCEL_NOISE.has(err));

    const canStart = (): boolean =>
      !triggered && firstPark === undefined && !execAborted() && !scopeIsParked(parent);

    const launch = (): void => {
      while (running < limit && started < n && canStart()) {
        const i = started++;
        running++;
        const node: Scope = {
          path: `${scopePath}.${i}`,
          parent,
          group,
          signal: groupSignal,
          parallelCount: 0,
          servedOnly: parent.servedOnly || recorded !== undefined,
        };
        const branch = branches[i]!;
        let p: Promise<unknown>;
        try {
          p = Array.isArray(branch)
            ? this.executeIn(node, branch[0], branch[1])
            : Promise.resolve(branch(this.branchContext(node)));
        } catch (err) {
          p = Promise.reject(err);
        }
        p.then(
          (v) => {
            results[i] = v;
            onSettle();
          },
          (err: unknown) => {
            errors[i] = { err };
            onReject(err);
            onSettle();
          }
        );
      }
    };

    const onReject = (err: unknown): void => {
      if (err instanceof SuspendError) {
        // A park is a BARRIER, not a failure (D2/D3). Mark the scope chain so no sibling starts
        // new work; the call surfaces the park at once — the runner drains in-flight steps.
        if (!triggered && firstPark === undefined) {
          firstPark = err;
          for (let g: Scope | undefined = parent; g !== undefined; g = g.parent) {
            if (g.group !== undefined) g.group.parked = true;
          }
          group.parked = true;
          if (onPark === "abort") {
            group.controller.abort(new ScopeAbortedError(scopePath, "a branch parked"));
          }
          finish?.();
        }
        return;
      }
      if (!failFast || recorded !== undefined || triggered || firstPark !== undefined) return;
      if (execAborted() || !isReal(err)) return;
      triggered = true;
      group.controller.abort(new ScopeAbortedError(scopePath, "a branch failed"));
      // Cooperative work unwinds in microtasks; work that ignores the signal gets a grace.
      graceTimer = setTimeout(() => finish?.(), Math.min(this.parkDrainMs, ABORT_GRACE_CAP_MS));
    };

    const onSettle = (): void => {
      running--;
      settled++;
      launch();
      if (running === 0 && (started >= n || !canStart())) finish?.();
    };

    launch();
    await done;
    if (graceTimer !== undefined) clearTimeout(graceTimer);

    if (firstPark !== undefined) throw firstPark;

    // Real errors by input order (cancellation noise excluded).
    let failed = -1;
    for (let i = 0; i < n; i++) {
      const e = errors[i];
      if (e !== undefined && isReal(e.err)) {
        failed = i;
        break;
      }
    }

    if (recorded !== undefined) {
      // Served: rethrow the recorded failure, as the typed failure where the frames hold one.
      const at = recorded.failedBranch;
      const own = at !== undefined ? errors[at] : undefined;
      if (own !== undefined && isReal(own.err)) throw own.err;
      // The record is `String(error)` ("Name: message"): the rethrow carries the original message.
      const m = /^[A-Za-z_$][\w$]*: ([\s\S]*)$/.exec(recorded.error);
      throw new ParallelScopeFailedError(m?.[1] ?? recorded.error, scopePath, at);
    }

    if (failed < 0) {
      // No real failure: success, or the execution was cancelled out from under the scope.
      const noisy = errors.find((e) => e !== undefined);
      if (noisy !== undefined) throw noisy.err;
      if (settled < n) {
        this.throwIfCancelled(parent.signal);
        // Branches were left unstarted because an enclosing scope is parking: wait for it.
        return new Promise<unknown[]>(() => {});
      }
      return results;
    }

    const failure = errors[failed]!.err;
    if (failFast && !execAborted()) {
      // Journaled BEFORE the rethrow, exactly once: a re-run serves the scope from this record
      // instead of re-deriving it from timing (a cancelled/untyped-failed frame re-executes).
      this.commit("PARALLEL_COMPLETED", {
        scopePath,
        failedBranch: failed,
        error: String(failure).slice(0, SCOPE_ERROR_CAP),
        cancelled: group.cancelled.slice(0, SCOPE_CANCELLED_CAP),
      });
    }
    throw failure;
  }

  /** The journaled outcome of the scope at `scopePath`, when a previous run recorded one. */
  private recordedScope(
    scopePath: string
  ): { failedBranch: number | undefined; error: string } | undefined {
    const scopes = this.vm.peekState().variables._scopes as Record<string, unknown> | undefined;
    if (scopes === undefined || !Object.hasOwn(scopes, scopePath)) return undefined;
    const r = scopes[scopePath] as { failedBranch?: unknown; error?: unknown } | undefined;
    if (r === undefined || r === null || typeof r !== "object") return undefined;
    return {
      failedBranch: typeof r.failedBranch === "number" ? r.failedBranch : undefined,
      error: typeof r.error === "string" ? r.error : String(r.error ?? "parallel scope failed"),
    };
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
    // `stepId` marks a KERNEL human-step park (ADR 0104) and `waits` is the kernel's multi-wait
    // table (ADR 0110); a flow can claim neither. Stripped here for the early error, and again at
    // the commit site (WorkflowRuntime) for the paths that never come through `ctx.suspend`.
    const {
      stepId: _kernelStep,
      waits: _kernelWaits,
      ...condition
    } = _config as SuspendConfig & { stepId?: unknown; waits?: unknown };
    throw new SuspendError(condition);
  }

  /** Recorded gate answers not yet consumed by this run. */
  private remainingPassthroughs(): number {
    return this.recordedPassthroughs().length - this.suspendPassthroughsConsumed;
  }

  private recordedPassthroughs(): unknown[] {
    const variables = this.vm.peekState().variables;
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
  // The runtime's injectable clock, not raw `Date.now()`: the TimerService compares this
  // wakeAt with the same clock (it defaults to `runtime.clock`), so both must agree.
  async sleep(ms: number): Promise<void> {
    await this.sleepUntil(this.now() + ms);
  }

  async sleepUntil(wakeAt: number): Promise<void> {
    await this.suspend({ on: TIMER_FIRED, wakeAt });
  }

  // K8 — abort fast when the owning execution has been cancelled. Scoped to a
  // helper so the signal narrowing doesn't leak into callers (the signal flips
  // asynchronously; call sites must re-check it each time).
  private throwIfCancelled(signal: AbortSignal | undefined = this.rootScope.signal): void {
    if (signal?.aborted) {
      // A caller-supplied Error reason is thrown as-is (never wrapped). `cancel()` always
      // aborts with an Error, so the fallback below is DEFENSIVE: it is reached only if
      // something else aborts this controller with a non-Error (the journal's storage-error
      // abort, should a store ever reject with one), which it then reports as a cancel.
      throw signal.reason instanceof Error
        ? signal.reason
        : new ExecutionCancelledError("execution cancelled", signal.reason);
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
    const indoubt = this.vm.peekState().variables._indoubt as
      | Array<{ stepId?: string }>
      | undefined;
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
    const indoubt = this.vm.peekState().variables._indoubt as
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
    const vars = this.vm.peekState().variables;
    if (!("_resumePayload" in vars)) return undefined;
    return asInDoubtVerdict(vars._resumePayload, stepId);
  }
}
