import type { A2UIEmitter } from "@loom/a2ui";
import type { ExecutableTask, ExecutionState, FlowDefinition, StepDefinition } from "@loom/core";
import type { PrincipalChain } from "@loom/effect-runtime";

export interface SuspendConfig {
  on: string;
  timeout?: number;
  correlationKey?: string;
  /**
   * T1 — absolute wake time (epoch ms) for a durable timer. Recorded in the
   * EXECUTION_SUSPENDED condition (the one place wall clock enters the log,
   * P9); a wired TimerService fires the wake. Set by `ctx.sleep`/`sleepUntil`.
   */
  wakeAt?: number;
}

/** T1 — the resume eventType a durable timer fires with (a governed kernel fact). */
export const TIMER_FIRED = "TIMER_FIRED";

/**
 * Options for {@link ExecutionContext.decide}. Shared by the interface and the impl so
 * the two cannot drift. `rationale`/`source` are provenance; the rest are the ADR 0030
 * D1 materialization fields — DESCRIPTIVE metadata recorded alongside the choice but
 * never read back on replay (getDecision returns just `choice`), so P9 is untouched.
 */
export interface DecideOptions {
  rationale?: unknown;
  source?: string;
  /** The other choices considered, for "why did it pick X over Y" explainability. */
  alternatives?: unknown;
  /** Advisory predicted cost of the chosen alternative, in USD. */
  estimatedCostUsd?: number;
  /** Advisory predicted latency of the chosen alternative, in ms. */
  estimatedLatencyMs?: number;
  /** Confidence in the choice (convention: 0–1). */
  confidence?: number;
}

// Loom 2.0: the execution-facing context. `execute` is the generalized durable
// primitive (any task kind); `run` is the step-shaped alias kept for source
// compatibility and the simplest path. `WorkflowContext` remains an alias below.
export interface ExecutionContext {
  readonly executionId: string;
  readonly workflowId: string;

  // Run any task to durable completion. Records STEP_STARTED/STEP_COMPLETED and
  // serves completed tasks from the log on replay (deterministic). A StepDefinition
  // is a valid task (the 'step' kind), so execute(step, input) === run(step, input).
  execute<TIn = unknown, TOut = unknown>(
    task: ExecutableTask<TIn, TOut>,
    input: TIn
  ): Promise<TOut>;

  run<TIn = unknown, TOut = unknown>(step: StepDefinition<TIn, TOut>, input: TIn): Promise<TOut>;

  // Loom 2.0 (P9) — record an advisory/optimizer choice durably. On the first run
  // the `decider` is consulted and its result recorded as DECISION_RECORDED; on
  // replay/resume the recorded choice is returned and `decider` is NEVER called.
  // This is the seam that lets routing/elevation/optimization change outcomes
  // run-to-run while keeping any single run's replay pure (P2). The choice must be
  // JSON-serializable (same constraint as a step output).
  decide<T = unknown>(
    decisionId: string,
    decider: () => T | Promise<T>,
    opts?: DecideOptions
  ): Promise<T>;

  // ADR 0032 (R2) — bounded, logged budget negotiation. Resolves the grant through the
  // decision seam (recorded once, served on replay), so it is advisory and replay-safe:
  // `grant = min(request, ceiling − already-spent)` (or `request` when no ceiling). It
  // does NOT enforce — metering middleware still raises QUOTA_EXCEEDED — it just hands the
  // flow a durable number to plan against. Negotiating one dimension more than once in a
  // flow needs distinct `opts.id` (decisions are keyed by id).
  negotiateBudget(
    dimension: ResourceDimension,
    request: number,
    opts?: { id?: string; ceiling?: number; rationale?: unknown }
  ): Promise<number>;

  parallel<TResults extends unknown[]>(
    pairs: { [K in keyof TResults]: [StepDefinition<unknown, TResults[K]>, unknown] },
    // Optional bounded concurrency. Omit for the current unbounded behaviour.
    // Results are always returned in input order regardless of `limit`, which is
    // load-bearing for deterministic replay.
    options?: { limit?: number }
  ): Promise<TResults>;

  suspend(config: SuspendConfig): Promise<never>;

  // T1 — durable sleep (ABI 1.1.0). The execution suspends with the absolute
  // wake time recorded in the log; a wired TimerService fires the wake as a
  // durable TIMER_FIRED resume, surviving restarts and replaying
  // deterministically (the scheduled time is in the log — wall-clock drift
  // never enters the fold). Without a timer service the suspension is still
  // durable and can be resumed manually (or by any node's service).
  sleep(ms: number): Promise<void>;
  sleepUntil(wakeAt: number): Promise<void>;

  emit(eventType: string, payload: unknown): void;

  stream(eventType: string, delta: string, done?: boolean): void;

  // A2UI — drive the UI with durable, replayable patch/event updates.
  // ctx.ui.set(path, value) / append / merge / increment / remove / patch.
  readonly ui: A2UIEmitter;
}

// Back-compat alias. Existing code importing `WorkflowContext` keeps working; the
// two are identical types. New code should prefer `ExecutionContext`.
export type WorkflowContext = ExecutionContext;

/** A negotiable/metered resource dimension (ADR 0032). */
export type ResourceDimension = "tokens" | "costUsd" | "ms" | "memBytes" | "wallMs" | "netBytes";

export interface RunOptions {
  executionId?: string;
  /**
   * K9.4 — the monotonic fencing token this dispatch holds (from
   * `EventStore.acquireFence` / `WorkflowRuntime.acquireFence`). Every event the
   * run appends carries it in `metadata.fence`; a fencing store rejects appends
   * from an older token, so a zombie predecessor of a re-dispatched execution
   * cannot write. Omit (or run against a non-fencing store) for today's behavior.
   */
  fence?: number;
  /**
   * K8.3 — wall-clock deadline for this run, anchored to the LOGGED
   * `EXECUTION_STARTED` timestamp — so recovery/resume never resets the clock,
   * and resuming an execution whose deadline already passed cancels it
   * immediately. Breach = kernel-driven `cancel()` (durable
   * `EXECUTION_CANCELLED`). Overrides the flow's declarative
   * `flow$({ deadlineMs })`. Enforced while a process actively runs the
   * execution; durable firing across idle suspension arrives with T1's timers.
   */
  deadlineMs?: number;
  /**
   * K11.1 — explicit operator acknowledgement to resume across a flow-code
   * mismatch (the recorded `flowHash` differs from the registered flow's).
   * The refusal is never silent and never silently overridden: this is the
   * primitive "operator-ack" escape hatch until K11.3's `resumeAs` migration
   * verdict API lands. Prefer pinning the original flow code instead.
   */
  allowFlowCodeMismatch?: boolean;
  /**
   * K12.1 — the authenticated principal chain for this run, established at the
   * trust boundary (start / resume API / A2A server) and threaded opaquely into
   * every effect's authorization (K2). Undefined ⇒ no principal.
   */
  principal?: PrincipalChain;
}

/**
 * K12.2 — verifies a resume event that gates authority (an approval), so
 * "who approved" is EVIDENCE, not an unverified claim. Pluggable at the trust
 * boundary. `verify` returns:
 *  - `verified` → an `APPROVAL_GRANTED { actor, verifiedBy }` fact is recorded
 *    and the resume proceeds;
 *  - `rejected` → the resume is REFUSED (a forged approval does not resume);
 *  - `not-applicable` → an ordinary resume, no approval semantics.
 */
export interface ResumeAuthenticator {
  verify(event: ResumeEvent): ResumeVerdict;
}

export type ResumeVerdict =
  | { status: "verified"; actor: string; verifiedBy: string }
  | { status: "rejected"; reason: string }
  | { status: "not-applicable" };

/** K12.2 — thrown when a `ResumeAuthenticator` rejects an approval as unverified/forged. */
export class ApprovalRejectedError extends Error {
  constructor(
    readonly executionId: string,
    readonly reason: string
  ) {
    super(`resume of "${executionId}" refused: approval not verified — ${reason}`);
    this.name = "ApprovalRejectedError";
    Object.setPrototypeOf(this, ApprovalRejectedError.prototype);
  }
}

/**
 * K11.1 — an in-flight execution's log was recorded under different flow code
 * than what is registered now (a deploy changed the flow's fold-relevant
 * structure while the execution was suspended/running). Resuming would fold
 * the log with code that never wrote it, so the kernel refuses rather than
 * proceeding silently.
 */
/**
 * K11.3 — a `resumeAs(…, { strategy: "replay-check" })` migration was refused:
 * steps recorded in the execution's log no longer exist in the target flow, so
 * their durable outputs would be orphaned and re-executed live. Rename the steps
 * back, migrate to a compatible flow, or use `strategy: "operator-ack"` after a
 * manual review.
 */
export class FlowMigrationCheckError extends Error {
  constructor(
    readonly executionId: string,
    readonly toFlowId: string,
    readonly orphanedStepIds: string[]
  ) {
    super(
      `migration of execution "${executionId}" to flow "${toFlowId}" refused (replay-check): recorded step(s) [${orphanedStepIds.join(", ")}] do not exist in the target flow — their durable outputs would be orphaned and re-run live`
    );
    this.name = "FlowMigrationCheckError";
    Object.setPrototypeOf(this, FlowMigrationCheckError.prototype);
  }
}

export class FlowCodeMismatchError extends Error {
  constructor(
    readonly executionId: string,
    readonly workflowId: string,
    readonly recordedHash: string,
    readonly registeredHash: string
  ) {
    super(
      `flow code changed under in-flight execution "${executionId}" (flow "${workflowId}"): log was recorded under ${recordedHash}, registered code is ${registeredHash}. Exits: (1) PIN — deploy/register the original flow code and resume on it; (2) MIGRATE — resume with { allowFlowCodeMismatch: true } after verifying fold-compatibility (loom deploy check / @loom/deploy-sim); (3) DRAIN — cancel() the execution and restart it on the new code.`
    );
    this.name = "FlowCodeMismatchError";
    Object.setPrototypeOf(this, FlowCodeMismatchError.prototype);
  }
}

/**
 * K8.3 — a step exceeded its declared `timeoutMs`. The deadline is anchored to
 * the step's first LOGGED `STEP_STARTED` (frame.firstStartedAt), so a
 * crash-recovery re-run resumes the countdown instead of restarting it. Fails
 * the step via the ordinary STEP_FAILED path.
 */
export class StepTimeoutError extends Error {
  constructor(
    readonly stepId: string,
    readonly timeoutMs: number
  ) {
    super(`step "${stepId}" exceeded its deadline (timeoutMs=${timeoutMs})`);
    this.name = "StepTimeoutError";
    Object.setPrototypeOf(this, StepTimeoutError.prototype);
  }
}

export interface ExecutionHandle {
  executionId: string;
  waitForCompletion(): Promise<ExecutionState>;
  waitForSuspend(): Promise<ExecutionState>;
  getState(): ExecutionState;
  /**
   * Cancel this live execution. Aborts the signal handed to in-flight effects,
   * records a durable EXECUTION_CANCELLED event, and rejects waitForCompletion.
   * Only affects in-flight work — already-persisted state and resume semantics
   * are unchanged. Idempotent.
   */
  cancel(reason?: unknown): void;
}

export type FlowRunner<TIn, TOut> = (ctx: WorkflowContext, input: TIn) => Promise<TOut>;

export interface RegisteredFlow<TIn = unknown, TOut = unknown> {
  definition: FlowDefinition<TIn, TOut>;
  runner: FlowRunner<TIn, TOut>;
}

export interface ResumeEvent {
  eventType: string;
  payload: unknown;
}

// ── K9 — effect delivery: in-doubt parking & operator resolution ─────────────
//
// Effects are at-least-once: a crash between an effect and its STEP_COMPLETED
// append re-runs the effect on recovery. For a tool declared `idempotent: false`
// recovery refuses the silent re-run — it records EFFECT_INDOUBT and suspends
// with `on: EFFECT_INDOUBT_RESOLVED`. An operator settles it with a standard
// resume carrying an {@link EffectInDoubtResolution} payload.

/** The resume eventType that resolves an EFFECT_INDOUBT parking. */
export const EFFECT_INDOUBT_RESOLVED = "EffectInDoubtResolved";

/**
 * Operator verdict for a parked, in-doubt effect — the payload of a
 * `resume(executionId, { eventType: EFFECT_INDOUBT_RESOLVED, payload })` call.
 *
 * - `"completed-with-result"` — the prior attempt's side effect DID happen;
 *   adopt `output` as the step result without re-running the tool.
 * - `"retry-fresh"` — the prior attempt did NOT happen (or was compensated);
 *   re-run the tool as a new logical attempt with a fresh idempotency key.
 * - `"fail"` — settle the step (and execution) as failed with `error`.
 */
export interface EffectInDoubtResolution {
  /** Must match the parked step id (recorded in the EFFECT_INDOUBT fact). */
  stepId: string;
  resolution: "completed-with-result" | "retry-fresh" | "fail";
  output?: unknown;
  error?: unknown;
}

export interface ForkOptions {
  /** Optional branch name to register a movable ref for the new branch. */
  branchName?: string;
  /** Optional explicit executionId for the child (defaults to a fresh ULID). */
  executionId?: string;
}

export interface ForkResult {
  /** The child (forked) execution id. */
  executionId: string;
  parentExecutionId: string;
  /** The sequence the branch forked at. */
  forkSequence: number;
  /** The branch name registered, if any (else the child executionId). */
  branchName: string;
  /**
   * Materialized ExecutionState at the fork point, already stamped with the
   * child executionId. Hand directly to `restoreFromState` to drive the branch
   * down an alternate path, or call `resume(child.executionId, …)`.
   */
  state: ExecutionState;
}
