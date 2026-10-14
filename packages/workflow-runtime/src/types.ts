import type { ExecutableTask, ExecutionState, FlowDefinition, StepDefinition } from "@loom/core";
import type { DeltaSink, PrincipalChain } from "@loom/effect-runtime";

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
  /**
   * R13 (ADR 0117) — digest of what the approver is asked to approve; see
   * `SuspendCondition.viewDigest`. Compute it with `viewDigest()` / `approvalViewDigest()`.
   */
  viewDigest?: string;
}

/** T1 — the resume eventType a durable timer fires with (a governed kernel fact). */
export const TIMER_FIRED = "TIMER_FIRED";

/**
 * The resume eventType a dispatcher re-drives a CRASHED execution with: not a
 * gate, so it addresses a `running`/`pending` execution rather than a suspended
 * one, and it folds to a no-op (there is no handler of this name). Since ADR 0104
 * it is recorded ALONE: no EXECUTION_RESUMED beside it, because that event's payload
 * is a gate passthrough and a re-drive answers no gate (pre-0104 logs carry the pair,
 * replayed as written). Raised by
 * `LocalWorkerRuntime.resolveHandle`; it is not a signal an external caller has
 * any reason to send, and the resume gate refuses it on a parked execution.
 */
export const EXECUTION_RECOVERED = "EXECUTION_RECOVERED";

/**
 * L30 — what `ctx.decide` hands its decider: a transient invoker STAMPED with the
 * deciding execution. `invokeTransient` is `EffectRuntime.invokeTransient` (R1-R5:
 * nothing journalled, no-op `emit`, the same middleware chain, and the
 * journaled/ambient effect-mode check — a `journaled` effect is refused; undeclared
 * effects are allowed) except that the call carries the execution's
 * `workflowId`/`executionId`, its FULL principal chain (actor, delegation token)
 * and its cancellation signal (a `signal` you pass ADDS to it, never replaces it).
 * `stepId` stays the toolId, as for a bare call, so stepId-keyed config (redaction,
 * pricing) matches; the decision and a per-call ordinal ride in `EffectContext.callKey`
 * (`decide:<decisionId>:<n>`). The principal is NOT a parameter: the scope is the
 * only identity-bearing handle flow code receives, and it is pre-stamped.
 *
 * Limits, by design (the call is transient):
 *  - Budget ADMISSION applies (the scope passes the execution's running totals), but
 *    the CHARGE is dropped by the no-op `emit`: a decider's spend is invisible to the
 *    budget, so loop-bound it yourself.
 *  - A denial (`CapabilityDeniedError`, `EFFECT_DENIED`) is NOT durable: the denial
 *    event goes to the no-op sink, so a decider that catches it leaves no trace in
 *    the log. Let it propagate to fail the execution (nothing is recorded either way).
 *  - The scope is valid only while the decider runs; a call after it settles throws,
 *    and a call still in flight when it settles is aborted.
 */
export interface DecideScope {
  invokeTransient<TIn = unknown, TOut = unknown>(
    toolId: string,
    input: TIn,
    opts?: {
      readonly signal?: AbortSignal;
      /**
       * ADR 0119 — live deltas from a streaming effect (`createLlmEffect({ stream: true })`
       * / `createAgentModelEffect`), delivered to THIS call's sink only. The call is governed
       * exactly as without it (authz, middleware, taint, budget admission, kill switch,
       * cancellation, reach). Live-only: never journaled (the decision records the decider's
       * return), silent on replay. Each text `delta` is a TAINTED string (ADR 0085; unwrap to
       * display); a `reset` chunk precedes a retried attempt; the terminal `done` chunk is sent
       * only after the call succeeded. Synchronous, fire-and-forget; a throw is swallowed and
       * warned. Refused (no deltas, the call still completes) when an output validator in the
       * middleware chain has no delta form.
       */
      readonly onDelta?: DeltaSink;
    }
  ): Promise<TOut>;
}

/**
 * Options for {@link ExecutionContext.decide}. Shared by the interface and the impl so
 * the two cannot drift. `rationale`/`source` are provenance; the rest are the ADR 0030
 * D1 materialization fields — DESCRIPTIVE metadata recorded alongside the choice but
 * never read back on replay (getDecision returns just `choice`), so P9 is untouched.
 *
 * Read at COMMIT, after the decider settles (except `estimatedCost`, validated up front), so a
 * decider may fill fields in; see {@link ExecutionContext.decide}.
 */
export interface DecideOptions {
  rationale?: unknown;
  source?: string;
  /** The other choices considered, for "why did it pick X over Y" explainability. */
  alternatives?: unknown;
  /** Advisory predicted cost of the chosen alternative, in USD. */
  estimatedCostUsd?: number;
  /**
   * ADR 0115 — the open spelling of {@link DecideOptions.estimatedCostUsd}: a predicted cost per
   * dimension name (`{ gpu_seconds: 3, credits: 2 }`). Descriptive only, like every D1 field
   * (never a replay input). At most 32 names, each matching the metering-dimension pattern,
   * values finite and non-negative; anything else is refused before the decision is recorded.
   */
  estimatedCost?: { readonly [dimension: string]: number };
  /** Advisory predicted latency of the chosen alternative, in ms. */
  estimatedLatencyMs?: number;
  /** Confidence in the choice (convention: 0–1). */
  confidence?: number;
  /**
   * ADR 0079 — the OBSERVATION the decider saw: the features a policy keyed its
   * choice on. Without it the log records only `(action, reward)` and the most
   * anything can learn is a global per-key mean; with it the log is a genuine
   * `(state, action)` dataset and a CONTEXTUAL policy becomes learnable offline.
   *
   * Descriptive like every other D1 field — folded verbatim, never read back by
   * `getDecision`, so `choice` remains the sole replay input (P9 untouched).
   * Keep it small and JSON-serializable: it is written to the durable log on
   * every decision.
   */
  context?: Record<string, unknown>;
  /**
   * ADR 0079 — WHICH policy produced the choice, and how likely it was to.
   * `propensity` (the probability this policy assigned the chosen action) is what
   * makes unbiased off-policy evaluation possible later; it cannot be
   * reconstructed after the fact, so an exploring policy must log it at decision
   * time or its data is only ever usable for agreement counting.
   */
  policy?: DecisionPolicyStamp;
}

/** Provenance for a policy-produced decision (ADR 0079). */
export interface DecisionPolicyStamp {
  id: string;
  version: string;
  /** P(chosen action | context) under the policy that chose it. Convention: (0,1]. */
  propensity?: number;
}

/**
 * The branches of the explicit-result form `ctx.parallel<Outcome[]>(...)`. Not inferable (`NoInfer`): with no
 * type argument written `TResults` falls to `unknown[]` and this is `never`, so an inferred call can only take
 * the checked overload. A step's declared input is NOT checked here.
 */
export type ExplicitParallelBranches<TResults extends unknown[]> = NoInfer<
  unknown[] extends TResults
    ? never
    : {
        [K in keyof TResults]: // biome-ignore lint/suspicious/noExplicitAny: the explicit-result form does not relate input to value
          | readonly [StepDefinition<any, TResults[K]>, unknown]
          | ((branch: BranchContext) => Promise<TResults[K]>);
      }
>;

/** One `ctx.parallel` branch: a `[step, input]` pair, or a function that runs a sub-flow in the scope. */
export type ParallelBranch =
  // biome-ignore lint/suspicious/noExplicitAny: the input type is matched per branch by `CheckedBranch`
  readonly [StepDefinition<any, unknown>, unknown] | ((branch: BranchContext) => Promise<unknown>);

/** A pair's input must be the step's input type; a function branch is unconstrained. */
export type CheckedBranch<T> = T extends readonly [StepDefinition<infer I, infer O>, unknown]
  ? readonly [StepDefinition<I, O>, I]
  : T;

/** The result tuple of `ctx.parallel`: each branch's output, in input order. */
export type ParallelResults<B extends readonly ParallelBranch[]> = {
  -readonly [K in keyof B]: B[K] extends readonly [
    // biome-ignore lint/suspicious/noExplicitAny: only the output is read
    StepDefinition<any, infer O>,
    unknown,
  ]
    ? O
    : B[K] extends (branch: BranchContext) => Promise<infer O>
      ? O
      : never;
};

/** Options for {@link ExecutionContext.parallel} (ADR 0112). */
export interface ParallelOptions {
  /** Bounded concurrency; omit for unbounded. Results are always in input order. */
  limit?: number;
  /** Abort the scope on the first real branch failure. Default `true`. */
  failFast?: boolean;
  /** What a park does to siblings still running: let them `"drain"` (default) or `"abort"` them first. */
  onPark?: "drain" | "abort";
}

/** One arm of {@link ExecutionContext.select} (ADR 0110 D2). */
export type SelectArm =
  /** A resume answers it: `runtime.resume(id, { eventType: gate, waitId?, payload })`. */
  | { gate: string; viewDigest?: string; correlationKey?: string }
  /** The next message on this inbox topic. */
  | { inbox: string }
  /** A durable timer: `afterMs` (relative to first registration) or `at` (epoch ms). */
  | { timer: { afterMs: number } | { at: number } };

/** What a settled `select` resolves with. */
export interface SelectResult<T = unknown> {
  /** Index of the arm that won. */
  arm: number;
  kind: "gate" | "inbox" | "timer";
  /** The gate's resume payload; the (tainted) message payload; or `{ wakeAt }` for a timer. */
  value: T;
}

/**
 * The context a `parallel` branch function receives (ADR 0112): the same execution context, whose
 * steps belong to the branch's cancellation scope, plus the scope's deterministic identity
 * (`"<parent>/<k>.<branch>"`, `""` at the root; a pure function of the flow's control flow).
 */
export interface BranchContext extends ExecutionContext {
  readonly scopePath: string;
}

// Loom 2.0: the execution-facing context. `execute` is the generalized durable
// primitive (any task kind); `run` is the step-shaped alias kept for source
// compatibility and the simplest path. `WorkflowContext` remains an alias below.
export interface ExecutionContext extends ExecutionContextExtensions {
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
  //
  // ADR 0113 — the record lists the steps the decider ran (`innerSteps`), so a re-run that serves it
  // knows those recorded frames will never be asked for. A decider MUST AWAIT every step it runs:
  // one it detaches and finishes after returning is not in the record, and the replay-divergence
  // detector will then report that step as skipped when the decision is served.
  //
  // `opts` is read when DECISION_RECORDED is committed, AFTER the decider settles (only
  // `estimatedCost` is validated before it runs), so a decider may fill in fields of the object
  // it was handed, e.g. a `policy` stamp that needs the propensity of the policy it consulted
  // (`@loom/learning`'s decideWithPolicy / decideWithRollout rely on this). A served decision
  // reads no `opts` at all. Pinned by DecisionSeam.test.ts ("opts are read at commit").
  decide<T = unknown>(
    decisionId: string,
    decider: (scope: DecideScope) => T | Promise<T>,
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

  /**
   * Run branches concurrently as ONE CANCELLATION SCOPE (ADR 0112). A branch is a
   * `[step, input]` pair or a function `(b: BranchContext) => Promise<T>` (a sub-flow whose
   * steps all belong to the scope). Results come back in input order.
   *
   * Needs `kernel.features.scopes` (default off: `parallel` is then the pre-R6 bounded
   * `Promise.all`). With `failFast` (default `true`) the first real branch failure aborts the
   * scope: in-flight steps see it on their `signal` and record `STEP_CANCELLED`, queued branches
   * never start, and the outcome is journaled as `PARALLEL_COMPLETED` so a re-run serves it
   * exactly (the branches the first run launched, the gate answers it consumed). The call throws
   * ONE value on the first run and every re-run, rebuilt from the record: a `TypedFailure` stays
   * typed, a class in `errorClasses` (or the built-in `Error` family) is rebuilt from its message,
   * anything else is a `ParallelScopeFailedError`. Inside a branch, code that catches a step's
   * error sees the effect's error on the first run but a `ScopeServedError` on a replay: rethrow it
   * or use typed failures.
   *
   * A park (`SuspendError`) in one branch is NOT a failure: it is a barrier. New step starts are
   * frozen, in-flight siblings drain (or, with `onPark: "abort"`, are aborted first) within
   * `parkDrainMs`, and no sibling event follows `EXECUTION_SUSPENDED`.
   */
  parallel<const B extends readonly ParallelBranch[]>(
    branches: B & { readonly [K in keyof B]: CheckedBranch<B[K]> },
    options?: ParallelOptions
  ): Promise<ParallelResults<B>>;
  /**
   * The result tuple named explicitly (`ctx.parallel<Outcome[]>(branches)`). Only reachable with the
   * type argument written: an inferred call always takes the overload above, which checks each
   * step's input against its value. Here a step's declared input is NOT checked (`any`).
   */
  parallel<TResults extends unknown[]>(
    branches: ExplicitParallelBranches<TResults>,
    options?: ParallelOptions
  ): Promise<TResults>;

  /**
   * Park the execution durably until a matching resume arrives.
   *
   * The type parameter names the payload the gate delivers. It defaults to `never` — which is
   * assignable to anything, so every existing call site is unchanged — but naming it removes
   * the `as unknown as T` cast that every gate otherwise needs:
   *
   * ```ts
   * const ApprovalDecision = z.object({ approved: z.boolean(), approvedBy: z.string() });
   * type ApprovalDecision = z.infer<typeof ApprovalDecision>;
   *
   * const decision = await ctx.suspend<ApprovalDecision>({ on: "ApprovalGranted" });
   * ```
   *
   * The type argument is a CLAIM, not a check — it is erased at runtime. Pair it with the same
   * schema in `flow$({ resumeSchemas })` (ADR 0077) so the runtime actually parses the payload
   * before appending it; then the static type and the enforced contract share one declaration.
   */
  suspend<T = never>(config: SuspendConfig): Promise<T>;

  /**
   * ADR 0110 — wait for the next message on `topic` of this execution's durable inbox (written by
   * `runtime.send`). A REGISTERING wait: it returns a pending promise and records the wait with
   * the current scope; the runtime parks the execution when the flow is quiescent (every live
   * branch blocked on a registered wait, nothing in flight) and a message wakes it. The payload is
   * delivered TAINTED (`inbox:<topic>`, ADR 0085): refused in a prompt instruction position
   * unless a step explicitly unwraps it. Delivery is FIFO per topic and exactly once (the
   * consumption is a journaled `MESSAGE_CONSUMED`); replay returns the recorded message and never
   * reads the inbox. Needs `kernel.features.inbox`. `ctx.suspend` is unchanged.
   */
  receive<T = unknown>(topic: string): Promise<T>;

  /**
   * ADR 0110 — wait for the FIRST of several sources: a gate (answered by `resume`, ADR 0117's
   * `viewDigest` binding preserved), an inbox topic, a timer. Resolves `{ arm, kind, value }`
   * (`arm` = the index in `arms`). The first answered arm settles the select; a later answer to a
   * sibling arm is refused (`wait-settled`). Timer wakes are recorded once, at first
   * registration. Arms are numbered deterministically (`<scopePath>#<ordinal>` per arm); a body
   * edit that shifts an ordinal raises `FlowDivergenceError` instead of mis-delivering.
   */
  select<T = unknown>(arms: readonly SelectArm[]): Promise<SelectResult<T>>;

  /**
   * ADR 0109 — end this execution and start its SUCCESSOR with `carry` as its input; NEVER returns
   * (`return ctx.continueAsNew({ summary, turn: 0 })`). The successor is a fresh execution on the
   * code registered now, in the same chain (`chainId`, `generation + 1`, id `<chainId>~<n>`); it
   * inherits the principal, the tenant, the running resource totals, the inbox cursors and dedupe
   * window and the chain's absolute deadline, and nothing of the fold (frames, decisions, resume
   * payloads, outcomes), which is the point: history stays bounded. Legal only when the execution
   * is running, outside any open `parallel` scope, with no outstanding `receive` / `select`
   * wait, and once every step still in flight has settled (bounded by `parkDrainMs`); otherwise
   * it throws {@link ContinueAsNewRefusedError} and appends nothing. A carry over `maxCarryBytes`
   * (default 1 MiB) throws {@link CarryTooLargeError}. There is no `shouldContinueAsNew()`: count
   * your own turns (`@loom/agent`'s `continueEvery(n)`). Needs `kernel.features.continueAsNew`.
   *
   * The predecessor's handle resolves `waitForCompletion()` with its own state (status `continued`,
   * `variables._continuedTo` names the successor) and never resolves `waitForSuspend()`; follow the
   * chain with `runtime.followToHead(id)`. A tainted value in the carry stays tainted.
   */
  continueAsNew(carry?: unknown): Promise<never>;

  // T1 — durable sleep (ABI 1.1.0). The execution suspends with the absolute
  // wake time recorded in the log; a wired TimerService fires the wake as a
  // durable TIMER_FIRED resume, surviving restarts and replaying
  // deterministically (the scheduled time is in the log — wall-clock drift
  // never enters the fold). `ms` and `sleepUntil`'s absolute `wakeAt` are measured on the
  // runtime clock (`WorkflowRuntimeDeps.now`), not wall time. Without a timer service the suspension is still
  // durable and can be resumed manually (or by any node's service).
  sleep(ms: number): Promise<void>;
  sleepUntil(wakeAt: number): Promise<void>;

  // Append a durable domain event, ONCE per execution (ADR 0102): a re-run from the
  // top serves an emit from the log only when the log proves it: a stamped emit of the
  // same content in the same gate segment, with every syscall of the segment so far
  // served. Otherwise it is appended (ADR 0102 D2 states the exact guarantee).
  emit(eventType: string, payload: unknown): void;

  // An `emit` of `{ delta, done }` — the same once-per-execution rule.
  stream(eventType: string, delta: string, done?: boolean): void;

  // `ctx.ui` (agent-surface) is NOT declared here (ADR 0114): `@loom/agent-surface` merges
  // `readonly ui: SurfaceEmitter` into `ExecutionContextExtensions` below, so it type-checks
  // wherever that package is in the program and nowhere else. New code spells it `surface(ctx)`.
}

/**
 * Types owned by packages ABOVE the kernel, merged into `ExecutionContext` by declaration
 * merging (ADR 0114). Empty in the kernel on purpose: the kernel names no UI vocabulary.
 * `@loom/agent-surface` adds `ui`.
 */
// biome-ignore lint/suspicious/noEmptyInterface: the extension point is the empty interface.
export interface ExecutionContextExtensions {}

// Back-compat alias. Existing code importing `WorkflowContext` keeps working; the
// two are identical types. New code should prefer `ExecutionContext`.
export type WorkflowContext = ExecutionContext;

/** The built-in resource dimensions (ADR 0032): top-level fields of the `_resources` fold. */
export type BuiltinDimension = "tokens" | "costUsd" | "ms" | "memBytes" | "wallMs" | "netBytes";

/**
 * A negotiable/metered resource dimension (ADR 0032, opened by ADR 0115). The six built-ins, or
 * any name matching `/^[a-z][a-z0-9._-]{0,63}$/` (`gpu_seconds`, `credits`): a custom name is
 * metered through `RESOURCE_METERED.custom` and read from `_resources.custom`. The kernel
 * assigns no unit and no price.
 */
export type ResourceDimension = BuiltinDimension | (string & {});

export interface RunOptions {
  /**
   * A caller-chosen execution id (default: a fresh ULID).
   *
   * ADR 0103 — when you choose the id, `start()` is START-ONCE for it: the bootstrap
   * `EXECUTION_STARTED` is made durable BEFORE the flow body runs, so if an execution with
   * this id already exists `start()` rejects with `ExecutionAlreadyExistsError` and nothing
   * runs — no effect, no fold, no `onEvent`. Derive the id from the trigger (a schedule
   * occurrence, a message id, an idempotency key) and catch the error to treat a duplicate
   * delivery as "already started". The cost is one awaited append before the body, paid
   * only on this path; a minted ULID cannot collide and keeps the barrier-free path.
   * Any other failure of that append rejects `start()` with `StorageWriteError`.
   */
  executionId?: string;
  /**
   * #392 — the compute lane this execution belongs in, recorded on its `EXECUTION_STARTED`
   * anchor so anything that wakes it LATER can find it.
   *
   * Placement was otherwise ephemeral: `ExecutionPolicy` is a caller-side struct mapped to
   * `DispatchMetadata` at dispatch time, so it lived in the memory of the process that
   * dispatched. That is invisible for an execution that runs once, and gone by the time a
   * timer or a recovery pass re-drives one that suspended for a human.
   *
   * A HINT, not a pin: it is input to a `PlacementPolicy`, which may route elsewhere — a
   * target that has since been retired must not strand the execution that named it.
   */
  computeTarget?: string;
  /**
   * K9.4 — the monotonic fencing token this dispatch holds (from
   * `EventStore.acquireFence` / `WorkflowRuntime.acquireFence`). Every event the
   * run appends carries it in `metadata.fence`; a fencing store rejects appends
   * from an older token, so a zombie predecessor of a re-dispatched execution
   * cannot write. Omit (or run against a non-fencing store) for today's behavior.
   */
  fence?: number;
  /**
   * ADR 0118 D2 (R8k) — on `resume` / `resumeAs`: answer the park at THIS sequence (what
   * `parkedAtSequence` returns) under a CONDITIONAL fence instead of `fence`.
   *
   * The runtime reads that park, takes the token it was written under (`metadata.fence`, or 0), and
   * calls `EventStore.acquireFenceIf(id, { fence, parkSeq })`: the fence is acquired only if the
   * token has not moved AND nothing has answered the park since. A `stale` answer is re-read: if the
   * execution is still parked on this same park the token moved only because someone acquired and
   * never appended (a crashed supervisor), so it retries on the token the store returned (bounded,
   * 3); an answered or different park is a `ResumeRefusedError` `not-suspended` with nothing
   * appended; exhaustion is a {@link ResumeContendedError} (retryable), never `not-suspended`. The
   * park is re-checked (`assertResumable`) under the acquired fence.
   *
   * Takes precedence over `fence`. On a store without `acquireFenceIf` it falls back to the
   * unconditional `acquireFence` (and its documented residual: a rival's acquire may supersede an
   * already-running body); on one without fencing it is ignored.
   */
  fenceIfParkedAt?: number;
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
   * K12.1 — the authenticated principal chain, established at the trust boundary (start /
   * resume API / A2A server).
   *
   * R3k (ADR 0111): on `start` this is the principal the execution will OWN — its bounded
   * identity (and a restorable delegation) is recorded on `EXECUTION_STARTED`, and every effect
   * of the execution, on every later path, runs as that recorded owner. On `resume`, `resumeAs`,
   * `restoreFromState`, `cancel`, `fork` and `loadState` it is only the LIFECYCLE CALLER: who may
   * perform the op (`ExecutionAuthorizer`) and who answered an approval
   * (`ResumeAuthenticator.verify`). It does not become the effect principal; that is the
   * owner's. (A log that predates EVENT_SCHEMA 1.23.0 recorded none and keeps the old
   * behaviour: the caller's principal reaches the effects.) Undefined ⇒ no principal.
   */
  principal?: PrincipalChain;
  /**
   * R3 — the kernel-internal system grant (see {@link WorkflowRuntime.systemOptions}). Compared
   * by identity against the runtime's own; anything else is ignored. Not a principal.
   */
  system?: SystemGrant;
  /**
   * R3 — the execution that spawned this one (the child supervisor sets it). Recorded on sequence
   * 0 as `parent` ONLY when trusted — the call carries the runtime's lineage or system grant — in
   * every mode, with or without an authorizer; omitted otherwise (a caller-supplied one is
   * dropped, so a non-supervisor caller passing it gets no parent recorded). Always reported on
   * {@link ExecutionAuthorizer.committed} so a policy can inherit the owner.
   */
  parentExecutionId?: string;
  /**
   * R3k round 2 (ADR 0111 D6) — the runtime's LINEAGE grant (see {@link WorkflowRuntime.lineageOptions}).
   * Compared by identity against the runtime's own; anything else is ignored. It authorizes ONE
   * thing: that `parentExecutionId` is written to the execution's log as its `parent`. It bypasses
   * no authorizer and is not a principal.
   */
  lineage?: LineageGrant;
}

/**
 * R3k round 2 — opaque, identity-compared token the child supervisor presents so the `parent` it
 * names is RECORDED. Narrower than {@link SystemGrant} (which bypasses the authorizer and gates
 * the timer wake); held by the runtime in every mode, handed out only by `lineageOptions()`.
 */
export interface LineageGrant {
  readonly __loomLineageGrant: true;
}

/** R3 — opaque, identity-compared capability held by kernel-internal callers. Not forgeable by copy. */
export interface SystemGrant {
  readonly __loomSystemGrant: true;
}

// ── C.1 — execution-lifecycle authorization ──────────────────────────────────
//
// K2's CapabilityAuthorizer gates EFFECTS inside a running execution. This gates the
// execution LIFECYCLE itself — who may start / resume / cancel / query an execution —
// one level up, using the principal already threaded from the trust boundary
// (RunOptions.principal). It is pluggable and OPT-IN: unset ⇒ every operation is
// permitted, byte-identically (G2). A denied resume/cancel additionally records a
// durable EXECUTION_DENIED audit fact (symmetric to EFFECT_DENIED); a denied
// start/query has no execution to append to and only throws.

/** The execution-lifecycle operations an {@link ExecutionAuthorizer} can gate. */
export type ExecutionOp =
  | "start"
  | "resume"
  | "cancel"
  | "query"
  | "actAsOwner"
  | "send"
  | "annotate"
  | "discard"
  | "quarantine"
  | "release";
// `"actAsOwner"` (ADR 0111 D7) authorizes `fork(…, { actAs: "owner" })` on the PARENT: the fork
// then runs the owner's remaining effects under the owner's grants instead of the forker's.
// `"send"` (ADR 0110 D1) authorizes `runtime.send`, the only writer of an execution's inbox.
// `"annotate"` (ADR 0116) authorizes `runtime.recordOutcome`, a late reward on a FINISHED execution.
// `"quarantine"` / `"release"` (ADR 0130 residuals D9, RESERVED: type-only, no caller yet) will authorize
// `quarantineInbox` and `releaseInbox("deliver")`; a `"discard"` disposition is judged as `"discard"`.
// Both are closed by default in `executionAccessPolicy`, like `"discard"`.
// `"discard"` (ADR 0110 amendment) authorizes `runtime.discardInbox`, an operator's journaled skip of
// unconsumed inbox messages: it destroys messages a sender was told were accepted, so it is closed by
// default (`executionAccessPolicy` maps it to `"deny"`) and an integrator opens it for its operators.

export interface ExecutionAuthzRequest {
  op: ExecutionOp;
  executionId: string;
  workflowId: string;
  principal?: PrincipalChain;
  /**
   * R3k (ADR 0111 D5) — who OWNS the execution, read by the kernel from sequence 0 of its own
   * log (a fork's owner is the forker). Present for an op on an execution that already exists and
   * recorded a principal; absent for a `start`, for a legacy log (started before EVENT_SCHEMA
   * 1.23.0), for an anonymous start, and when the record was shredded or cannot be restored — the
   * policy's `unknownOwner` rule then applies.
   */
  owner?: { tenant?: string; actor?: string; onBehalfOf?: string };
  /**
   * R3k rounds 2-3 (ADR 0111 D6) — the NEAREST recorded owner up the execution's trusted lineage:
   * present whenever the execution's recorded `parent` (written only at a trusted start) leads to
   * one, for a principal-less child AND for an identified/delegated one (whose own `owner` is its
   * child id). The kernel walks at most 8 hops, cycle-safe; a chain that ends without an owner, or
   * is longer, yields none; a shredded/unrestorable record gets none. It scopes who may run
   * LIFECYCLE ops (query/cancel/resume, never `actAsOwner`) on the child; the child's own effects
   * stay anonymous or under its attenuated delegation. An authorizer that ignores it is unaffected.
   */
  parentOwner?: { tenant?: string; actor?: string; onBehalfOf?: string };
  /**
   * R3 — on a {@link ExecutionAuthorizer.committed} notification only: the execution whose
   * supervisor/forker started this one (a child workflow, a fork), when the runtime knows it. A
   * policy may inherit the parent's owner for a start that carries no principal of its own.
   */
  parentExecutionId?: string;
}

export type ExecutionAuthzVerdict = { allowed: true } | { allowed: false; reason?: string };

/**
 * Gates execution-lifecycle operations. Consulted (when configured) at the entry of
 * `start`/`resume`/`cancel` and the public `loadState` (query). The policy decides how
 * to treat a missing principal.
 */
export interface ExecutionAuthorizer {
  authorize(request: ExecutionAuthzRequest): ExecutionAuthzVerdict;
  /**
   * R3 — called once a `start` (or the child of a `fork`) is DURABLE: the bootstrap
   * `EXECUTION_STARTED` is written, so the id is this caller's. `authorize("start")` is called
   * BEFORE that and can still be followed by a refusal (a duplicate id, invalid input, a
   * storage error), so a policy that records ownership must do it here, never in `authorize` —
   * otherwise a refused start still takes the id. Called for every committed start, with or
   * without a principal (a system-started execution has none, or inherits `parentExecutionId`).
   * Synchronous; a throw is swallowed (the start has already happened).
   */
  committed?(request: ExecutionAuthzRequest): void;
}

/**
 * The abort reason of a cancelled execution when the canceller supplied no `Error` of
 * its own. `name` is set explicitly (minifier-proof) so any consumer, including one
 * that cannot import this package, can classify a cancellation as
 * `err.name === "ExecutionCancelledError"` without matching message text. A caller that
 * passes its OWN `Error` as the cancel reason keeps it: it is thrown as-is, never wrapped.
 * `reason` carries the caller's non-Error reason (a string, say), if any. `kind` tells an
 * operator/API cancel (`"cancel"`) from a kernel-driven execution-deadline breach
 * (`"deadline"`) without matching message text; the `name` is the same for both, so a
 * consumer classifying by name treats them alike.
 */
export class ExecutionCancelledError extends Error {
  constructor(
    message = "execution cancelled",
    readonly reason?: unknown,
    readonly kind: "cancel" | "deadline" = "cancel"
  ) {
    super(message);
    this.name = "ExecutionCancelledError";
    Object.setPrototypeOf(this, ExecutionCancelledError.prototype);
  }
}

/**
 * Raised by a `ctx.decide` decider's scope after the decider has settled: it is both the
 * rejection of a late `invokeTransient` and the abort reason of any call the decider
 * started and never awaited. Named for the same reason as {@link ExecutionCancelledError}.
 */
export class DecideScopeClosedError extends Error {
  constructor(
    readonly decisionId: string,
    message?: string
  ) {
    super(message ?? `decide("${decisionId}"): decider settled`);
    this.name = "DecideScopeClosedError";
    Object.setPrototypeOf(this, DecideScopeClosedError.prototype);
  }
}

/** Thrown when an {@link ExecutionAuthorizer} refuses a lifecycle operation. */
export class ExecutionDeniedError extends Error {
  constructor(
    readonly op: ExecutionOp,
    readonly executionId: string,
    readonly reason?: string
  ) {
    super(
      `execution operation "${op}" on "${executionId}" denied${reason !== undefined ? `: ${reason}` : ""}`
    );
    this.name = "ExecutionDeniedError";
    Object.setPrototypeOf(this, ExecutionDeniedError.prototype);
  }
}

/**
 * K12.2 — verifies a resume event that gates authority (an approval), so
 * "who approved" is EVIDENCE, not an unverified claim. Pluggable at the trust
 * boundary. `verify` returns:
 *  - `verified` → an `APPROVAL_GRANTED { actor, verifiedBy }` fact is recorded
 *    and the resume proceeds;
 *  - `rejected` → the resume is REFUSED (a forged approval does not resume);
 *  - `not-applicable` → an ordinary resume, no approval semantics.
 *
 * A verification MUST cover the WHOLE event it is handed, not just `payload`. In particular
 * `ResumeEvent.discardLegacyAnswers` (ADR 0104) is honoured only on a `verified` event: it
 * decides what a pre-0104 human step accepts as its approval, so an authenticator that signs
 * `payload` alone would let a caller attach or alter the override under a valid signature.
 * Reject (or return `not-applicable` for) an event whose override your signature does not
 * cover.
 */
export interface ResumeAuthenticator {
  /**
   * `context` (R13, additive and optional) tells a verifier WHICH park this event answers, so a
   * signature can be single-use: the execution, the sequence of the parking
   * `EXECUTION_SUSPENDED`, and the principal the call arrived with. An authenticator that
   * predates it ignores the argument and behaves exactly as before.
   */
  verify(event: ResumeEvent, context?: ResumeVerificationContext): ResumeVerdict;
}

/**
 * R13 (ADR 0117) — what the runtime knows about the park a resume answers, handed to
 * {@link ResumeAuthenticator.verify}. A signature that covers `executionId` and
 * `parkedAtSequence` cannot be replayed at another execution (including a FORK of this one,
 * which has its own id), nor at a later park of the same gate in this one.
 */
export interface ResumeVerificationContext {
  readonly executionId: string;
  /**
   * Sequence of the `EXECUTION_SUSPENDED` event that parked the execution on this gate; the
   * parked state's own sequence when the log no longer holds it (compacted). `undefined` when
   * the execution is not parked.
   */
  readonly parkedAtSequence: number | undefined;
  /** The principal the resume call carried (`RunOptions.principal`), if any. */
  readonly principal: PrincipalChain | undefined;
  /**
   * ADR 0110 D4 — the wait a wait-addressed resume answers (`ResumeEvent.waitId`), and the
   * sequence of the park that LISTS it. A signature for one arm of a multi-wait park must bind
   * both, or a stale signature for arm A could answer arm B. Absent for a bare resume.
   */
  readonly waitId?: string;
  readonly waitRegisteredAtSequence?: number;
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

/**
 * ADR 0051 D7 — `start()` refused invalid input against the flow's declared
 * `inputSchema` (opt-in via `WorkflowRuntimeDeps.validateInput`). Nothing was
 * appended; no execution exists.
 */
export class InputValidationError extends Error {
  constructor(
    readonly workflowId: string,
    readonly executionId: string,
    readonly detail: string
  ) {
    super(
      `start of flow "${workflowId}" (execution "${executionId}") refused: input does not satisfy the declared inputSchema — ${detail}`
    );
    this.name = "InputValidationError";
    Object.setPrototypeOf(this, InputValidationError.prototype);
  }
}

/**
 * ADR 0103 — `start()` was given a caller-chosen `executionId` that already names an
 * execution. The bootstrap `EXECUTION_STARTED` was refused by the store at sequence 0
 * BEFORE the flow body ran: no effect was invoked, no event was folded, and `onEvent`
 * saw nothing. The existing execution is untouched.
 *
 * This is what makes `start()` start-once for a deterministic id: a caller that derives
 * the id from its trigger (a schedule occurrence, a message id, an idempotency key) and may
 * deliver it twice catches this and treats it as "already started". Drive the existing
 * execution with `resume` / `loadState` / `subscribe` by the same id.
 */
export class ExecutionAlreadyExistsError extends Error {
  constructor(
    readonly executionId: string,
    /** The store's normalized conflict (`DuplicateSequenceError` / `DuplicateEnvelopeIdError`). */
    readonly cause?: unknown
  ) {
    super(
      `start of execution "${executionId}" refused: an execution with that id already exists (its EXECUTION_STARTED is already in the log). Nothing ran; treat it as already started, or resume/read it by id.`
    );
    this.name = "ExecutionAlreadyExistsError";
    Object.setPrototypeOf(this, ExecutionAlreadyExistsError.prototype);
  }
}

/**
 * L20 — `start()`'s sequence 0 was refused on the fence twice, and sequence 0 is still absent:
 * someone acquired a newer token for this id but has written nothing under it (it may have died
 * between `acquireFence` and its bootstrap). Surfaced as the `cause` of a `StorageWriteError`.
 *
 * Deliberately NOT a `StaleFenceError`: a stale fence means "another holder owns this
 * execution", which a dispatcher settles instead of retrying — and here nobody may own it, so
 * settling would lose the start with nothing in the log for a recovery pass to find. Nothing
 * ran; retrying (a fresh `allocate` takes a newer fence) is cheap and correct. `cause` is the
 * store's `StaleFenceError`.
 */
export class StartFencedOutError extends Error {
  constructor(
    readonly executionId: string,
    readonly cause?: unknown
  ) {
    super(
      `start of execution "${executionId}" was fenced out by a newer token whose holder has not written sequence 0; nothing ran — retry the start`
    );
    this.name = "StartFencedOutError";
    Object.setPrototypeOf(this, StartFencedOutError.prototype);
  }
}

export { SnapshotIdentityMismatchError } from "@loom/snapshot-runtime";

/**
 * ADR 0107 — `fork()` refused a fork point it cannot serve exactly, because compaction removed
 * history below it. Nothing was written: no child events, no seed snapshot, no lineage.
 *
 * - `"compacted"`: events between the nearest snapshot and `atSequence` were compacted away, so
 *   neither the copied prefix nor the folded state would be the parent's state at that point.
 * - `"checkpoint-above-prefix"`: a snapshot sits exactly at `atSequence`, but that event was
 *   compacted away and pinned events survive below it. The child's log would carry its
 *   checkpoint above a non-bootstrap tip, the one shape ADR 0106's tip rule forbids and every
 *   log reader assumes it never sees.
 *
 * Sequence 0 is always forkable. `forkableFrom..forkableThrough` is the span every position
 * of which can be forked: from the parent's latest compaction checkpoint (or the event just
 * above it, or a branch's fork seed) to its folded tip. Both are `null` when no snapshot
 * anchors the history above the compacted prefix.
 */
export class CompactedForkPointError extends Error {
  constructor(
    readonly executionId: string,
    readonly atSequence: number,
    readonly reason: "compacted" | "checkpoint-above-prefix",
    readonly forkableFrom: number | null,
    /** The parent's folded tip: the highest forkable sequence (null with `forkableFrom`). */
    readonly forkableThrough: number | null = null
  ) {
    const span =
      forkableFrom === null
        ? ""
        : forkableThrough === null || forkableThrough === forkableFrom
          ? `at ${forkableFrom}`
          : `at ${forkableFrom}..${forkableThrough}`;
    const where =
      forkableFrom === null
        ? "Only sequence 0 can be forked: no snapshot anchors the history above the compacted prefix."
        : forkableFrom === 0
          ? `Fork ${span}.`
          : `Fork at 0, or ${span}.`;
    super(
      reason === "compacted"
        ? `fork("${executionId}", ${atSequence}) refused: ${atSequence} is inside compacted history — events below it were compacted away and no snapshot between them and ${atSequence} anchors the fold, so the copied prefix and the forked state would both be wrong. ${where}`
        : `fork("${executionId}", ${atSequence}) refused: a snapshot holds the state at ${atSequence}, but event ${atSequence} was compacted away and pinned events survive below it — the child's log would carry its checkpoint above a non-bootstrap tip, a shape the tip rule (ADR 0106) forbids. ${where}`
    );
    this.name = "CompactedForkPointError";
    Object.setPrototypeOf(this, CompactedForkPointError.prototype);
  }
}

/**
 * TR (ADR 0077) — `resume()`/`resumeAs()` refused a payload that does not satisfy
 * the flow's declared `resumeSchemas` entry for that gate. Nothing was appended;
 * the execution is untouched and still suspended, so a corrected payload can be
 * sent. This is the shape counterpart to {@link ApprovalRejectedError}, which
 * gates WHO may resume rather than WHAT they may send.
 */
export class ResumePayloadValidationError extends Error {
  constructor(
    readonly executionId: string,
    readonly eventType: string,
    readonly detail: string
  ) {
    super(
      `resume of execution "${executionId}" refused: payload for gate "${eventType}" does not satisfy the flow's declared resumeSchemas entry — ${detail}`
    );
    this.name = "ResumePayloadValidationError";
    Object.setPrototypeOf(this, ResumePayloadValidationError.prototype);
  }
}

/**
 * Why a resume was refused before anything was appended. Machine-readable so a
 * caller can tell a RETRIABLE refusal from a permanent one without matching on
 * message text — `not-suspended` is the only one worth retrying WITH THE SAME EVENT
 * (a suspend that has not become readable yet on an async store), and
 * `@loom/orchestration` does exactly that when a child outruns its parent's suspend.
 * `null-answer-after-parked-failure` is recoverable only with a DIFFERENT event: a
 * non-null answer to the same gate.
 */
export type ResumeRefusalReason =
  /** The event type names a kernel event, which only the kernel may write. */
  | "kernel-event-type"
  /** The execution is not parked at a gate (already running, terminal, …). */
  | "not-suspended"
  /** The event type is not the gate the execution is parked on. */
  | "gate-mismatch"
  /**
   * ADR 0104 — a pre-0104 log in which an open human step's answer cannot be told apart from
   * another recorded answer (the old kernel re-parked it after an answer, or an unspent stray
   * precedes it). Guessing would hand a later gate an approval nobody gave it, so the kernel
   * refuses; nothing is appended. Not retriable: cancel the execution and start it again.
   */
  | "ambiguous-legacy-answers"
  /**
   * ADR 0105 — a `null` answer to a gate a parallel step failed on while it was parked. The
   * fold records such a `null` as status-only (fail-closed: `_failedWhileParked`), so it would
   * not answer the gate; rather than silently re-parking, the kernel refuses it and appends
   * nothing. Retriable: resume with a non-null answer.
   */
  | "null-answer-after-parked-failure"
  /**
   * R13 (ADR 0117) — the gate declared a `viewDigest` (a digest of the proposal the approver is
   * asked to approve) and the resume did not echo THAT digest: it echoed an older proposal's, or
   * none. The approver was shown something other than what is now parked. Nothing was appended;
   * re-read the parked state, show the approver the current proposal, and resume with
   * `answerApproval(state, decision)`.
   */
  | "view-digest-mismatch"
  /**
   * R13 — `TIMER_FIRED` is the kernel's own wake, raised by the `TimerService` under the
   * runtime's system grant. On a runtime that fails closed (`security.strict`) a caller without
   * that grant is refused: a caller-supplied `TIMER_FIRED` would otherwise answer ANY timed
   * gate, approval gates included, past the digest check and the authenticator.
   */
  | "timer-wake-not-system"
  /**
   * ADR 0110 D4 — the park lists SEVERAL gate waits that this event name answers and the resume
   * did not say which (`ResumeEvent.waitId`). Nothing was appended; name the wait.
   */
  | "ambiguous-wait"
  /**
   * ADR 0110 D4 — the wait this resume addresses is not (or no longer) one of the park's: its
   * `select` was settled by another arm, or the wait never existed. A late answer to a losing arm.
   */
  | "wait-settled"
  /** ADR 0110 D1 — an inbox wait is answered by `runtime.send`, never by a resume. */
  | "inbox-wait";

/**
 * The resume ingress gate refused. Nothing was appended: the execution is
 * exactly as it was, so a corrected resume can be sent.
 *
 * This is the THIRD resume gate, beside {@link ApprovalRejectedError} (WHO may
 * resume, K12) and {@link ResumePayloadValidationError} (WHAT shape they may
 * send, ADR 0077). This one gates WHICH event may be delivered, and to an
 * execution in WHICH state — the two questions that were unasked while
 * `eventType` travelled from an ingress adapter into the log verbatim.
 */
export class ResumeRefusedError extends Error {
  constructor(
    readonly executionId: string,
    readonly eventType: string,
    readonly reason: ResumeRefusalReason,
    detail: string
  ) {
    super(`resume of execution "${executionId}" refused (${reason}): ${detail}`);
    this.name = "ResumeRefusedError";
    Object.setPrototypeOf(this, ResumeRefusedError.prototype);
  }
}

/**
 * ADR 0118 D4 — a conditional-fence resume could not take the fence: other resumers kept moving the
 * token while the park stayed unanswered (e.g. three dead acquirers in a row, or a live rival
 * contending). **Retryable**: nothing was appended and the park is still unanswered. It is NOT a
 * {@link ResumeRefusedError} (that class means "refused, final"), so a caller that treats every
 * refusal as final cannot mistake "retry me" for "no". Raised only by `fenceIfParkedAt`'s
 * exhaustion. A supervisor re-drives it with a backed-off `TimerStore` row (`kernel.features.redrive`).
 */
export class ResumeContendedError extends Error {
  readonly retryable = true as const;
  constructor(
    readonly executionId: string,
    readonly attempts: number
  ) {
    super(
      `resume of execution "${executionId}" is contended: the conditional fence stayed stale after ${attempts} attempts while the park is still unanswered. Nothing was appended; retry.`
    );
    this.name = "ResumeContendedError";
    Object.setPrototypeOf(this, ResumeContendedError.prototype);
  }
}

/**
 * K11.5 (ADR 0056) — the operator-supplied state transform threw during
 * `resumeAs`: the recorded input could not be migrated to the target flow's
 * contract. Nothing was appended; the execution is untouched. Fix the transform
 * (or the target contract) and re-run the migration.
 */
export class StateMigrationError extends Error {
  constructor(
    readonly executionId: string,
    readonly toFlowId: string,
    readonly detail: string
  ) {
    super(
      `state migration of execution "${executionId}" to flow "${toFlowId}" failed: ${detail} — nothing was appended; the execution is unchanged`
    );
    this.name = "StateMigrationError";
    Object.setPrototypeOf(this, StateMigrationError.prototype);
  }
}

export class FlowCodeMismatchError extends Error {
  constructor(
    readonly executionId: string,
    readonly workflowId: string,
    readonly recordedHash: string,
    readonly registeredHash: string,
    /** ADR 0113 D2 — `"code"` when the body fingerprint (`codeHash`) differed, not the structural hash. */
    readonly kind: "structure" | "code" = "structure"
  ) {
    super(
      kind === "code"
        ? `flow code changed under in-flight execution "${executionId}" (flow "${workflowId}"): the body fingerprint recorded at start is ${recordedHash}, registered code is ${registeredHash}. Exits: (1) PIN — deploy/register the original flow code and resume on it; (2) COMPATIBLE — if the edit is replay-compatible, add ${recordedHash} to the flow's \`compatibleWith\`; (3) MIGRATE — resumeAs; (4) DRAIN — cancel() the execution and restart it on the new code.`
        : `flow code changed under in-flight execution "${executionId}" (flow "${workflowId}"): log was recorded under ${recordedHash}, registered code is ${registeredHash}. Exits: (1) PIN — deploy/register the original flow code and resume on it; (2) MIGRATE — resume with { allowFlowCodeMismatch: true } after verifying fold-compatibility (loom deploy check / @loom/deploy-sim); (3) DRAIN — cancel() the execution and restart it on the new code.`
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

/**
 * A constructor the runtime may use to REHYDRATE an error class it only has the NAME and message
 * of (ADR 0112 D2): a fail-fast scope journals its failing error as `{ name, message }`, and both
 * the first run and every served re-run throw the value built from that record. It must be
 * deterministic and construct from the message alone (no `cause`, no other state).
 *
 * A class whose constructor is `(code, message)` (or any other shape) receives the message in the
 * WRONG slot: leave it out of the registry, and it falls back to `ParallelScopeFailedError`.
 * Constructor side effects run on every serve (once per re-run), so keep it pure.
 */
export type ErrorClassCtor = new (message: string) => Error;

/**
 * ADR 0112 D2 — what a fail-fast `parallel` scope throws when its failing error's class is
 * neither a `TypedFailure` nor registered (`WorkflowRuntimeDeps.errorClasses`, plus the built-in
 * `Error` family): the recorded message, the scope's identity, and the original class `errorName`.
 * The FIRST run and every served re-run (from the journaled `PARALLEL_COMPLETED`) throw the same.
 */
export class ParallelScopeFailedError extends Error {
  constructor(
    message: string,
    readonly scopePath: string,
    readonly failedBranch: number | undefined,
    readonly errorName?: string
  ) {
    super(message);
    this.name = "ParallelScopeFailedError";
    Object.setPrototypeOf(this, ParallelScopeFailedError.prototype);
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
  /**
   * ADR 0104 — the operator override for a pre-0104 log whose open human step's answer is
   * ambiguous (the resume is otherwise refused, `ambiguous-legacy-answers`): discard the first
   * `count` recorded entries at that step, so it takes the next one as its answer (`count: 0`
   * acknowledges that the next entry already is its answer).
   *
   * Part of the EVENT, not of the run options, because it decides what a human step accepts
   * as its approval: it is honoured only when the configured `ResumeAuthenticator` VERIFIES
   * this event — which must therefore cover this field — and never on a kernel-raised resume
   * (`EXECUTION_RECOVERED`, `TIMER_FIRED`). Recorded durably as a kernel `DECISION_RECORDED`
   * (`__loom_discard__:<stepId>`, `source: "operator"`, naming the verified actor), so every
   * replay discards the same entries. Refused when the log holds no such ambiguity for `stepId`.
   */
  discardLegacyAnswers?: { stepId: string; count: number };
  /**
   * ADR 0110 D3 — answer ONE wait of a multi-wait park (`ctx.select` / `ctx.receive`), by the
   * `waitId` the park lists (`state.suspendedOn.waits`). The kernel records it as a wait-addressed
   * `EXECUTION_RESUMED` (`{ waitId, payload }`, kernel-stamped), so the answer reaches the wait it
   * names however many siblings are parked. Omitted: the event name must match exactly one gate
   * wait (else `ambiguous-wait`). Covered by a `ResumeAuthenticator` signature.
   */
  waitId?: string;
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
  /**
   * #392 — place this branch somewhere other than its parent.
   *
   * Inheritance needs no option: the prefix copy carries the parent's anchor metadata, so a
   * branch is placed where its parent was unless told otherwise. This is the override, and
   * it is the case that matters — a simulation branch clones a dataset and backfills it,
   * which is exactly the work you do NOT want on the lane running the parent.
   */
  computeTarget?: string;
  /**
   * R3k (ADR 0111 D7) — whose authority the fork's remaining effects run under. Default: the
   * FORKER (`principal`). `"owner"` keeps the parent's owner and is a separate, default-deny
   * authorization (`ExecutionOp` `"actAsOwner"` on the parent); the log records `forkActAs`.
   */
  actAs?: "owner";
  /** R3 — the caller. Gated as `query` on the parent and `start` on the child (see `fork`). */
  principal?: PrincipalChain;
  /** R3 — the kernel-internal system grant (see `WorkflowRuntime.systemOptions`). */
  system?: SystemGrant;
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

// ── ADR 0110 — the durable inbox ─────────────────────────────────────────────

/** One message of an execution's inbox stream, as `InboxSource.read` returns it. */
export interface InboxMessage {
  /** The stream sequence: the cursor `MESSAGE_CONSUMED` advances. */
  inboxSeq: number;
  topic: string;
  /** The sender's idempotency key (`send`'s `messageId`); consumption is exactly-once per id within the dedupe window. */
  messageId: string;
  payload: unknown;
  sender: { tenant?: string; actor?: string; onBehalfOf?: string };
}

/**
 * The reader seam (ADR 0110 D1): messages of `topic` with `inboxSeq > afterSeq`, oldest first, at
 * most `limit`. A function type, not a versioned SPI, until a second implementation exists; the
 * default reads the runtime's own `EventStore`.
 */
export type InboxSource = (
  chainId: string,
  topic: string,
  afterSeq: number,
  limit: number
) => Promise<InboxMessage[]>;

/** What `runtime.send` takes (ADR 0110 D1). */
export interface SendMessage {
  topic: string;
  payload: unknown;
  /** The idempotency key; minted when omitted. A retry with the same id is consumed once. */
  messageId?: string;
}

export interface SendOptions {
  /** The authenticated sender, judged as `ExecutionOp` `"send"` against the chain head's owner. */
  principal?: PrincipalChain;
  /** The kernel-internal grant (see `WorkflowRuntime.systemOptions`). */
  system?: SystemGrant;
}

export interface SendResult {
  messageId: string;
  /** The stream sequence the message was stored at. */
  inboxSeq: number;
  /** The execution the message was addressed to after following a continuation to the head. */
  executionId: string;
}

/** What `runtime.discardInbox` takes (ADR 0110 amendment, D8). */
export interface DiscardInboxInput {
  /** The topic whose cursor advances. Other topics' messages are untouched. */
  topic: string;
  /**
   * Skip every unconsumed message of `topic` with `inboxSeq <= throughSeq`. At most the stream's
   * current head: an operator discards what exists, never a sequence a future message will take.
   */
  throughSeq: number;
  /** Free text for the audit trail (journaled, at most 256 characters). */
  reason?: string;
}

export interface DiscardInboxOptions {
  /**
   * The authenticated operator, judged as `ExecutionOp` `"discard"` against the chain head's owner.
   * REQUIRED at runtime: a call without one is refused with `ExecutionDeniedError` (a discard is an
   * operator action; the system grant does not stand in for one). Optional in the type only so the
   * refusal is typed rather than a compile error for an untyped caller.
   */
  principal?: PrincipalChain;
  /** The kernel-internal grant (see `WorkflowRuntime.systemOptions`); does NOT replace `principal`. */
  system?: SystemGrant;
}

/**
 * What {@link WorkflowRuntime.expireInbox} reports (ADR 0110 amendment, D10a): `done` (a pass ran;
 * `expired` messages were discarded), `not-parked` (the owner is running: keep the row and retry),
 * `contended` (the owner's fence kept moving: retry), `closed` (the chain is finished or unknown:
 * retire the row) or `off` (no TTL is configured).
 */
export interface InboxExpiryResult {
  status: "done" | "not-parked" | "contended" | "closed" | "off";
  expired: number;
  /** The chain head the pass ran against (`done` only). */
  executionId?: string;
  /**
   * Whether the chain still has an unconsumed message under a TTL (one to expire now or later). A
   * `not-parked` / `contended` pass with `pending: false` has nothing to retry: the caller retires
   * its row instead of re-arming it forever.
   */
  pending?: boolean;
}

export interface DiscardInboxResult {
  /** The execution the discard was journaled in (the chain's head). */
  executionId: string;
  topic: string;
  /** How many messages the journaled cursor advance skipped (`0`: nothing to do, nothing appended). */
  skipped: number;
  /** The topic's cursor after the call. */
  cursor: number;
}

/**
 * `discardInbox` refused with nothing appended. `reason` is stable:
 * - `not-parked`: the owner is running (or resumed while the discard was in flight). The discard is a
 *   fact in the OWNER's log, which only a parked owner can accept without racing its own appends;
 *   retry once it parks. `retryable`.
 * - `contended`: the fence kept moving. `retryable`.
 * - `invalid`: a bad topic, a negative or non-integer `throughSeq`, or one beyond the stream's head.
 */
export class InboxDiscardRefusedError extends Error {
  constructor(
    readonly executionId: string,
    readonly reason: "not-parked" | "contended" | "invalid",
    detail: string
  ) {
    super(
      `discardInbox on execution "${executionId}" refused (${reason}): ${detail} Nothing was appended.`
    );
    this.name = "InboxDiscardRefusedError";
    Object.setPrototypeOf(this, InboxDiscardRefusedError.prototype);
  }
  get retryable(): boolean {
    return this.reason !== "invalid";
  }
}

/** ADR 0116 — a late reward for a decision of a FINISHED execution. */
export interface RecordOutcomeInput {
  /** The `ctx.decide` decision the reward is for; it must exist in the execution's fold. */
  decisionId: string;
  /** What was chosen / what is being scored (the same `key` an in-run `OUTCOME_RECORDED` carries). */
  key: string;
  success?: boolean;
  score?: number;
}

export interface RecordOutcomeOptions {
  /** The authenticated caller, judged as `ExecutionOp` `"annotate"` against the recorded owner. */
  principal?: PrincipalChain;
  /** The kernel-internal grant (see `WorkflowRuntime.systemOptions`). */
  system?: SystemGrant;
}

export interface RecordOutcomeResult {
  /** `false` when an identical `(decisionId, key)` outcome was already recorded (idempotent). */
  appended: boolean;
  /** The sequence the outcome sits at (the existing one when `appended` is `false`). */
  sequence?: number;
}

/**
 * `recordOutcome` on an execution that is not finished (running, parked) or that continued into a
 * successor: refused with nothing appended. A live run records its own outcomes with `ctx.emit`
 * (an `OutcomeSink`); the late-attach path takes no fence, so it must never touch a live holder.
 */
export class ExecutionNotTerminalError extends Error {
  readonly retryable = false;
  constructor(
    readonly executionId: string,
    readonly status: string
  ) {
    super(
      `execution "${executionId}" is ${status}: recordOutcome attaches a reward to a FINISHED execution (completed, failed, cancelled). A live run records its outcomes with ctx.emit. Nothing was appended.`
    );
    this.name = "ExecutionNotTerminalError";
    Object.setPrototypeOf(this, ExecutionNotTerminalError.prototype);
  }
}

/**
 * `recordOutcome` refused the outcome itself, with nothing appended: an invalid shape, a
 * `decisionId` the execution never recorded (reward poisoning by invented ids), or a different
 * score/success for a `(decisionId, key)` already recorded (the log is append-only; a correction
 * is a new `key`).
 */
export class OutcomeRefusedError extends Error {
  readonly retryable = false;
  constructor(
    readonly executionId: string,
    readonly reason: string
  ) {
    super(`recordOutcome on "${executionId}" refused: ${reason}. Nothing was appended.`);
    this.name = "OutcomeRefusedError";
    Object.setPrototypeOf(this, OutcomeRefusedError.prototype);
  }
}

/** `recordOutcome` lost the sequence compare-and-set on every bounded attempt: retry. */
export class OutcomeContendedError extends Error {
  readonly retryable = true as const;
  constructor(
    readonly executionId: string,
    reason = "lost the append race on every attempt (a concurrent writer kept taking the next sequence)"
  ) {
    super(`recordOutcome on "${executionId}" ${reason}. Nothing was appended; retry.`);
    this.name = "OutcomeContendedError";
    Object.setPrototypeOf(this, OutcomeContendedError.prototype);
  }
}

/**
 * `send` beyond `inboxMaxBacklog` unconsumed messages, or with the stream retaining `inboxMaxRetained`
 * entries behind one unconsumed message: backpressure, the owner's log is untouched.
 */
export class InboxFullError extends Error {
  readonly retryable = true as const;
  constructor(
    readonly executionId: string,
    readonly backlog: number,
    detail?: string
  ) {
    super(
      detail !== undefined
        ? `inbox of execution "${executionId}": ${detail}`
        : `inbox of execution "${executionId}" holds ${backlog} unconsumed messages (inboxMaxBacklog); nothing was appended. Retry after the owner consumes.`
    );
    this.name = "InboxFullError";
    Object.setPrototypeOf(this, InboxFullError.prototype);
  }
}

/**
 * `send` to an execution that can never consume it (finished, failed, cancelled): refused. Normally
 * nothing was appended. `discarded` is the narrow race where the owner turned terminal AFTER the
 * message was appended and BEFORE consuming it: the message was appended, never consumed, and
 * deleted with the inbox.
 */
export class InboxClosedError extends Error {
  constructor(
    readonly executionId: string,
    readonly status: string,
    readonly discarded = false
  ) {
    super(
      discarded
        ? `execution "${executionId}" is ${status}: it finished before consuming this message, which was appended and then discarded unconsumed.`
        : `execution "${executionId}" is ${status}: it will never consume a message. Nothing was appended.`
    );
    this.name = "InboxClosedError";
    Object.setPrototypeOf(this, InboxClosedError.prototype);
  }
}

/** `send` refused for a malformed message (topic, payload size). Nothing was appended. */
export class InboxMessageRefusedError extends Error {
  constructor(
    readonly executionId: string,
    detail: string
  ) {
    super(`send to execution "${executionId}" refused: ${detail}. Nothing was appended.`);
    this.name = "InboxMessageRefusedError";
    Object.setPrototypeOf(this, InboxMessageRefusedError.prototype);
  }
}

/**
 * ADR 0130 — an inbox message carries a sealed envelope (`__loomEnc`, written by the crypto plugin)
 * that THIS node did not open, so it cannot be delivered to the flow: handing the flow the
 * ciphertext as if it were the user's payload would also journal it as `MESSAGE_CONSUMED`, and the
 * corruption would be durable and replay deterministically. Nothing was consumed: the message stays
 * in the inbox for a node whose store is configured to open it. Terminal for THIS node (no retry on
 * it helps; fix the node's crypto configuration or route the execution to one that can open it).
 * Carries ids only, never the ciphertext. `unverifiable` is true when the payload was too large or
 * too deep to be checked within the walk bound (the guard fails closed).
 */
export class SealedPayloadUnreadableError extends Error {
  constructor(
    readonly executionId: string,
    readonly messageId: string,
    readonly topic: string,
    readonly unverifiable = false,
    /** true when the sealed payload is a RECORDED answer met on replay (not a message in the inbox). */
    readonly recorded = false
  ) {
    super(
      recorded
        ? `execution "${executionId}": the recorded answer to the inbox wait on topic "${topic}" ${
            unverifiable
              ? "could not be checked for a sealed envelope within the walk bound"
              : "is a sealed (encrypted) payload this node cannot open"
          }, so this run attempt was refused and nothing was appended. The execution is unchanged for a node configured to open it.`
        : `execution "${executionId}": the inbox message "${messageId}" on topic "${topic}" ${
            unverifiable
              ? "could not be checked for a sealed envelope within the walk bound"
              : "carries a sealed (encrypted) payload this node cannot open"
          }, so it was not delivered or consumed. It stays in the inbox for a node configured to open it.`
    );
    this.name = "SealedPayloadUnreadableError";
    Object.setPrototypeOf(this, SealedPayloadUnreadableError.prototype);
  }
}

/**
 * ADR 0110 D10b — `send` refused because the FLEET switched to per-topic inbox streams
 * (`runtime.enableInboxTopicStreams`) and this node has `kernel.features.inboxTopicStreams` OFF. A
 * legacy-stream write after the switch would sit below the owner's cursor and be skipped, so the node
 * refuses instead of losing the message. Turn the flag on for this node (or route the send to one that
 * has it). `possiblyWritten` is true when the switch was only seen AFTER a legacy copy landed: that
 * copy may or may not be delivered, so retry with the same `messageId` (the owner's dedupe window
 * delivers once).
 */
export class InboxTopicStreamsRequiredError extends Error {
  constructor(
    readonly executionId: string,
    readonly possiblyWritten = false
  ) {
    super(
      `send to execution "${executionId}" refused: the fleet writes per-topic inbox streams (ADR 0110 D10b) and this node has kernel.features.inboxTopicStreams off. ${
        possiblyWritten
          ? "A legacy copy may have landed before the switch was seen; retry with the same messageId (it is delivered once)."
          : "Nothing was appended."
      }`
    );
    this.name = "InboxTopicStreamsRequiredError";
    Object.setPrototypeOf(this, InboxTopicStreamsRequiredError.prototype);
  }
}

/**
 * ADR 0110 D3 — a re-run registered a wait whose `waitId` the log already ANSWERED as a different
 * kind or name: the flow body changed under a recorded answer (an inserted `receive` shifts every
 * later ordinal). Raised instead of handing the answer to the wrong wait. (ADR 0113's detector
 * is not required: this check is intrinsic to the answer's recorded identity.)
 */
export class FlowDivergenceError extends Error {
  constructor(
    readonly executionId: string,
    readonly waitId: string,
    readonly recorded: { kind: string; name: string },
    readonly registered: { kind: string; name: string }
  ) {
    super(
      `execution "${executionId}": wait "${waitId}" was answered as ${recorded.kind} "${recorded.name}" but the flow now registers ${registered.kind} "${registered.name}" at that position — the flow body changed under a recorded answer.`
    );
    this.name = "FlowDivergenceError";
    Object.setPrototypeOf(this, FlowDivergenceError.prototype);
  }
}

/**
 * ADR 0113 D3 — the replay-divergence detector: the flow body, re-run over an existing log, is about
 * to make a LIVE journal append of kind `beforeEvent` while `skippedSteps` — steps the log records
 * as completed — were never asked for. The code changed shape: it would skip durable work the log
 * shows done and run new work under the wrong shape. Raised BEFORE that append (in `fail` mode), so
 * nothing runs under the diverged body; membership only, no order. An instance of
 * {@link FlowDivergenceError} (the same family as a wait-identity divergence).
 */
export class FlowReplayDivergenceError extends FlowDivergenceError {
  constructor(
    executionId: string,
    readonly skippedSteps: readonly string[],
    readonly skippedCount: number,
    readonly beforeEvent: string
  ) {
    super(
      executionId,
      "",
      { kind: "steps", name: skippedSteps.join(", ") },
      { kind: "steps", name: "(not visited)" }
    );
    this.message = `execution "${executionId}": the flow body diverged from its log — ${skippedCount} recorded completed step(s) [${skippedSteps.join(", ")}${skippedCount > skippedSteps.length ? ", …" : ""}] were not asked for before the re-run reached a live ${beforeEvent} append. The body changed shape under an in-flight execution: re-register the original code (pin), list the recorded fingerprint in \`compatibleWith\` if the edit is replay-compatible, or migrate with resumeAs.`;
    this.name = "FlowDivergenceError";
    Object.setPrototypeOf(this, FlowReplayDivergenceError.prototype);
  }
}
