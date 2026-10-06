import { StorageWriteError, SuspendError, flowContentHash } from "@loom/core";
import type { EventEnvelope, ExecutionState, FlowDefinition } from "@loom/core";
import { LazyEffect } from "@loom/effect-runtime";
import type {
  Effect,
  EffectRuntime,
  PrincipalChain,
  TransientInvokeOptions,
} from "@loom/effect-runtime";
import type { BranchRegistry, EventStore, TimerStore } from "@loom/event-runtime";
import {
  DuplicateEnvelopeIdError,
  DuplicateSequenceError,
  RESERVED_STREAM_PREFIX,
  isReservedStream,
} from "@loom/event-runtime";
import { appendBatchOf, headOf, readRangeOf } from "@loom/event-runtime";
// Import the pure sequence helper from the browser-safe subpath, not the barrel:
// the barrel eagerly re-exports the SQLite store (better-sqlite3 / node:fs), which
// would otherwise leak into every browser app that builds on the WorkflowRuntime.
import { sliceBySequence } from "@loom/event-runtime/sequence";
import {
  EVENT_SCHEMA_VERSION,
  FAILED_WHILE_PARKED,
  ReplayVM,
  knownEventTypes,
  normalizeSnapshotState,
} from "@loom/replay-vm";
import { type Snapshot, type SnapshotStore, assertSnapshotIdentity } from "@loom/snapshot-runtime";
import { ulid } from "ulid";
import { ExecutionJournal } from "./ExecutionJournal";
import { highestMissing } from "./LogLifecycle";
import { WorkflowContextImpl } from "./WorkflowContext";
import {
  armDeadline,
  assertFlowBudgets,
  assertValidBudget,
  remainingBudget,
} from "./deadlineTimer";
import { asInDoubtVerdict, inDoubtDecisionId } from "./inDoubt";
import { isKernelHumanPark } from "./kernelPark";
import { COMPUTE_TARGET_KEY } from "./placement";
import {
  type PrincipalCodec,
  type PrincipalIdentityMode,
  type PrincipalRecord,
  type PrincipalResolver,
  buildPrincipalRecord,
  ownerOfChain,
  rehydratePrincipal,
  storedPrincipalOf,
} from "./principal";
import {
  type StrayPassthroughReport,
  StrayScanner,
  discardDecisionId,
  strayPassthroughMessage,
} from "./strayPassthroughs";
import {
  ApprovalRejectedError,
  CompactedForkPointError,
  EFFECT_INDOUBT_RESOLVED,
  EXECUTION_RECOVERED,
  ExecutionAlreadyExistsError,
  ExecutionCancelledError,
  ExecutionDeniedError,
  FlowCodeMismatchError,
  FlowMigrationCheckError,
  InputValidationError,
  ResumeContendedError,
  ResumePayloadValidationError,
  ResumeRefusedError,
  StartFencedOutError,
  StateMigrationError,
  TIMER_FIRED,
} from "./types";
import type {
  ErrorClassCtor,
  ExecutionAuthorizer,
  ExecutionAuthzRequest,
  ExecutionHandle,
  ExecutionOp,
  FlowRunner,
  ForkOptions,
  ForkResult,
  LineageGrant,
  RegisteredFlow,
  ResumeAuthenticator,
  ResumeEvent,
  RunOptions,
  SystemGrant,
} from "./types";
import { isStaleFence, isWriteConflict } from "./writeConflict";

/**
 * The kernel's own event namespace (#304). Built once from the K5-governed list the
 * conformance test pins, so a new event type is covered the moment it is registered —
 * a hand-kept denylist here would be the drift the pinned list exists to prevent.
 */
const KERNEL_EVENT_TYPES: ReadonlySet<string> = new Set(knownEventTypes());

/** An event to commit through the journal before the flow runner starts. */
interface BootstrapEvent {
  eventType: string;
  payload: unknown;
  /**
   * Envelope metadata — operational. Carries the placement hint (#392). The fold reads
   * `flowEmit` (ADR 0102) and, since EVENT_SCHEMA 1.23.0, `kernel` (the Wave 2 kinds fold only
   * a kernel-stamped envelope), `forkChain` and `forkedBy` (a fork's chain identity and acting
   * principal, read from the `EXECUTION_STARTED` envelope). A bootstrap event carries none of
   * them; `kernel` is stamped by the journal, never taken from a caller.
   */
  metadata?: Record<string, unknown>;
  /**
   * ADR 0103 — this event was already made DURABLE (by `start()`'s bootstrap barrier for a
   * caller-chosen id); `execute` adopts the stored envelope instead of committing it again.
   */
  durable?: EventEnvelope;
}

export interface WorkflowRuntimeDeps {
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  effectRuntime: EffectRuntime;
  /**
   * Live tail: called synchronously with every event this runtime commits, in sequence
   * order, as it is folded — BEFORE its durable write completes. That is by design (the
   * journal keeps the in-memory fold independent of store latency, and a failed durable
   * write aborts the run and fails it at the next drain barrier), so an event seen here can,
   * on a storage failure, never become durable. A consumer that must act only on DURABLE
   * facts reads them back (a catch-up read over the store, the read-model plugin's shape,
   * ADR 0058) rather than acting on this callback.
   *
   * One exception (ADR 0103): a start with a caller-chosen `executionId` writes its
   * `EXECUTION_STARTED` before this fires for it, so a duplicate start — refused with
   * `ExecutionAlreadyExistsError` — is never seen here at all.
   */
  onEvent?: (event: EventEnvelope) => void;
  /**
   * Optional branch registry. When provided, `fork()` records fork lineage and
   * (if a branchName is given) a movable ref. Without it, `fork()` still copies
   * the prefix and seeds the child snapshot — it just skips ref/lineage bookkeeping.
   */
  branchRegistry?: BranchRegistry;
  /**
   * Optional observability hook fired when a durable write rejects (a failure mode of
   * the async storage layer). It reports two kinds, and they are not equally optional:
   *
   * - an **event** append — the run is aborted and waitForCompletion/waitForSuspend
   *   reject with a StorageWriteError regardless, so this is purely logging/metrics;
   * - a **snapshot** save (both the {@link WorkflowRuntimeDeps.snapshotEvery} cadence
   *   and the settle checkpoint) — fire-and-forget by design, since a lost checkpoint
   *   only means a longer replay. That makes this hook the ONLY channel: unwired, a
   *   store that fails every save is indistinguishable from one that takes none, and
   *   the cadence silently stops bounding replay.
   */
  onStorageError?: (executionId: string, err: unknown) => void;
  /**
   * Diagnostics that are nobody's error: a declared deadline this runtime cannot honour,
   * today. Defaults to `console.warn`, matching `defineConfig`'s warning for schedules
   * that can never fire. Pass a sink to route it, or a no-op to silence it.
   */
  onWarn?: (message: string) => void;
  /**
   * ADR 0112 D3 — how long a park waits for the steps still in flight (a parallel sibling's)
   * to settle before it is committed. Default 30 000 ms. Past it the stragglers are aborted
   * and, if they still have not settled, their appends are dropped (they re-run on resume
   * under the same idempotency key).
   */
  parkDrainMs?: number;
  /**
   * ADR 0112 D1/D2 — cancellation scopes: `ctx.parallel` aborts the scope on the first real branch
   * failure, records `STEP_CANCELLED` for the work it cancels and journals `PARALLEL_COMPLETED`
   * (a kernel-stamped record an OLDER node's fold ignores). **Default `false`** (the rolling-upgrade
   * rule, `kernel.features.scopes`): off, `parallel` behaves as before R6 — no scope abort, no
   * `STEP_CANCELLED` for a sibling, no scope record, a served re-run never consults one. Turn it on
   * only once every node runs a version that folds the record. (The park barrier, ADR 0112 D3, is
   * an ordering guarantee that writes no new event and is always on.) Set by
   * `defineConfig({ kernel: { features: { scopes: true } } })`.
   */
  scopes?: boolean;
  /**
   * ADR 0112 D2 — error classes a fail-fast scope may REHYDRATE by name (composition-time,
   * deterministic): the scope journals the failing error's `name` and message, and the first run
   * and every served re-run throw an instance built `new ctor(message)`. `TypedFailure` stays typed
   * and the built-in `Error` family is registered already; anything else is thrown as a
   * `ParallelScopeFailedError` carrying the name. A constructor that throws, or returns a
   * non-`Error`, falls back to `ParallelScopeFailedError`.
   */
  errorClasses?: Record<string, ErrorClassCtor>;
  /**
   * Take a mid-run snapshot every N committed events, bounding the replay tail so
   * a resume/recovery folds only ~N events instead of the whole log. Omit (or 0)
   * to keep the default cadence (snapshots only at suspend + fork). A larger N
   * means fewer writes but a longer worst-case replay.
   */
  snapshotEvery?: number;
  /**
   * K12.2 — verifies approval-type resume events. When set, a resume whose
   * event the authenticator rejects is REFUSED (a forged approval never
   * resumes); a verified approval records a durable `APPROVAL_GRANTED` fact.
   */
  resumeAuthenticator?: ResumeAuthenticator;
  /**
   * T1 — durable timer storage. When wired, a suspension carrying `wakeAt`
   * (`ctx.sleep`/`ctx.sleepUntil`) — or a `suspend({ timeout })`, whose wake
   * time is then derived and recorded durably — schedules a timer row AFTER the
   * suspension is durable, so a {@link TimerService} can fire it across
   * restarts. Unwired: no timers are scheduled and `timeout` stays the
   * historical no-fire metadata, byte-identically (G2).
   */
  timerStore?: TimerStore;
  /**
   * C.1 — execution-lifecycle authorization. When set, `start`/`resume`/`cancel`
   * and the public `loadState` (query) consult it — but ONLY when the call carries
   * a `principal` (the trust-boundary model: the edge attaches the authenticated
   * principal; principal-less kernel-internal calls — TimerService, recovery — are
   * unaffected, byte-identically (G2)). A denied op throws {@link ExecutionDeniedError}.
   *
   * SECURITY CONTRACT: because principal-less calls bypass the gate by design (so the
   * kernel's own machinery keeps working), the INTEGRATOR is responsible for attaching
   * an authenticated principal to EVERY externally-originated call. Never expose these
   * runtime methods to untrusted callers without a principal — the authorizer is an
   * edge-enforced policy, not a substitute for authenticating the caller.
   */
  executionAuthorizer?: ExecutionAuthorizer;
  /**
   * R3k (ADR 0111 D3) — an app that must not put even an actor id in its log supplies a codec:
   * the start then records `{ v: 1, ref }` only, and every `execute()` rebuilds the effect
   * principal with `fromRef`. This is also the mode that can re-issue a narrowed delegation
   * (`superviseChildren({ delegation })` composes one). The kernel never interprets `ref`.
   */
  principalCodec?: PrincipalCodec;
  /**
   * R3k (ADR 0111 D2) — replaces the default rehydration of a recorded principal for EVERY record
   * (the default rebuilds `{ tenant, actor, onBehalfOf }` and denies a recorded delegation it
   * cannot restore). Also the restorer that lets a `start` carrying a delegation be accepted.
   */
  principalResolver?: PrincipalResolver;
  /**
   * R3k (ADR 0111 D1) — how a record may carry the identity subset. Default `"verbatim"`.
   * `defineConfig` sets `"encrypted"` when crypto is composed and `"ref"` under `security.strict` /
   * a composed compliance plugin without crypto, and refuses to compose when that needs a
   * `principalCodec` and none was supplied.
   */
  principalIdentity?: PrincipalIdentityMode;
  /**
   * R3 (1P half) — fail-closed execution authorization. OFF (default) = byte-identical to
   * before: principal-less calls bypass {@link executionAuthorizer}. With
   * `requirePrincipal: true` the authorizer is ALSO consulted for a call that carries NO
   * principal (the request arrives with `principal: undefined`, and the policy decides —
   * `executionAccessPolicy()` denies it unless `allowAnonymous`), so an edge that forgot to
   * attach a principal is refused rather than waved through.
   *
   * Kernel-internal machinery that legitimately has no principal today (TimerService wakes
   * and schedule starts, crash recovery, the child supervisor, `LocalWorkerRuntime`, census
   * readers) presents this runtime's {@link WorkflowRuntime.systemOptions | system grant}
   * instead. The grant is an unguessable per-instance object compared BY IDENTITY: a
   * principal, a JSON body or a clone of the grant is not it. It is an in-process
   * capability — never hand it to request-derived code. The grant authorizes the LIFECYCLE
   * op only: since ADR 0111 the principal is durable, so the effects of these paths run as the
   * principal recorded when the execution started, never as the system.
   *
   * Inert without an {@link executionAuthorizer}. `@loom/app` sets it under `security.strict`.
   */
  executionAuthz?: { requirePrincipal?: boolean };
  /**
   * C.1 — fired whenever an {@link ExecutionAuthorizer} refuses a lifecycle op, for
   * audit/telemetry. Independent of the durable EXECUTION_DENIED fact (which the
   * kernel best-effort records for denied resume/cancel on non-fencing stores).
   */
  onExecutionDenied?: (request: ExecutionAuthzRequest, reason?: string) => void;
  /**
   * ADR 0051 D7 — opt-in input validation at `start()`. When true, the flow's
   * declared `inputSchema` is parsed at the boundary for EVERY entry path that
   * lands on start (direct starts, schedule occurrences, A2A submits); invalid
   * input refuses with {@link InputValidationError} BEFORE anything is appended,
   * and the PARSED value is what runs and is recorded (Zod defaults/transforms
   * apply). Off (default) = inputSchema stays declaration-only metadata,
   * byte-identically (G2).
   */
  validateInput?: boolean;
  /**
   * Injectable clock for event-envelope timestamps (DST/simulation) and timer wake
   * times — retention windows and content-GC citation ages read the former.
   * `ctx.sleep` / `suspend({ timeout })` compute their `wakeAt` with it, and
   * `TimerService` defaults its own `now` to it (`runtime.clock`), so a simulated
   * clock given here alone drives sleeps: they fire exactly when it passes `wakeAt`.
   * Lease expiry is never judged on this clock: `recoverAbandoned` asks the lease store, which
   * judges on the same clock that stamped the lease (its own injected `now`).
   * Default: `Date.now` (unchanged, G2).
   *
   * Deadline-relevant: step `timeoutMs` and execution `deadlineMs` are anchored to
   * journal timestamps written with this clock, and the remaining budget is measured
   * with it too (`now() - anchor`), so the two never mix clocks. The `setTimeout` that
   * enforces a deadline still waits REAL milliseconds, so for a deadline to fire on
   * time this clock must advance in real time (for DEADLINES only, a fixed or offset clock is
   * fine; a clock that runs faster or slower than the wall clock skews when deadlines fire).
   * A fully simulated clock should not be combined with `timeoutMs`/`deadlineMs`
   * unless the test advances it and drives the timers itself. Not fold-relevant.
   *
   * Caveats: (1) a FIXED clock silently disables the crash-surviving deadline (A4):
   * elapsed time is always 0, so every crash or resume re-grants the full budget.
   * Under a fixed clock a budget above 2^31-1 ms (~24.8 days) also never fires within a
   * single run: elapsed stays 0, so each timer chunk re-arms.
   * (2) An OFFSET is safe only if EVERY runtime touching the log uses the same offset;
   * a recovering node with a different offset eats into the budget, or steps the clock
   * backwards (the remaining budget is capped at the full budget in that case). This
   * covers timer wake times and cron too (L27), and it applies ACROSS AN UPGRADE: timers
   * parked in a store before it carry wall-clock `wakeAt`, so a runtime with an offset
   * clock fires them |offset| early or late (never, under a fixed clock), and during a
   * rolling upgrade old (wall) and new (offset) nodes disagree. With the default wall
   * clock nothing changes.
   * (3) Under a FIXED clock, `ctx.sleep`, `suspend({ timeout })` and cron schedules NEVER
   * fire (`wakeAt = FIXED + ms` is judged at FIXED; cron cursors are anchored at FIXED);
   * they used to fire on wall time. Advance the clock, or drive `TimerService.tick(now)`
   * yourself. `sleepUntil(absolute)` targets and cron occurrences are measured on this
   * clock's timeline, not wall time.
   */
  now?: () => number;
}

/**
 * Reject a caller-supplied executionId that squats the kernel's reserved control-stream
 * namespace (`__loom_*`).
 *
 * `isReservedStream` existed only as a FILTER — enumerators, retention sweeps, and read-model
 * indexing skip these ids — and nothing rejected one on the way in. Since an ingress adapter
 * can pass a client-chosen id straight through (A2A maps `task.id` to the executionId
 * verbatim), an external caller could start an execution inside `__loom_lifecycle__` or
 * `__loom_erasure__`. Two consequences, both bad:
 *
 *  - it writes into the streams that RECORD retention and GDPR erasure, corrupting the audit
 *    trail that exists to prove those happened;
 *  - the execution is invisible to every enumerator, so retention never reclaims it and
 *    compliance reports never see it — growth and evasion at once.
 *
 * Enforced here rather than in each adapter so it covers A2A, MCP, and anything added later.
 * The kernel's own control writes go through `eventStore.append` directly and are unaffected.
 */
function assertNotReserved(executionId: string): void {
  if (executionId === "") {
    // ADR 0107 — a blank identity names no execution. It is also where the pre-0106 compaction
    // bug wrote resumed events; nothing may add to that stream.
    throw new Error(`executionId "" is reserved: a blank identity names no execution (ADR 0107)`);
  }
  if (isReservedStream(executionId)) {
    throw new Error(
      `executionId "${executionId}" is reserved: "${RESERVED_STREAM_PREFIX}" prefixes the kernel's control streams`
    );
  }
}

/**
 * ADR 0104 — what a resume records BESIDE its resume-typed event. The invariant: every entry
 * the fold adds to `_resumePayloads` answers exactly one suspend point (`ctx.suspend`, or a
 * `kind: "human"` step), because `ctx.suspend` serves that list positionally — an entry that
 * answered nothing is served to the flow's NEXT gate as its approval. So:
 *
 * - parked at a gate → `EXECUTION_RESUMED(payload)`: the payload IS that gate's answer;
 * - parked IN DOUBT (K9.3, thrown from `ctx.run`, not a suspend point) → the verdict is
 *   recorded as a kernel `DECISION_RECORDED` keyed by the step and the attempt it answers,
 *   then `EXECUTION_RESUMED(null)`, which re-opens the execution with no passthrough;
 * - crashed (`running`/`pending`: `EXECUTION_RECOVERED`, or `resumeAs` onto one) → nothing:
 *   already running, and parked at no gate;
 * - terminal (`resumeAs` onto a failed/completed execution) → `EXECUTION_RESUMED(null)`, which
 *   re-opens it (so a crash afterwards is recoverable) without answering a gate.
 *
 * `null` rather than an absent payload because every store round-trips it (SQLite's payload
 * column is NOT NULL); the fold treats a null resume in those two positions as status-only
 * (EVENT_SCHEMA 1.20.0). An in-doubt payload that is not a verdict for the parked step is
 * refused before this is reached (`assertInDoubtVerdict`).
 */
function answerEvents(
  before: ExecutionState,
  payload: unknown
): Array<{ eventType: string; payload: unknown }> {
  if (before.status === "suspended") {
    const condition = before.suspendedOn;
    if (condition?.on !== EFFECT_INDOUBT_RESOLVED) {
      return [{ eventType: "EXECUTION_RESUMED", payload }];
    }
    const stepId = condition.correlationKey ?? "";
    const verdict = asInDoubtVerdict(payload, stepId);
    const attempts = before.frames[stepId]?.attempts;
    return [
      ...(verdict !== undefined && attempts !== undefined
        ? [
            {
              eventType: "DECISION_RECORDED",
              payload: {
                decisionId: inDoubtDecisionId(stepId, attempts),
                choice: verdict,
                source: "operator",
              },
            },
          ]
        : []),
      { eventType: "EXECUTION_RESUMED", payload: null },
    ];
  }
  if (before.status === "running" || before.status === "pending") return [];
  return [{ eventType: "EXECUTION_RESUMED", payload: null }];
}

/**
 * ADR 0105 — a caller's `null` answer to a gate a parallel step failed on while it was parked.
 * The fold records that `null` as status-only (`_failedWhileParked`, fail-closed), so appending
 * it would re-park the gate without telling the caller its answer was not taken. Refused before
 * anything is appended. Scoped to caller-supplied GATE answers: only `resume` and `resumeAs`
 * onto a gate-parked execution reach it. Recovery (refused at a park anyway), `TimerService`
 * (a `{ wakeAt }` payload), in-doubt verdicts (never `null`, and not gate answers) and the
 * kernel's own status-only `null` (`answerEvents`, written only for unparked executions) do not.
 */
function assertNullAnswerTakes(
  executionId: string,
  eventType: string,
  before: ExecutionState,
  payload: unknown
): void {
  if (
    payload !== null ||
    before.status !== "suspended" ||
    before.suspendedOn?.on === EFFECT_INDOUBT_RESOLVED ||
    before.variables[FAILED_WHILE_PARKED] !== true
  ) {
    return;
  }
  throw new ResumeRefusedError(
    executionId,
    eventType,
    "null-answer-after-parked-failure",
    `a parallel step failed while the execution was parked on "${before.suspendedOn?.on}", and a null answer in that position is recorded as a status-only re-open (ADR 0105), so it would not answer the gate. Nothing was appended. Resume with a non-null answer.`
  );
}

/**
 * ADR 0104 — an in-doubt park is answered by a verdict for THAT step, or not at all. The
 * pre-0104 kernel recorded anything and let the step re-park; a non-verdict is now refused
 * with nothing appended, so every recorded answer to an in-doubt park is a verdict decision.
 */
function assertInDoubtVerdict(executionId: string, before: ExecutionState, payload: unknown): void {
  const condition = before.suspendedOn;
  if (before.status !== "suspended" || condition?.on !== EFFECT_INDOUBT_RESOLVED) return;
  const stepId = condition.correlationKey ?? "";
  if (asInDoubtVerdict(payload, stepId) === undefined || before.frames[stepId] === undefined) {
    throw new ResumePayloadValidationError(
      executionId,
      EFFECT_INDOUBT_RESOLVED,
      `expected an EffectInDoubtResolution for step "${stepId}" ({ stepId, resolution: "completed-with-result" | "retry-fresh" | "fail" })`
    );
  }
}

/**
 * ADR 0104 — `discardLegacyAnswers` decides what a human step accepts as its approval, so it is
 * an approval itself: honoured only on a resume the `ResumeAuthenticator` VERIFIED (which, since
 * the authenticator is handed the whole event, covers the override), and never on a resume the
 * kernel raises itself. An unauthenticated override would let anyone allowed to resume make a
 * human step take a pre-0104 `{}` as its approval.
 */
function assertAuthorizedOverride(
  executionId: string,
  event: ResumeEvent,
  approval: { eventType: string; payload: unknown } | undefined
): void {
  if (event.discardLegacyAnswers === undefined) return;
  if (event.eventType === EXECUTION_RECOVERED || event.eventType === TIMER_FIRED) {
    throw new Error(
      `discardLegacyAnswers refused for execution "${executionId}": "${event.eventType}" is raised by the kernel, never an operator's override. Nothing was appended.`
    );
  }
  if (approval === undefined) {
    throw new ApprovalRejectedError(
      executionId,
      "discardLegacyAnswers is an operator override of what a human step accepts as its approval, so it requires a VERIFIED approval: configure a ResumeAuthenticator that covers the override and have it verify this event"
    );
  }
}

/** R13 — the newest `EXECUTION_SUSPENDED`'s sequence in `events`, if any is there. */
function lastSuspendSequence(
  events: readonly { eventType: string; sequence: number }[] | undefined
): number | undefined {
  if (events === undefined) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e !== undefined && e.eventType === "EXECUTION_SUSPENDED") return e.sequence;
  }
  return undefined;
}

/** How many (execution, verdict) stray-passthrough warnings a runtime remembers (ADR 0104). */
const STRAY_WARNING_MEMORY = 4096;

/** R3k round 2 (ADR 0111 D6) — how far up a `parent` chain an owner is looked for. */
const MAX_LINEAGE_HOPS = 8;

/** ADR 0118 D2 — conditional-fence attempts before a resume surfaces `ResumeContendedError`. */
const FENCE_IF_ATTEMPTS = 3;

/** The `parent` recorded on an execution's sequence 0 (`undefined` for any other envelope). */
function parentOfFirst(first: EventEnvelope | undefined): string | undefined {
  if (first === undefined || first.sequence !== 0 || first.eventType !== "EXECUTION_STARTED") {
    return undefined;
  }
  const parent = (first.payload as { parent?: unknown } | null | undefined)?.parent;
  return typeof parent === "string" && parent.length > 0 ? parent : undefined;
}

/** The owner(s) an authorization request carries: the recorded one, or the lineage's nearest. */
interface AuthzOwners {
  owner?: NonNullable<ExecutionAuthzRequest["owner"]>;
  parentOwner?: NonNullable<ExecutionAuthzRequest["owner"]>;
}

export class WorkflowRuntime {
  private readonly eventStore: EventStore;
  private readonly snapshotStore: SnapshotStore;
  private readonly effectRuntime: EffectRuntime;
  private readonly onEvent: ((event: EventEnvelope) => void) | undefined;
  private readonly branchRegistry: BranchRegistry | undefined;
  private readonly onStorageError: ((executionId: string, err: unknown) => void) | undefined;
  private readonly onWarn: (message: string) => void;
  /** One warning per (flow, gate) — a hot loop must not narrate the same dropped deadline. */
  private readonly warnedDroppedDeadlines = new Set<string>();
  private readonly warnedStrayPassthroughs = new Set<string>();
  /**
   * R1a — per execution, the legacy stray-passthrough scanner (ADR 0104) as it stood after the
   * last scan that came back CLEAN, with the event sequence it has consumed and the flow
   * definition whose step kinds it attributed parks with. See {@link WorkflowRuntime.resume}:
   * a later resume feeds it only the events appended since, instead of re-reading the whole
   * log, so a pre-0104 writer appending to the same log (a mixed-version fleet) is still seen.
   * Bounded (FIFO) like the warning memory.
   */
  private readonly strayScans = new Map<
    string,
    { scanner: StrayScanner; definition: FlowDefinition<unknown, unknown> }
  >();
  private readonly snapshotEvery: number | undefined;
  private readonly parkDrainMs: number | undefined;
  private readonly scopes: boolean;
  private readonly errorClasses: Record<string, ErrorClassCtor> | undefined;
  private readonly timerStore: TimerStore | undefined;
  private readonly resumeAuthenticator: ResumeAuthenticator | undefined;
  private readonly executionAuthorizer: ExecutionAuthorizer | undefined;
  private readonly requirePrincipal: boolean;
  // R3k — the durable principal's record/rehydration seams (ADR 0111). The codec is mutable only
  // through `composePrincipalCodec`, a composition-time contributor (the child supervisor).
  private principalCodec: PrincipalCodec | undefined;
  private readonly principalResolver: PrincipalResolver | undefined;
  private readonly principalIdentity: PrincipalIdentityMode;
  // R3 — identity-compared grant for kernel-internal callers; undefined unless requirePrincipal.
  private readonly systemGrantToken: SystemGrant | undefined;
  // R3k round 2 — held in EVERY mode (even with no authorizer): the only way a `parent` is recorded.
  private readonly lineageToken: LineageGrant = Object.freeze({ __loomLineageGrant: true });
  private readonly validateInput: boolean;
  private readonly now: () => number;
  private readonly onExecutionDenied:
    | ((request: ExecutionAuthzRequest, reason?: string) => void)
    | undefined;
  private readonly flows = new Map<string, RegisteredFlow>();
  // K11.1 — content hash of each flow id's CURRENT (most recently registered) version.
  private readonly flowHashes = new Map<string, string>();
  // K11.2 — every registered version per flow id, for pinned resumption.
  private readonly flowVersions = new Map<
    string,
    Map<string, { flow: RegisteredFlow; hash: string }>
  >();
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
    this.onWarn = deps.onWarn ?? ((m: string) => console.warn(`[loom] ${m}`));
    this.snapshotEvery = deps.snapshotEvery;
    this.parkDrainMs = deps.parkDrainMs;
    this.scopes = deps.scopes === true;
    this.errorClasses = deps.errorClasses;
    this.resumeAuthenticator = deps.resumeAuthenticator;
    this.timerStore = deps.timerStore;
    this.executionAuthorizer = deps.executionAuthorizer;
    this.principalCodec = deps.principalCodec;
    this.principalResolver = deps.principalResolver;
    this.principalIdentity = deps.principalIdentity ?? "verbatim";
    this.requirePrincipal =
      deps.executionAuthz?.requirePrincipal === true && deps.executionAuthorizer !== undefined;
    this.systemGrantToken = this.requirePrincipal
      ? (Object.freeze({ __loomSystemGrant: true }) as SystemGrant)
      : undefined;
    this.onExecutionDenied = deps.onExecutionDenied;
    this.validateInput = deps.validateInput ?? false;
    this.now = deps.now ?? Date.now;
  }

  // ── C.1 — execution-lifecycle authorization helpers ────────────────────────
  //
  // The authorizer is consulted only when configured AND a principal is present on
  // the call (the trust-boundary model). A denial fires the audit callback and, for
  // resume/cancel, BEST-EFFORT records a durable EXECUTION_DENIED fact — WITHOUT
  // acquiring a fence, so it can never fence-out (disrupt) a running execution. On a
  // fencing store with an active fence the append is rejected and silently skipped;
  // enforcement is the thrown error, which never depends on the record.

  /**
   * R3 — the options a KERNEL-INTERNAL caller (timer wake, recovery, supervisor, local worker)
   * spreads into its `start`/`resume`/`cancel`/`loadState` call: `{ system }` when this runtime
   * fails closed on a missing principal, else `{}` (so nothing changes when the mode is off).
   * The grant bypasses the execution authorizer ONLY; it is not a principal, never reaches an
   * effect's authorization, and is not recorded. See {@link WorkflowRuntimeDeps.executionAuthz}.
   */
  systemOptions(): { system?: SystemGrant } {
    return this.systemGrantToken !== undefined ? { system: this.systemGrantToken } : {};
  }

  /**
   * R3k round 2 (ADR 0111 D6) — the options the child SUPERVISOR spreads into a child's `start` so
   * the `parent` it names is RECORDED on sequence 0. Always `{ lineage }`, in every mode. The
   * token authorizes only that recording: unlike {@link systemOptions} it bypasses no authorizer
   * and gates no timer wake. A caller-supplied `parentExecutionId` without it is omitted from the
   * log, so a recorded `parent` is always the supervisor's.
   */
  lineageOptions(): { lineage: LineageGrant } {
    return { lineage: this.lineageToken };
  }

  /** Is this call's `parentExecutionId` trustworthy (the supervisor's, or the kernel's own)? */
  private lineageTrusted(
    options:
      | {
          system?: SystemGrant;
          lineage?: LineageGrant;
        }
      | undefined
  ): boolean {
    return (
      (options?.lineage !== undefined && options.lineage === this.lineageToken) ||
      (options?.system !== undefined && options.system === this.systemGrantToken)
    );
  }

  /**
   * R12 — true when this runtime fails closed on a call with no principal
   * (`executionAuthz.requirePrincipal` with an authorizer, i.e. `security.strict`). Read-only; the
   * ingress servers default their own `strict` from it.
   */
  get requiresPrincipal(): boolean {
    return this.requirePrincipal;
  }

  /** R3 — a read-only `{ loadState }` view carrying the system grant, for census/live-query readers. */
  systemStateReader(): { loadState(executionId: string): Promise<ExecutionState | null> } {
    return { loadState: (executionId) => this.loadState(executionId, this.systemOptions()) };
  }

  // ── R3k — the durable principal (ADR 0111) ─────────────────────────────────

  /**
   * R3k (ADR 0111 D4) — add a principal codec WITHOUT replacing the one the app configured. A
   * composition-time contributor: `superviseChildren({ delegation })` calls it so a supervised
   * child's narrowed delegation survives a crash with no configuration. The newest codec is asked
   * first (`toRef`: first string wins; `fromRef`: first chain wins, so a codec returns `undefined`
   * for a ref that is not its own). Installing the same codec twice is a no-op.
   */
  composePrincipalCodec(codec: PrincipalCodec): void {
    if (this.composedCodecs.has(codec)) return;
    this.composedCodecs.add(codec);
    const existing = this.principalCodec;
    this.principalCodec =
      existing === undefined
        ? codec
        : {
            toRef: (chain) => codec.toRef(chain) ?? existing.toRef(chain),
            fromRef: async (ref, context) =>
              (await codec.fromRef(ref, context)) ?? existing.fromRef(ref, context),
          };
  }
  private readonly composedCodecs = new Set<PrincipalCodec>();
  /**
   * R3k review P2-a — the record a start wrote, kept for the life of its LIVE execution. A minted
   * id's sequence 0 is journalled behind the fold, so a lifecycle op (`cancel`, `query`) landing
   * in that window would point-read nothing, read "legacy", and report no owner (denying the
   * owner). The map is bounded by the live executions of this runtime: set at start, cleared when
   * the handle settles (or the start throws). Never consulted for a resume (sequence 0 is read).
   */
  private readonly startRecords = new Map<
    string,
    { record: PrincipalRecord; parent: string | undefined }
  >();

  /** D1 — the record a start (or a fork's `forkedBy`) writes for `chain`. Throws before anything is appended. */
  private principalRecordFor(
    chain: PrincipalChain | undefined,
    site: "payload" | "metadata" = "payload"
  ): PrincipalRecord {
    return buildPrincipalRecord(
      chain,
      {
        identity: this.principalIdentity,
        codec: this.principalCodec,
        hasResolver: this.principalResolver !== undefined,
      },
      site
    );
  }

  /**
   * D2 — what the execution's effects run as, read from the LOG. `known` carries a sequence-0
   * envelope the caller already read (resume does); otherwise it is one point read. A caller-
   * supplied `ExecutionState` is never consulted: `restoreFromState` cannot forge the owner.
   * `legacy: true` = the log predates EVENT_SCHEMA 1.23.0 and recorded no principal. A read that
   * FAILS is never legacy: `actingPrincipal` propagates it and `ownerForAuthz` reports an unknown
   * owner (the policy's `unknownOwner` rule decides: deny by default). A live execution of this
   * runtime answers from the record its start wrote (see {@link startRecords}).
   */
  private async recordedPrincipal(
    executionId: string,
    known?: { first: EventEnvelope | undefined }
  ): Promise<
    { legacy: true } | { legacy: false; chain: PrincipalChain | undefined; parent?: string }
  > {
    let first: EventEnvelope | undefined;
    const live = known === undefined ? this.startRecords.get(executionId) : undefined;
    if (live !== undefined) {
      return {
        legacy: false,
        chain: await rehydratePrincipal(live.record, executionId, {
          codec: this.principalCodec,
          resolver: this.principalResolver,
        }),
        ...(live.parent !== undefined && { parent: live.parent }),
      };
    }
    if (known !== undefined) {
      first = known.first;
    } else {
      try {
        first = (await readRangeOf(this.eventStore, executionId, 0, 0))[0];
      } catch (err) {
        // A crypto-shredded record denies; it never falls back to the caller (D2).
        if ((err as { name?: unknown } | null)?.name === "PayloadShreddedError") {
          return { legacy: false, chain: { principalShredded: true } };
        }
        throw err;
      }
    }
    // The `parent` rides sequence 0 beside the principal, so one read answers both (round 3).
    const parent = parentOfFirst(first);
    const withParent = parent !== undefined ? { parent } : {};
    const stored = storedPrincipalOf(first);
    switch (stored.kind) {
      case "legacy":
        return { legacy: true };
      case "shredded":
        return { legacy: false, chain: { principalShredded: true } };
      case "malformed":
        return { legacy: false, chain: { principalUnresolved: stored.why }, ...withParent };
      case "record":
        return {
          legacy: false,
          chain: await rehydratePrincipal(stored.record, executionId, {
            codec: this.principalCodec,
            resolver: this.principalResolver,
          }),
          ...withParent,
        };
    }
  }

  /**
   * D2 — the principal `execute()` runs the flow's effects as, on EVERY entry path. `caller` is
   * the LIFECYCLE caller (`RunOptions.principal`); it is used only for a legacy log that recorded
   * no principal, exactly as before this ADR.
   */
  private async actingPrincipal(
    executionId: string,
    caller: PrincipalChain | undefined,
    known?: { first: EventEnvelope | undefined }
  ): Promise<PrincipalChain | undefined> {
    const recorded = await this.recordedPrincipal(executionId, known);
    return recorded.legacy ? caller : recorded.chain;
  }

  /**
   * D5/D6 — the owners an `ExecutionAuthzRequest` carries, only when the authorizer will be asked:
   * the recorded `owner`, and — whenever the execution's recorded `parent` is present (written only
   * at a trusted start) — the `parentOwner` found up that lineage. A shredded/unrestorable record
   * is an unknown owner and gets neither: it never borrows its parent's authority.
   */
  private async ownerForAuthz(
    executionId: string,
    principal: PrincipalChain | undefined,
    system: SystemGrant | undefined,
    known?: { first: EventEnvelope | undefined }
  ): Promise<AuthzOwners> {
    if (this.executionAuthorizer === undefined || !this.authzApplies(principal, system)) {
      return {};
    }
    try {
      const recorded = await this.recordedPrincipal(executionId, known);
      if (recorded.legacy) return {};
      const owner = ownerOfChain(recorded.chain);
      if (owner === undefined && recorded.chain !== undefined) return {}; // shredded / unrestorable / delegation-only: unknown
      const parentOwner =
        recorded.parent !== undefined
          ? await this.lineageOwner(executionId, recorded.parent)
          : undefined;
      return {
        ...(owner !== undefined && { owner }),
        ...(parentOwner !== undefined && { parentOwner }),
      };
    } catch {
      return {}; // an owner we cannot read is an unknown owner: the policy decides
    }
  }

  /**
   * D6 — the nearest RECORDED owner up `executionId`'s `parent` chain, starting at `firstParent`
   * (already read with the execution's own record, so the first hop costs no extra seq-0 read).
   * `parent` is written only at a trusted start (the supervisor's lineage grant), so the chain is
   * the kernel's, not a caller's. Bounded at {@link MAX_LINEAGE_HOPS} and cycle-safe; an
   * unreadable link, a shredded or unrestorable ancestor, a chain that ends, or one that runs out
   * of hops, is an UNKNOWN owner.
   */
  private async lineageOwner(
    executionId: string,
    firstParent: string
  ): Promise<NonNullable<ExecutionAuthzRequest["owner"]> | undefined> {
    const seen = new Set<string>([executionId]);
    let parentId: string | undefined = firstParent;
    for (let hop = 0; hop < MAX_LINEAGE_HOPS; hop++) {
      if (parentId === undefined || seen.has(parentId)) return undefined;
      seen.add(parentId);
      const recorded = await this.recordedPrincipal(parentId);
      if (recorded.legacy) return undefined;
      const owner = ownerOfChain(recorded.chain);
      if (owner !== undefined) return owner;
      if (recorded.chain !== undefined) return undefined; // shredded / unrestorable ancestor
      parentId = recorded.parent;
    }
    return undefined;
  }

  /** Is the authorizer consulted for this call? (principal present, or fail-closed and no valid system grant) */
  private authzApplies(
    principal: PrincipalChain | undefined,
    system: SystemGrant | undefined
  ): boolean {
    if (this.executionAuthorizer === undefined) return false;
    if (system !== undefined && system === this.systemGrantToken) return false;
    return principal !== undefined || this.requirePrincipal;
  }

  /** Returns a denial reason if the op is refused, else undefined (allowed / not gated). */
  private authzDenial(
    op: ExecutionOp,
    executionId: string,
    workflowId: string,
    principal: PrincipalChain | undefined,
    system?: SystemGrant,
    owners?: AuthzOwners
  ): { reason?: string } | undefined {
    if (this.executionAuthorizer === undefined || !this.authzApplies(principal, system)) {
      return undefined;
    }
    const verdict = this.executionAuthorizer.authorize({
      op,
      executionId,
      workflowId,
      ...(principal !== undefined && { principal }),
      ...(owners?.owner !== undefined && { owner: owners.owner }),
      ...(owners?.parentOwner !== undefined && { parentOwner: owners.parentOwner }),
    });
    if (verdict.allowed) return undefined;
    return verdict.reason !== undefined ? { reason: verdict.reason } : {};
  }

  /**
   * R3 — tell the authorizer a start is DURABLE (see {@link ExecutionAuthorizer.committed}).
   * The principal is withheld when the start rode the system grant: that principal (a child's
   * delegation identity, say) is not the owner of the execution.
   */
  private notifyStarted(
    executionId: string,
    workflowId: string,
    principal: PrincipalChain | undefined,
    system: SystemGrant | undefined,
    parentExecutionId: string | undefined,
    viaFork = false,
    lineage?: LineageGrant
  ): void {
    const committed = this.executionAuthorizer?.committed;
    if (committed === undefined) return;
    const viaSystem = system !== undefined && system === this.systemGrantToken;
    try {
      committed.call(this.executionAuthorizer, {
        op: "start",
        executionId,
        workflowId,
        ...(!viaSystem && principal !== undefined && { principal }),
        // Lineage is trusted only from the supervisor (system grant) or the fork path, never from
        // a caller-supplied `RunOptions.parentExecutionId` (an anonymous start must not seed the
        // owner table from a parent it names).
        ...(parentExecutionId !== undefined &&
          (viaSystem || viaFork || (lineage !== undefined && lineage === this.lineageToken)) && {
            parentExecutionId,
          }),
      });
    } catch (err) {
      // The start already happened; ownership bookkeeping must not undo or fail it. The starter
      // is left without a recorded owner (fail-closed), so say so.
      this.onWarn(`authorizer.committed threw for "${executionId}": ${String(err)}`);
    }
  }

  /**
   * R3 — existence is not an oracle for an ANONYMOUS caller under `strict`: an execution that
   * does not exist is judged by the authorizer BEFORE "not found" is revealed, so a principal-less
   * caller learns nothing from the difference (the policy sees `workflowId: ""` — there is none).
   * Deliberately NOT applied to a caller that presents a principal: `loadState(id, { principal })`
   * returning `null` is how an edge asks "does this exist?" before starting it, and a policy
   * cannot tell a free id from a forbidden one without breaking that. An identified caller can
   * therefore still tell "not found" from "denied" — documented residual. Off unless the
   * runtime fails closed.
   */
  private async denyMissing(
    op: ExecutionOp,
    executionId: string,
    principal: PrincipalChain | undefined,
    system: SystemGrant | undefined
  ): Promise<void> {
    if (
      !this.requirePrincipal ||
      principal !== undefined ||
      !this.authzApplies(principal, system)
    ) {
      return;
    }
    const denial = this.authzDenial(op, executionId, "", principal, system);
    if (denial !== undefined) {
      await this.denyOp(op, executionId, "", principal, denial.reason, undefined);
    }
  }

  /** Sequence 0 survives compaction, so its workflow id answers "what is this execution?". */
  private async workflowIdOf(executionId: string): Promise<string | undefined> {
    const first = (await readRangeOf(this.eventStore, executionId, 0, 0))[0];
    return first?.workflowId || undefined;
  }

  /** Fire the audit callback, best-effort record (resume/cancel), and throw. */
  private async denyOp(
    op: ExecutionOp,
    executionId: string,
    workflowId: string,
    principal: PrincipalChain | undefined,
    reason: string | undefined,
    recordAfterSequence: number | undefined
  ): Promise<never> {
    const request: ExecutionAuthzRequest = {
      op,
      executionId,
      workflowId,
      ...(principal !== undefined && { principal }),
    };
    this.onExecutionDenied?.(request, reason);
    if (recordAfterSequence !== undefined) {
      await this.recordExecutionDenied(
        op,
        executionId,
        workflowId,
        principal,
        reason,
        recordAfterSequence
      );
    }
    throw new ExecutionDeniedError(op, executionId, reason);
  }

  /**
   * Best-effort durable EXECUTION_DENIED audit fact. Appends WITHOUT a fence (never
   * disrupts a running execution) at `afterSequence + 1`; any rejection (stale fence,
   * sequence race) is swallowed — the record is audit, the throw is the enforcement.
   * Consecutive identical denials are deduped to bound write-amplification.
   */
  private async recordExecutionDenied(
    op: ExecutionOp,
    executionId: string,
    workflowId: string,
    principal: PrincipalChain | undefined,
    reason: string | undefined,
    afterSequence: number
  ): Promise<void> {
    const actor = principal?.actor;
    // Dedup consecutive identical denials so a flood of denied attempts can't bloat the
    // log (a DoS via write-amplification): if the tail is already an EXECUTION_DENIED
    // for the same op+actor, record nothing more. The throw still enforces every call.
    try {
      const tail = await this.eventStore.readFrom(executionId, afterSequence);
      const last = tail[tail.length - 1];
      if (last?.eventType === "EXECUTION_DENIED") {
        const p = last.payload as { op?: string; actor?: string };
        if (p.op === op && p.actor === actor) return;
      }
    } catch {
      // Read failure — fall through and attempt the record anyway.
    }
    const sequence = afterSequence + 1;
    const envelope: EventEnvelope = {
      id: `${executionId}-${sequence}-denied`,
      workflowId,
      executionId,
      eventType: "EXECUTION_DENIED",
      sequence,
      timestamp: this.now(),
      payload: {
        op,
        ...(reason !== undefined && { reason }),
        ...(actor !== undefined && { actor }),
      },
    };
    try {
      await this.eventStore.append(envelope);
      this.onEvent?.(envelope);
    } catch {
      // Fencing store with an active fence, or a sequence race — skip the record.
      // Enforcement already happened via the thrown ExecutionDeniedError.
    }
  }

  register(toolId: string, effect: Effect): void {
    this.effectRuntime.register(toolId, effect);
  }

  /**
   * Run a single registered effect ONCE, off the durable path — a thin delegate
   * to {@link EffectRuntime.invokeTransient} so an app that only holds the
   * top-level runtime gets the transient façade without reaching for the
   * effectRuntime. It writes NOTHING to this runtime's event store: no
   * `EXECUTION_STARTED`, no `STEP_*`, no snapshot, no fence (R1). Use it for
   * read-path hydration over an immutable manifest; `start()` a durable run only
   * when a state-changing outcome (drift repair, planning) must be recorded.
   * See {@link EffectRuntime.invokeTransient} for the full middleware/emit
   * contract.
   */
  invokeTransient<TIn = unknown, TOut = unknown>(
    toolId: string,
    input: TIn,
    opts?: TransientInvokeOptions
  ): Promise<TOut> {
    return this.effectRuntime.invokeTransient<TIn, TOut>(toolId, input, opts);
  }

  registerFlow<TIn, TOut>(
    definition: RegisteredFlow<TIn, TOut>["definition"],
    runner: FlowRunner<TIn, TOut>
  ): void {
    // K11.1/.2 — fingerprint the flow's fold-relevant structure and keep every
    // registered version (pinned resumption resolves an in-flight execution's
    // recorded hash to the version it started under). Re-registering the SAME
    // id+version+hash is idempotent (dev watch-mode must not error); the same
    // id+version with DIFFERENT content is a hard error — bump the version.
    assertFlowBudgets(definition);
    const hash = flowContentHash(definition);
    const versions = this.flowVersions.get(definition.id) ?? new Map();
    const existing = versions.get(definition.version);
    if (existing !== undefined && existing.hash !== hash) {
      throw new Error(
        `flow "${definition.id}" version "${definition.version}" re-registered with different ` +
          `content (${existing.hash} → ${hash}); bump the flow version or revert the change`
      );
    }
    const registered = { definition, runner } as RegisteredFlow;
    versions.set(definition.version, { flow: registered, hash });
    this.flowVersions.set(definition.id, versions);
    // The most recently registered version is the CURRENT one (used by start()
    // and as the resume default) — register the live version last, or rely on
    // pinned resumption to serve older in-flight executions.
    this.flows.set(definition.id, registered);
    this.flowHashes.set(definition.id, hash);
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

  /**
   * Whether a {@link ResumeAuthenticator} is wired (K12.2) — read by pre-flight
   * verification, which errors when a flow declares resume gates and nothing
   * authenticates the events that open them.
   *
   * Deliberately derived from the runtime rather than declared by the caller assembling
   * the check: a fitness rule you can satisfy by *asserting* you wired something is a
   * rule that passes for the app that forgot. Read-only and boolean — it exposes that
   * one is present, never the authenticator itself.
   */
  hasResumeAuthenticator(): boolean {
    return this.resumeAuthenticator !== undefined;
  }

  /**
   * Whether a `TimerStore` is wired. Read by pre-flight verification: with one,
   * a suspend's `wakeAt` is DERIVED from its `timeout`, so `suspend({ timeout })`
   * wakes across a restart; without one it silently does not (T1). Same
   * discipline as {@link hasResumeAuthenticator} — the check reads the real
   * wiring rather than accepting a caller's claim about it.
   *
   * Not a syscall: KERNEL_SYSCALLS and KERNEL_ABI_VERSION are untouched.
   */
  /**
   * The durable log this runtime writes to. Exposed for maintenance passes that must read
   * an execution's own metadata — `placementOf` (#392) reads the placement hint off
   * sequence 0 — so a caller wiring one does not have to hand over the same store twice and
   * risk the two disagreeing. Read-only by convention: nothing here writes through it.
   */
  get events(): EventStore {
    return this.eventStore;
  }

  /**
   * The runtime's injectable clock (`WorkflowRuntimeDeps.now`). `ctx.sleep` and
   * `suspend({ timeout })` compute their `wakeAt` with it, and `TimerService` defaults its
   * own `now` to it, so a wake time and the clock that judges it can never disagree.
   */
  get clock(): () => number {
    return this.now;
  }

  hasTimerStore(): boolean {
    return this.timerStore !== undefined;
  }

  /**
   * A registered effect's declared determinism-boundary mode (ADR 0073), read-only and
   * not a syscall. The verify adapter derives it from the real registry so the
   * `ctx.decide`-scope check cannot be satisfied by a caller who merely claims a mode.
   */
  effectModeOf(toolId: string): "journaled" | "ambient" | undefined {
    return this.effectRuntime.modeOf(toolId);
  }

  /** Whether an effect is registered under `toolId` (read-only; lets tooling tell "no mode" from "no effect"). */
  hasEffect(toolId: string): boolean {
    return this.effectRuntime.has(toolId);
  }

  /**
   * Advisory pre-warm (latency-only, off the durable path): spin up the cold
   * resources a flow's FIRST step will need — a K7 isolated child process, an
   * LLM provider connection — ahead of the run, so the initial latency the
   * caller waits on is hidden. Used by the {@link TimerService} to warm a
   * scheduled flow just before its (deterministic) fire time. No-op for an
   * unknown flow or one whose first effect has no warm hook; never authorizes,
   * meters, emits, or affects the fold (warming is not invoking, P10).
   */
  warmFlow(flowId: string): void {
    const flow = this.flows.get(flowId);
    const first = flow?.definition.steps[0];
    if (first === undefined) return;
    this.effectRuntime.warm(first.toolId ?? first.id);
  }

  /**
   * The resume INGRESS gate (#304/#305). `eventType` is caller-controlled all the way
   * from an ingress adapter — A2A `provideInput` and the wire-ABI `execution.resume`
   * both hand a network-supplied {@link ResumeEvent} straight to `resume()` — and it
   * was appended into the log verbatim. Two things were never asked:
   *
   * 1. **Is this a kernel event?** `handlers` folds by NAME, so a resume typed
   *    `STEP_COMPLETED` forged a step outcome that the completed short-circuit then
   *    served without running the effect; `EXECUTION_MIGRATED` rewrote the K11 code
   *    pin and `_input`; `APPROVAL_GRANTED` forged the K12.2 evidence the
   *    authenticator exists to produce. `getHandler` already hardened the *unknown*
   *    name (`__proto__`) and stopped one step short of the known ones.
   * 2. **Is this the gate the execution is parked on?** `suspendedOn.on` was folded
   *    and then read by nothing, so any name resumed any gate — which also skipped
   *    the ADR 0077 `resumeSchemas` lookup, since that keys off the caller's
   *    `eventType`. A declared shape gate was evaded by renaming the event.
   *
   * Refusing is fold-identical for every legitimate log: a non-kernel `eventType`
   * already folds to a no-op, so today's resume-typed event contributes nothing
   * unless it collides with a kernel name (G2).
   *
   * `EXECUTION_RECOVERED` is the one non-gate resume: a dispatcher re-driving a
   * crashed execution, which is `running`/`pending` and has no `suspendedOn`. Being
   * no gate's answer, it records no `EXECUTION_RESUMED` either (ADR 0104, `answerEvents`).
   */
  private assertResumable(
    executionId: string,
    state: ExecutionState,
    event: ResumeEvent,
    /**
     * `resumeAs` onto a CRASHED or TERMINAL execution checks the kernel namespace and
     * stops there: nothing is parked, so there is no gate to name, and migrating a
     * crashed execution onto fixed code is the documented exit from
     * {@link FlowCodeMismatchError}. Onto an execution PARKED at a gate it runs every
     * check (ADR 0104): the resume is that gate's answer, so it must name the recorded
     * gate — which the operator can read, even if the target flow renamed it — and pass
     * that gate's declared shape, or any event name would answer it unchecked.
     */
    checks: "all" | "kernel-namespace-only" = "all",
    system?: SystemGrant
  ): void {
    const { eventType } = event;

    if (eventType === EXECUTION_RECOVERED && checks === "all") {
      // Crash recovery, not a gate. A parked or terminal execution has nothing to
      // re-drive, so this is refused everywhere the dispatcher would not send it.
      if (state.status !== "running" && state.status !== "pending") {
        throw new ResumeRefusedError(
          executionId,
          eventType,
          "not-suspended",
          `recovery re-drive addresses a crashed (running/pending) execution; this one is "${state.status}"`
        );
      }
      return;
    }

    // Checked BEFORE state, because it holds regardless of state: no reachable
    // condition makes a caller-supplied kernel event legitimate. TIMER_FIRED is the
    // one governed exception — the kernel raises it itself to wake a timed suspend,
    // and the gate check below still requires the execution to be parked on it.
    if (eventType !== TIMER_FIRED && KERNEL_EVENT_TYPES.has(eventType)) {
      throw new ResumeRefusedError(
        executionId,
        eventType,
        "kernel-event-type",
        `"${eventType}" is a kernel event type (EVENT_SCHEMA ${EVENT_SCHEMA_VERSION}); only the kernel writes those, and folding a caller-supplied one would forge kernel state. Name the gate something outside the kernel namespace.`
      );
    }

    if (checks === "kernel-namespace-only") return;

    if (state.status !== "suspended") {
      throw new ResumeRefusedError(
        executionId,
        eventType,
        "not-suspended",
        `the execution is "${state.status}", not parked at a gate. Nothing was appended.`
      );
    }

    const condition = state.suspendedOn;
    // A TIMED suspend has TWO legitimate wakes, and `on` names only one of them:
    // `suspend({ on: "Approval", timeout })` is answered either by the approval or by
    // the timer, which fires as TIMER_FIRED whatever the gate is called (the runtime
    // derives `wakeAt` from `timeout` when a TimerStore is wired, T1/A3). Keyed on the
    // recorded `wakeAt`, so an UNTIMED gate is not wakeable by a synthetic timer event.
    const timedWake = eventType === TIMER_FIRED && condition?.wakeAt !== undefined;
    // R13 — TIMER_FIRED is the kernel's own wake (the TimerService passes the system grant).
    // On a runtime that fails closed, a caller without the grant may not raise it: it would
    // answer any TIMED gate — an approval gate included — past the digest and the authenticator.
    if (
      eventType === TIMER_FIRED &&
      this.systemGrantToken !== undefined &&
      system !== this.systemGrantToken
    ) {
      throw new ResumeRefusedError(
        executionId,
        eventType,
        "timer-wake-not-system",
        `"${TIMER_FIRED}" is raised by the kernel's TimerService, not by a caller; this runtime fails closed, so a resume that does not carry the system grant is refused. Nothing was appended.`
      );
    }
    if (condition?.on !== eventType && !timedWake) {
      throw new ResumeRefusedError(
        executionId,
        eventType,
        "gate-mismatch",
        `the execution is parked on "${condition?.on ?? "<unknown>"}"${
          condition?.wakeAt !== undefined ? ` (or ${TIMER_FIRED}, a timed suspend)` : ""
        }. A resume must name the gate it answers — the flow's declared resumeSchemas entry is looked up by this name, so a mismatched one would also skip the shape check (ADR 0077).`
      );
    }

    // R13 (ADR 0117) — an approval is bound to what the approver SAW. A gate that declared a
    // `viewDigest` is answered only by a payload echoing it. Not applied to a timer wake (the
    // kernel's own event, no approver). Last, so the digest is learned only by a caller who
    // already named the right gate.
    const expected = condition?.viewDigest;
    if (expected !== undefined && !timedWake) {
      const echoed = (event.payload as { viewDigest?: unknown } | null | undefined)?.viewDigest;
      if (echoed !== expected) {
        throw new ResumeRefusedError(
          executionId,
          eventType,
          "view-digest-mismatch",
          `the gate "${eventType}" was parked on a specific proposal and the resume does not carry its digest (${
            typeof echoed === "string"
              ? "it carries a different one — a stale view"
              : "none supplied"
          }). Re-read the parked state, show the approver the CURRENT proposal, and resume with payload.viewDigest = state.suspendedOn.viewDigest. Nothing was appended.`
        );
      }
    }
  }

  /**
   * R13 — what a resume RECORDS. A `TIMER_FIRED` wake is the kernel's, so its payload is exactly
   * `{ wakeAt }` from the recorded park: whatever a caller put in it (`{ approved: true }` on a
   * timed approval gate) never reaches the flow. Every other event records its parsed payload.
   */
  private recordedPayload(event: ResumeEvent, state: ExecutionState, parsed: unknown): unknown {
    if (event.eventType !== TIMER_FIRED) return parsed;
    const wakeAt = state.suspendedOn?.wakeAt;
    return wakeAt === undefined ? parsed : { wakeAt };
  }

  /**
   * ADR 0104 D2 — flag a log in which a pre-0104 kernel recorded a gate passthrough that
   * answered no gate. The fold still serves it (withdrawing one already spent would re-park
   * the flow behind recorded steps, or shift every later payload one gate early), so the
   * runtime says which executions carry one and whether it is spent ("passed": audit) or not
   * ("at-risk": the next gate will pass with it). Once per execution and verdict per runtime,
   * in a bounded set, so a long-lived execution does not warn on every resume forever.
   */
  /** Warn once per key (bounded memory, FIFO eviction). */
  private warnStrayOnce(key: string, message: () => string): void {
    if (this.warnedStrayPassthroughs.has(key)) return;
    if (this.warnedStrayPassthroughs.size >= STRAY_WARNING_MEMORY) {
      // FIFO eviction: a Set iterates in insertion order.
      const oldest = this.warnedStrayPassthroughs.values().next().value;
      if (oldest !== undefined) this.warnedStrayPassthroughs.delete(oldest);
    }
    this.warnedStrayPassthroughs.add(key);
    this.onWarn(message());
  }

  /** Remember (or forget) the scanner of a whole-log scan, only when it came back clean. */
  private noteStrayScan(
    executionId: string,
    scanner: StrayScanner,
    definition: FlowDefinition<unknown, unknown>,
    reopening: boolean,
    report: { verdict?: unknown; ambiguousHumanStep?: unknown }
  ): void {
    this.strayScans.delete(executionId);
    const clean =
      !reopening && report.verdict === undefined && report.ambiguousHumanStep === undefined;
    if (!clean) return;
    if (this.strayScans.size >= STRAY_WARNING_MEMORY) {
      // FIFO eviction: a Map iterates in insertion order.
      const oldest = this.strayScans.keys().next().value;
      if (oldest !== undefined) this.strayScans.delete(oldest);
    }
    this.strayScans.set(executionId, { scanner, definition });
  }

  /** Scan a whole retained log and remember the result if clean. */
  private scanWholeLog(
    executionId: string,
    events: readonly EventEnvelope[],
    state: ExecutionState,
    definition: FlowDefinition<unknown, unknown>,
    reopening: boolean
  ): StrayPassthroughReport {
    const scanner = new StrayScanner(this.stepKindResolver(definition));
    scanner.feed(events);
    const report = scanner.report(state, { reopening });
    this.noteStrayScan(executionId, scanner, definition, reopening, report);
    return report;
  }

  private checkStrayPassthroughs(
    executionId: string,
    report: StrayPassthroughReport,
    state: ExecutionState,
    discard: ResumeEvent["discardLegacyAnswers"],
    approval: { eventType: string; payload: unknown } | undefined
  ): Array<{ eventType: string; payload: unknown }> {
    const ambiguous = report.ambiguousHumanStep;
    if (ambiguous !== undefined || discard !== undefined) {
      // A refused (or discarding) resume must never leave a "clean" entry behind.
      this.strayScans.delete(executionId);
    }
    if (discard !== undefined) {
      if (
        ambiguous === undefined ||
        discard.stepId !== ambiguous ||
        !Number.isSafeInteger(discard.count) ||
        discard.count < 0
      ) {
        throw new Error(
          `discardLegacyAnswers refused for execution "${executionId}": ${
            ambiguous === undefined
              ? "its log holds no ambiguous pre-ADR 0104 human-step answers"
              : `the ambiguous human step is "${ambiguous}", and count must be a non-negative integer`
          }. Nothing was appended.`
        );
      }
    } else if (ambiguous !== undefined) {
      throw new ResumeRefusedError(
        executionId,
        state.suspendedOn?.on ?? "<none>",
        "ambiguous-legacy-answers",
        `human step "${ambiguous}" was parked by a pre-ADR 0104 kernel, and its log holds answers that cannot be told apart (it re-parked after an answer, or a recovery/in-doubt payload that answered no gate precedes it). Resuming would hand one of them to a later gate as its approval. Nothing was appended. Inspect the log, then resume with a SIGNED event carrying discardLegacyAnswers: { stepId: "${ambiguous}", count } to discard the entries that are not its answer, or cancel the execution.`
      );
    }
    const verdict = report.verdict;
    if (verdict !== undefined) {
      this.warnStrayOnce(`${verdict.kind}:${executionId}`, () =>
        strayPassthroughMessage(executionId, verdict)
      );
    }
    return discard === undefined
      ? []
      : [
          {
            eventType: "DECISION_RECORDED",
            payload: {
              decisionId: discardDecisionId(discard.stepId),
              choice: discard.count,
              source: "operator",
              rationale: {
                adr: "0104",
                override: "discardLegacyAnswers",
                approval: approval?.payload, // { actor, verifiedBy, on } — who signed it
              },
            },
          },
        ];
  }

  /**
   * `stepId → the effect kind it runs`, resolved the way `ctx.run` resolves a tool id: the
   * declared step's `toolId`, else the id itself. `undefined` for a dynamic step the runtime
   * cannot resolve — the stray classifier treats that as possibly human (fail closed).
   */
  private stepKindResolver(
    definition: FlowDefinition<unknown, unknown>
  ): (stepId: string) => string | undefined {
    const toolOf = new Map<string, string>();
    for (const step of definition.steps) toolOf.set(step.id, step.toolId ?? step.id);
    return (stepId) => this.effectRuntime.kindOf(toolOf.get(stepId) ?? stepId);
  }

  /**
   * R13 — the sequence of the `EXECUTION_SUSPENDED` that parked this execution: the identity of
   * THIS park, which a signed approval is bound to (single use — a later park of the same gate
   * has a later sequence, and a fork has a different execution id). The park is NOT the folded
   * tip: audit events (`EXECUTION_DENIED`) and parallel siblings' completions are appended after
   * it, any number of them.
   *
   * Found exactly, never guessed: the newest `EXECUTION_SUSPENDED` in the events in hand; else a
   * walk BACK from `searchFrom` (the newest sequence the events in hand do not cover) in
   * fixed-size indexed range reads, until it is found. No whole-log read, and no bound: the cost
   * is the number of events between the park and `searchFrom`, paid only when the park is not in
   * hand. `undefined` when it is not parked, or when the park is gone from the log (compacted
   * away) — the caller refuses; it never substitutes the tip.
   */
  private async locatePark(
    executionId: string,
    state: ExecutionState,
    held: {
      events: readonly { eventType: string; sequence: number }[] | undefined;
      complete: boolean;
      searchFrom?: number;
    }
  ): Promise<number | undefined> {
    if (state.status !== "suspended") return undefined;
    const inHand = lastSuspendSequence(held.events);
    if (inHand !== undefined) return inHand;
    if (held.complete) return undefined;
    const CHUNK = 64;
    let hi = held.searchFrom ?? state.sequence;
    while (hi >= 0) {
      const lo = Math.max(0, hi - CHUNK + 1);
      const got = await readRangeOf(this.eventStore, executionId, lo, hi);
      for (let i = got.length - 1; i >= 0; i--) {
        const e = got[i];
        if (e !== undefined && e.eventType === "EXECUTION_SUSPENDED") return e.sequence;
      }
      if (got.length < hi - lo + 1) return undefined; // a gap: compacted away
      hi = lo - 1;
    }
    return undefined;
  }

  /**
   * R13 — the park identity (see {@link WorkflowRuntime.locatePark}) of a parked execution,
   * for the approver's side: sign `{ executionId, parkedAtSequence }` into the approval with
   * `signResume`. Gated like `loadState` (a query). `undefined` when the execution is unknown,
   * not parked, or its park was compacted out of the log.
   */
  async parkedAtSequence(
    executionId: string,
    options?: { principal?: PrincipalChain; system?: SystemGrant }
  ): Promise<number | undefined> {
    const state = await this.loadState(executionId, options);
    if (state === null || state.status !== "suspended") return undefined;
    return this.locatePark(executionId, state, { events: undefined, complete: false });
  }

  // K12.2 — verify an approval-gating resume event. Returns an APPROVAL_GRANTED
  // bootstrap event to record when verified; `undefined` for an ordinary resume;
  // throws ApprovalRejectedError when the authenticator rejects it (forged).
  private verifyApproval(
    executionId: string,
    resumeEvent: ResumeEvent,
    park: {
      parkedAtSequence: number | undefined;
      principal: PrincipalChain | undefined;
      /** The execution is parked but its park could not be located (compacted away). */
      parkNotLocated?: boolean;
    }
  ): { eventType: string; payload: unknown } | undefined {
    if (this.resumeAuthenticator === undefined) return undefined;
    const verdict = this.resumeAuthenticator.verify(resumeEvent, {
      executionId,
      parkedAtSequence: park.parkedAtSequence,
      principal: park.principal,
    });
    if (verdict.status === "not-applicable") return undefined;
    if (verdict.status === "rejected") {
      if (park.parkNotLocated === true) {
        throw new ApprovalRejectedError(
          executionId,
          "park-not-located: the EXECUTION_SUSPENDED this approval would be bound to is no longer in the log (compacted away), so the approval cannot be tied to a park"
        );
      }
      throw new ApprovalRejectedError(executionId, verdict.reason);
    }
    return {
      eventType: "APPROVAL_GRANTED",
      payload: { actor: verdict.actor, verifiedBy: verdict.verifiedBy, on: resumeEvent.eventType },
    };
  }

  /**
   * TR (ADR 0077) — parse a resume payload against the flow's declared gate contract.
   *
   * Returns the value to RECORD: the parsed one (Zod defaults/transforms applied) when a
   * schema is declared for this gate, otherwise the payload untouched. Called before anything
   * is appended, because a resume payload cannot be rejected retroactively — once it is in the
   * log it is a permanent fold input.
   *
   * The event type is caller-controlled, so the lookup uses `Object.hasOwn` rather than plain
   * indexing: `resumeSchemas["constructor"]` would otherwise resolve up the prototype chain to
   * a function with no `safeParse`, turning a hostile event type into a TypeError (or, on a
   * map built with a `toString` key, into a silently skipped gate).
   */
  private parseResumePayload(
    executionId: string,
    definition: FlowDefinition<unknown, unknown>,
    resumeEvent: ResumeEvent
  ): unknown {
    const schemas = definition.resumeSchemas;
    if (schemas === undefined || !Object.hasOwn(schemas, resumeEvent.eventType)) {
      return resumeEvent.payload;
    }
    const schema = schemas[resumeEvent.eventType];
    if (schema === undefined) return resumeEvent.payload;
    const parsed = schema.safeParse(resumeEvent.payload);
    if (!parsed.success) {
      throw new ResumePayloadValidationError(
        executionId,
        resumeEvent.eventType,
        parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")
      );
    }
    return parsed.data;
  }

  // K11.1/.2 — resolve the flow CODE an execution must resume on:
  //  1. follow a durable migration pointer (`_migratedTo`, K11.3) if present;
  //  2. the current version when its hash matches the recorded one (or the log
  //     recorded none — legacy, G2 — or the operator explicitly acked);
  //  3. PINNED RESUMPTION: any other registered version whose hash matches the
  //     recorded one — the execution resumes on the code it started under;
  //  4. otherwise refuse loudly (never silently fold with changed code).
  private resolveFlowFor(
    executionId: string,
    workflowId: string,
    state: ExecutionState,
    options: RunOptions | undefined
  ): RegisteredFlow {
    const targetId =
      typeof state.variables._migratedTo === "string" ? state.variables._migratedTo : workflowId;
    const current = this.flows.get(targetId);
    if (!current) {
      throw new Error(`No flow registered for workflowId: "${targetId}"`);
    }
    const recorded = state.variables._flowHash;
    if (typeof recorded !== "string" || options?.allowFlowCodeMismatch === true) {
      return current;
    }
    if (this.flowHashes.get(targetId) === recorded) {
      return current;
    }
    const versions = this.flowVersions.get(targetId);
    if (versions !== undefined) {
      for (const v of versions.values()) {
        if (v.hash === recorded) return v.flow;
      }
    }
    throw new FlowCodeMismatchError(
      executionId,
      targetId,
      recorded,
      this.flowHashes.get(targetId) ?? "unregistered"
    );
  }

  /**
   * K9.4 — acquire the next monotonic fencing token for an execution, when the
   * event store supports fencing. Returns `undefined` on a non-fencing store
   * (e.g. single-node SQLite), so callers can thread it opportunistically:
   * `const fence = await runtime.acquireFence(id);`
   * `resume(id, event, { ...(fence !== undefined && { fence }) })`.
   *
   * Acquiring a fence SUPERSEDES whoever holds the current one — that is its purpose on a
   * re-dispatch. So do not acquire one to START a caller-chosen id that another node may have
   * started already (L12, ADR 0103): if that execution exists and is running, the new token
   * fences its live runner out mid-body, after its first effect has been paid for, and a
   * recovery pass pays for it again. A start needs no fence: the durable bootstrap refuses a
   * duplicate at sequence 0, and an execution started unfenced is still fenced out by the
   * first later `acquireFence` (a fencing store refuses a MISSING token once one exists).
   */
  async acquireFence(
    executionId: string,
    options?: { principal?: PrincipalChain; system?: SystemGrant; gateAs?: "resume" }
  ): Promise<number | undefined> {
    // R3 — a fence SUPERSEDES the current holder (a kill-class effect), and one acquired for an
    // id nobody has written poisons a later start of it, so it is gated like the ops it
    // enables: `cancel` on an execution that exists, `start` on one that does not.
    if (this.authzApplies(options?.principal, options?.system)) {
      const workflowId = await this.workflowIdOf(executionId);
      // `gateAs: "resume"` — a dispatcher fencing an EXISTING execution to RESUME it (not to kill
      // it) is judged as the resume it enables, so a `cancel: "deny"` policy does not refuse a
      // legitimate dispatched resume (and the audit names the op that was attempted).
      const op: ExecutionOp = workflowId === undefined ? "start" : (options?.gateAs ?? "cancel");
      const denial = this.authzDenial(
        op,
        executionId,
        workflowId ?? "",
        options?.principal,
        options?.system,
        workflowId === undefined
          ? undefined
          : await this.ownerForAuthz(executionId, options?.principal, options?.system)
      );
      if (denial !== undefined) {
        await this.denyOp(
          op,
          executionId,
          workflowId ?? "",
          options?.principal,
          denial.reason,
          undefined
        );
      }
    }
    return this.fenceOf(executionId);
  }

  /**
   * ADR 0118 D2 — answer the park at `parkSeq` under a CONDITIONAL fence (see
   * {@link RunOptions.fenceIfParkedAt}). The resume was already authorized and validated by the
   * caller; this only decides which fence token the append carries.
   */
  private async acquireFenceIfParked(
    executionId: string,
    resumeEvent: ResumeEvent,
    parkSeq: number,
    system: SystemGrant | undefined,
    /** What the caller already folded and read: spares a read of the park and a re-fold. */
    held: { vm: ReplayVM; events: readonly EventEnvelope[] | undefined }
  ): Promise<{ fence: number | undefined; vm: ReplayVM }> {
    const store = this.eventStore;
    // A store without the conditional keeps today's behaviour (the unconditional acquire and its
    // documented residual); one without fencing at all yields no token.
    if (store.acquireFenceIf === undefined) {
      return { fence: await this.fenceOf(executionId), vm: held.vm };
    }
    const notSuspended = (detail: string): ResumeRefusedError =>
      new ResumeRefusedError(executionId, resumeEvent.eventType, "not-suspended", detail);
    const park =
      held.events?.find((e) => e.sequence === parkSeq) ??
      (await readRangeOf(store, executionId, parkSeq, parkSeq))[0];
    if (park === undefined || park.eventType !== "EXECUTION_SUSPENDED") {
      throw notSuspended(`no park at sequence ${parkSeq}. Nothing was appended.`);
    }
    // The token the park was written under; a never-fenced execution is 0. It goes stale forever
    // once anyone acquires without appending, which is what the retry below handles.
    const recorded = park.metadata?.fence;
    let fence = typeof recorded === "number" && Number.isSafeInteger(recorded) ? recorded : 0;
    for (let attempt = 1; attempt <= FENCE_IF_ATTEMPTS; attempt++) {
      const got = await store.acquireFenceIf(executionId, { fence, parkSeq });
      if (!("stale" in got)) {
        // Defence in depth for a store whose condition is weaker than the SPI's: the park must
        // still be this unanswered one UNDER the fence we now hold.
        // The fold in hand plus whatever was appended since (one tail read, folded incrementally —
        // the same fold a fresh `loadState` would produce).
        // The caller MUST run from the advanced VM (returned): an ignorable append (an unfenced
        // EXECUTION_DENIED, an app emit) between its fold and this acquire would otherwise make
        // `execute` append at a stale sequence — a burned token and nothing appended.
        const heldState = held.vm.getState();
        const tail = await store.readFrom(executionId, heldState.sequence + 1);
        const vm = tail.length === 0 ? held.vm : new ReplayVM(tail, heldState);
        this.assertResumable(executionId, vm.getState(), resumeEvent, "all", system);
        return { fence: got.fence, vm };
      }
      // Stale: the token moved, or an answering event is past the park. Re-read the park. If it is
      // still THIS park, unanswered, the token moved only because someone acquired and never
      // appended; retry on the token the store returned (never the envelope's, which a dead
      // acquirer strands) with the SAME `parkSeq`. The store, not this re-read, refuses a retry
      // whose park a rival has since answered.
      const state = await this.foldState(executionId);
      if (
        state === null ||
        state.status !== "suspended" ||
        (await this.locatePark(executionId, state, { events: undefined, complete: false })) !==
          parkSeq
      ) {
        throw notSuspended(
          `the park at sequence ${parkSeq} is no longer the execution's unanswered park. Nothing was appended.`
        );
      }
      fence = got.fence;
    }
    throw new ResumeContendedError(executionId, FENCE_IF_ATTEMPTS);
  }

  /** The ungated fence acquisition, for callers that already authorized the op. */
  private async fenceOf(executionId: string): Promise<number | undefined> {
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
  async cancel(
    executionId: string,
    reason?: unknown,
    options?: { principal?: PrincipalChain; system?: SystemGrant }
  ): Promise<boolean> {
    assertNotReserved(executionId);
    const live = this.liveHandles.get(executionId);

    // C.1 — gate the cancel (only when configured AND a principal is present). Use the
    // live handle's state when running here, else fold; a denial is best-effort
    // recorded WITHOUT a fence (never disrupts the still-running execution).
    if (this.authzApplies(options?.principal, options?.system)) {
      const gate = live?.getState() ?? (await this.foldState(executionId));
      if (gate === null || gate === undefined) {
        await this.denyMissing("cancel", executionId, options?.principal, options?.system);
        throw new Error(`No execution found for id: ${executionId}`);
      }
      const cancelDenial = this.authzDenial(
        "cancel",
        executionId,
        gate.workflowId,
        options?.principal,
        options?.system,
        await this.ownerForAuthz(executionId, options?.principal, options?.system)
      );
      if (cancelDenial !== undefined) {
        await this.denyOp(
          "cancel",
          executionId,
          gate.workflowId,
          options?.principal,
          cancelDenial.reason,
          gate.sequence
        );
      }
    }

    if (live !== undefined) {
      live.cancel(reason);
      return true;
    }
    const state = await this.foldState(executionId);
    if (state === null) {
      throw new Error(`No execution found for id: ${executionId}`);
    }
    if (
      state.status === "completed" ||
      state.status === "failed" ||
      state.status === "cancelled" ||
      state.status === "continued" // ADR 0109: terminal; the chain's cancel is the writer-era follow-up
    ) {
      return false;
    }
    const fence = await this.fenceOf(executionId);
    const sequence = state.sequence + 1;
    const envelope: EventEnvelope = {
      id: `${executionId}-${sequence}`,
      workflowId: state.workflowId,
      executionId,
      eventType: "EXECUTION_CANCELLED",
      sequence,
      timestamp: this.now(),
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
    // ADR 0107 — the same ids `start` refuses: a blank identity (the journal refuses it too)
    // and the control streams.
    assertNotReserved(preloadedState.executionId);
    // Before any read or append (see `start`): an invalid budget must leave the log untouched.
    assertValidBudget("deadlineMs", options?.deadlineMs, "restoreFromState options");
    // R3 — restoring a state IS driving that execution on, so it is gated and authenticated
    // exactly like `resume` (it used to skip both). The state is caller-supplied, so a denial
    // is reported but never written into the log under an unverified sequence.
    const restoreDenial = this.authzDenial(
      "resume",
      preloadedState.executionId,
      preloadedState.workflowId,
      options?.principal,
      options?.system,
      await this.ownerForAuthz(preloadedState.executionId, options?.principal, options?.system)
    );
    if (restoreDenial !== undefined) {
      await this.denyOp(
        "resume",
        preloadedState.executionId,
        preloadedState.workflowId,
        options?.principal,
        restoreDenial.reason,
        undefined
      );
    }
    // R13 — the park is where the log says it is, not the caller-supplied state's tip: audit
    // events (a denial) may trail it. Located only when an approval is to be verified.
    const restorePark =
      resumeEvent !== undefined &&
      this.resumeAuthenticator !== undefined &&
      preloadedState.status === "suspended"
        ? await this.locatePark(preloadedState.executionId, preloadedState, {
            events: undefined,
            complete: false,
          })
        : undefined;
    const restoreApproval =
      resumeEvent !== undefined
        ? this.verifyApproval(preloadedState.executionId, resumeEvent, {
            parkedAtSequence: restorePark,
            principal: options?.principal,
            parkNotLocated: restorePark === undefined && preloadedState.status === "suspended",
          })
        : undefined;
    if (resumeEvent !== undefined) {
      assertAuthorizedOverride(preloadedState.executionId, resumeEvent, restoreApproval);
    }
    // K11 — the preloaded state carries the recorded flow-code fingerprint;
    // restore resolves the same way a resume does: current code, a pinned
    // version matching the recorded hash, or a loud refusal.
    const flow = this.resolveFlowFor(
      preloadedState.executionId,
      preloadedState.workflowId,
      preloadedState,
      options
    );
    // ADR 0105 — a preloaded state is a stored fold (often a snapshot's): repair a pre-1.21.0
    // one the same way every snapshot read does.
    const vm = new ReplayVM([], normalizeSnapshotState(preloadedState));
    const originalInput = preloadedState.variables._input;
    return this.execute(
      preloadedState.executionId,
      preloadedState.workflowId,
      vm,
      flow.runner as FlowRunner<unknown, unknown>,
      originalInput,
      resumeEvent
        ? [
            ...(restoreApproval !== undefined ? [restoreApproval] : []),
            { eventType: resumeEvent.eventType, payload: resumeEvent.payload },
          ]
        : [],
      options?.fence,
      options?.deadlineMs ?? flow.definition.deadlineMs,
      // R3k (D2) — the effects run as the OWNER recorded in the log, never as the caller and
      // never as whatever `preloadedState.variables._principal` claims (caller-supplied, so a
      // doctored state cannot forge or strip the owner). `options.principal` stays the
      // lifecycle caller, used above for authorization and the approval check.
      await this.actingPrincipal(preloadedState.executionId, options?.principal)
    );
  }

  /**
   * Resolve what `start` was handed. A definition or id is looked up in the
   * registry; anything unregistered fails with the call that fixes it, because
   * "Property 'runner' is missing" is a description of the shape rather than of
   * the mistake.
   */
  private resolveFlow<TIn, TOut>(
    flow: RegisteredFlow<TIn, TOut> | FlowDefinition<TIn, TOut> | string
  ): RegisteredFlow<TIn, TOut> {
    if (typeof flow === "string" || (flow as FlowDefinition)._tag === "FlowDefinition") {
      const id = typeof flow === "string" ? flow : (flow as FlowDefinition).id;
      const registered = this.flows.get(id);
      if (registered === undefined) {
        throw new Error(
          `Flow "${id}" is not registered — call registerFlow(definition, runner) before start(), or pass { definition, runner }.`
        );
      }
      return registered as RegisteredFlow<TIn, TOut>;
    }
    assertFlowBudgets((flow as RegisteredFlow<TIn, TOut>).definition);
    return flow as RegisteredFlow<TIn, TOut>;
  }

  /**
   * Start an execution.
   *
   * `flow` may be a {@link RegisteredFlow}, a bare `FlowDefinition`, or a flow id —
   * the last two resolve through `registerFlow`, which already keeps every
   * definition with its runner. Accepting only the pair meant a caller who had
   * just registered a flow still had to rebuild `{ definition, runner }` by hand
   * to start it, and passing the definition failed with a structural error
   * listing missing properties rather than saying what to do.
   *
   * A `RegisteredFlow` still does NOT require prior registration: passing the
   * pair directly starts it as before.
   */
  async start<TIn = unknown, TOut = unknown>(
    flow: RegisteredFlow<TIn, TOut> | FlowDefinition<TIn, TOut> | string,
    input: TIn,
    options?: RunOptions
  ): Promise<ExecutionHandle> {
    // Validate the per-call budget BEFORE anything is appended: a caller-chosen id is
    // bootstrapped durably below (ADR 0103), so a late rejection would burn the id and leave
    // an abandoned EXECUTION_STARTED behind.
    assertValidBudget("deadlineMs", options?.deadlineMs, "start options");
    const executionId = options?.executionId ?? ulid();
    assertNotReserved(executionId);
    const { definition, runner } = this.resolveFlow(flow);

    // C.1 — gate the start (no execution exists yet, so no durable record).
    const startDenial = this.authzDenial(
      "start",
      executionId,
      definition.id,
      options?.principal,
      options?.system
    );
    if (startDenial !== undefined) {
      await this.denyOp(
        "start",
        executionId,
        definition.id,
        options?.principal,
        startDenial.reason,
        undefined
      );
    }

    // ADR 0051 D7 — opt-in contract enforcement at the boundary: the PARSED
    // value (Zod defaults/transforms applied) is what runs and is recorded;
    // invalid input refuses BEFORE anything is appended. Off = declaration-only
    // metadata, byte-identically (G2).
    let effectiveInput: unknown = input;
    if (this.validateInput && definition.inputSchema !== undefined) {
      const parsed = definition.inputSchema.safeParse(input);
      if (!parsed.success) {
        throw new InputValidationError(
          definition.id,
          executionId,
          parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")
        );
      }
      effectiveInput = parsed.data;
    }

    // Empty VM seeded with identity only; the EXECUTION_STARTED bootstrap event
    // (committed in execute) is what folds status → "running" at sequence 0.
    const vm = new ReplayVM([], {
      executionId,
      workflowId: definition.id,
      workflowVersion: definition.version,
    });

    // R3k (ADR 0111 D1) — the principal this execution OWNS, recorded on sequence 0. Built before
    // anything is appended, so an unrestorable delegation or a record the configuration forbids
    // (identity under strict without crypto/codec) refuses the start with the log empty. Every
    // 1.23.0 start writes one, `{ v: 1 }` at least, so "absent" means a legacy log only.
    const principalRecord = this.principalRecordFor(options?.principal);
    const actingAs = await rehydratePrincipal(principalRecord, executionId, {
      codec: this.principalCodec,
      resolver: this.principalResolver,
    });
    // `parent` (the supervisor's `parentExecutionId`) is lineage, not identity (D1). Recorded only
    // when trusted — the call carries the runtime's lineage grant or a valid system grant — in
    // EVERY mode, with or without an authorizer; an untrusted (caller-supplied) one is omitted,
    // so a non-supervisor caller can never pin another execution's retention (R8k predicate) or
    // forge lineage, and a recorded `parent` is always the kernel's.
    const parent =
      typeof options?.parentExecutionId === "string" &&
      options.parentExecutionId.length > 0 &&
      this.lineageTrusted(options)
        ? options.parentExecutionId
        : undefined;

    // K11.1 — record the flow-code fingerprint this execution starts under
    // (additive payload field; legacy logs without it resume unchecked).
    const flowHash = this.flowHashes.get(definition.id);
    const bootstrap: BootstrapEvent = {
      eventType: "EXECUTION_STARTED",
      payload: {
        input: effectiveInput,
        ...(flowHash !== undefined && { flowHash }),
        principal: principalRecord,
        ...(parent !== undefined && { parent }),
      },
      // #392 — where this execution belongs, recorded where it can be found again.
      // Sequence 0 is the execution's metadata anchor: `truncatePrefix` preserves it
      // through compaction, `deleteExecution` removes it with everything else, and
      // `metadata.fence` already established that operational, non-semantic data rides
      // here. Descriptive only — nothing folds it, so replay is untouched (G2).
      ...(options?.computeTarget !== undefined && {
        metadata: { computeTarget: options.computeTarget },
      }),
    };

    // ADR 0103 — a CALLER-CHOSEN id can already exist (a redelivered trigger, a second node
    // firing the same schedule occurrence), so its sequence 0 is made durable BEFORE the body
    // runs: the store's uniqueness refuses a duplicate here, before any effect, fold or
    // onEvent. A minted ulid cannot collide, so the default path pays no barrier and stays
    // byte-identical (the journal writes sequence 0 behind the fold, as before).
    if (options?.executionId !== undefined) {
      bootstrap.durable = await this.writeBootstrap(
        executionId,
        definition.id,
        bootstrap,
        options.fence
      );
    }
    // R3 — the start is committed (a caller-chosen id's sequence 0 is durable; a minted ulid
    // cannot collide), so only now does the authorizer learn who owns the id.
    this.notifyStarted(
      executionId,
      definition.id,
      options?.principal,
      options?.system,
      options?.parentExecutionId,
      false,
      options?.lineage
    );

    // Identity-guarded: a synchronous throw below must remove only THIS start's entry, never a
    // live execution's of the same id.
    const startRecord = { record: principalRecord, parent };
    this.startRecords.set(executionId, startRecord);
    try {
      return this.execute(
        executionId,
        definition.id,
        vm,
        runner as FlowRunner<unknown, unknown>,
        effectiveInput,
        [bootstrap],
        options?.fence,
        options?.deadlineMs ?? definition.deadlineMs,
        actingAs
      );
    } catch (err) {
      if (this.startRecords.get(executionId) === startRecord) this.startRecords.delete(executionId);
      throw err;
    }
  }

  /**
   * ADR 0103 — the bootstrap barrier. Builds sequence 0 exactly as the journal would
   * (`ExecutionJournal.bootstrapEnvelope`: same id, injected-clock timestamp and fence) and
   * awaits its append. Only a CONFIRMED conflict — the store refused the write AND this
   * execution's sequence 0 is readable through the same store — is
   * {@link ExecutionAlreadyExistsError}. Every other failure refuses the start with
   * {@link StorageWriteError} (reported to `onStorageError` like a journal write failure).
   * Either way nothing has run.
   *
   * Why confirm rather than trust the error: a conflict is not always about THIS write.
   * `CoalescingEventStore` rejects every caller in a failed batch with the same error, so a
   * fresh id that shared a batch with a real duplicate receives the duplicate's
   * `DuplicateSequenceError` while nothing of its own was written (the batch is
   * all-or-nothing). And `err.executionId` cannot tell the cases apart: in a coalesced batch it
   * names whichever writer failed the batch, not necessarily this one. (A scoping decorator
   * reports the caller's id — `TenantScopedEventStore` unscopes its refusals, L20 — but that
   * does not help with a batch-mate's error.) So: read sequence 0 back; if it is absent, the
   * conflict was someone else's — retry the append ONCE, alone.
   *
   * A {@link StaleFenceError} is treated the same way (L12): an existing execution that has
   * been fenced refuses a duplicate's sequence 0 on the fence before the slot, so it is
   * {@link ExecutionAlreadyExistsError} when sequence 0 reads back, and otherwise (a token
   * acquired for an id nobody has written, or a batch-mate's zombie write) a single retry and
   * then {@link StorageWriteError}.
   *
   * L20 — when BOTH tries were refused on the fence and sequence 0 is still absent, the cause is
   * {@link StartFencedOutError}, never the bare `StaleFenceError`. A newer token exists but its
   * holder has written nothing — it may have died between `acquireFence` and its bootstrap — so
   * this is not "another holder owns the execution": a dispatcher must be free to retry (the
   * retry takes a newer fence and starts; nothing ran, so it is cheap). Were it the bare stale
   * fence, `isSupersededRefusal` would settle the dispatch and the start would be lost outright:
   * an empty log that no recovery pass can see. A LIVE racer that later writes sequence 0 makes
   * the retry lose cleanly as {@link ExecutionAlreadyExistsError}.
   */
  private async writeBootstrap(
    executionId: string,
    workflowId: string,
    bootstrap: BootstrapEvent,
    fence: number | undefined
  ): Promise<EventEnvelope> {
    const envelope = ExecutionJournal.bootstrapEnvelope(
      { executionId, workflowId },
      bootstrap.eventType,
      bootstrap.payload,
      {
        ...(bootstrap.metadata !== undefined && { metadata: bootstrap.metadata }),
        ...(fence !== undefined && { fence }),
        now: this.now,
      }
    );
    const refuse = (err: unknown): never => {
      this.onStorageError?.(executionId, err);
      throw new StorageWriteError(err);
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // The retry goes out ALONE: `appendBatch` is a batch of its own on a coalescing store
        // (it skips the queue and flushes by itself). A retry through `append` would rejoin the
        // queue, where two same-id starts share a batch again, both fail again, and neither
        // starts (L12 review).
        if (attempt === 0) await this.eventStore.append(envelope);
        else await appendBatchOf(this.eventStore, [envelope]);
        return envelope;
      } catch (err: unknown) {
        // L12 — a stale fence at sequence 0 is confirmed exactly like a conflict: the
        // execution may exist and be fenced (then this start is a duplicate), or the rejection
        // may be a coalesced batch's zombie error that says nothing about this write.
        if (!isWriteConflict(err) && !isStaleFence(err)) return refuse(err);
        let exists: boolean;
        try {
          exists = (await readRangeOf(this.eventStore, executionId, 0, 0)).length > 0;
        } catch (readErr: unknown) {
          return refuse(readErr);
        }
        if (exists) throw new ExecutionAlreadyExistsError(executionId, err);
        if (attempt === 1) {
          // Conflicted twice with no sequence 0 of ours. A stale fence here names a holder that
          // has written nothing, so it must stay retryable (L20): re-cause it.
          return refuse(isStaleFence(err) ? new StartFencedOutError(executionId, err) : err);
        }
      }
    }
    /* c8 ignore next */
    throw new Error("unreachable");
  }

  async resume(
    executionId: string,
    resumeEvent: ResumeEvent,
    options?: RunOptions
  ): Promise<ExecutionHandle> {
    // Before any read or append (see `start`): an invalid budget must leave the log untouched.
    assertValidBudget("deadlineMs", options?.deadlineMs, "resume options");
    // Guarded as well as `start`: a control stream is non-empty by construction, so without
    // this a caller could inject a resume event straight into the retention/erasure audit
    // trail even though creating one is now refused.
    assertNotReserved(executionId);
    // R1a — resume used to read the WHOLE log on every call, only to (a) take the first event's
    // identity/input and (b) feed the ADR 0104 legacy stray-passthrough scan. Neither needs the
    // log once a snapshot exists: the anchor is one indexed point-read of sequence 0 (the
    // `EXECUTION_STARTED` that `truncatePrefix` keeps; the same existence test `foldState`
    // uses), and the VM folds snapshot + tail. The stray scan is the one consumer of the full
    // log, and it can only ever find something in a log a PRE-ADR-0104 kernel wrote — a current
    // kernel records no gate-less non-null passthrough. So the first resume of an execution in
    // this process still scans the whole log, and only a scan that came back CLEAN is
    // remembered; from then on the log is read from the snapshot forward. An unclean log is
    // never remembered (it re-scans every time, as before), and `discardLegacyAnswers` always
    // forces the scan. Without a snapshot the log is the bounded read, so nothing changes.
    const snapshot = await this.snapshotStore.loadLatest(executionId);
    let allEvents: EventEnvelope[] | undefined;
    let firstEvent: EventEnvelope | undefined;
    // Events the carried scanner has not seen yet (fast path only).
    let scanTail: EventEnvelope[] | undefined;
    let tailEvents: EventEnvelope[] | undefined;
    const carried =
      snapshot !== null && resumeEvent.discardLegacyAnswers === undefined
        ? this.strayScans.get(executionId)
        : undefined;
    if (snapshot !== null && carried !== undefined) {
      const through = carried.scanner.through;
      const from = Math.min(snapshot.sequence, through) + 1;
      const tail = await this.eventStore.readFrom(executionId, from);
      const fresh = tail.filter((e) => e.sequence > through);
      // The scanner may only continue a gap-free log that still holds the event it consumed at
      // `through`: a log that now ends before `through` (rewound, or erased and re-created
      // shorter under the same id) re-scans from scratch, as does a gap. Envelope ids are
      // deterministic (`<exec>-<seq>`), so a log re-created to the SAME length is
      // indistinguishable here — a documented residual (ADR 0104 amendment); it matters only if
      // a pre-0104 writer then writes that re-created log.
      const atThrough =
        tail.find((e) => e.sequence === through) ??
        (through >= 0
          ? (await readRangeOf(this.eventStore, executionId, through, through))[0]
          : undefined);
      let contiguous = atThrough !== undefined && atThrough.id === carried.scanner.throughId;
      for (let i = 0; i < fresh.length; i++) {
        if (fresh[i]?.sequence !== through + 1 + i) {
          contiguous = false;
          break;
        }
      }
      if (contiguous) {
        firstEvent = (await readRangeOf(this.eventStore, executionId, 0, 0))[0];
        if (firstEvent !== undefined) {
          scanTail = fresh;
          tailEvents = tail.filter((e) => e.sequence > snapshot.sequence);
        }
      }
      if (firstEvent === undefined) this.strayScans.delete(executionId);
    }
    if (firstEvent === undefined) {
      allEvents = await this.eventStore.read(executionId);
      firstEvent = allEvents[0];
    }
    if (firstEvent === undefined) {
      await this.denyMissing("resume", executionId, options?.principal, options?.system);
      throw new Error(`No execution found for id: ${executionId}`);
    }
    const startPayload = firstEvent.payload as { input?: unknown };
    const originalInput = startPayload.input;

    const workflowId = firstEvent.workflowId;

    // NOTE: the runner/deadline come from resolveFlowFor below (current, pinned
    // version, or migrated target) — this lookup only seeds identity metadata,
    // and may legitimately be undefined when a migrated execution's ORIGINAL
    // flow id is no longer registered.
    const flow = this.flows.get(workflowId);

    let vm: ReplayVM;

    if (snapshot) {
      const eventsAfterSnapshot =
        tailEvents ?? (await this.eventStore.readFrom(executionId, snapshot.sequence + 1));
      vm = new ReplayVM(eventsAfterSnapshot, this.seedOf(snapshot, executionId, workflowId));
    } else {
      vm = new ReplayVM(allEvents as EventEnvelope[], {
        executionId,
        workflowId,
        workflowVersion: flow?.definition.version ?? "",
      });
    }

    // C.1 — gate the resume; the execution exists, so best-effort record the denial. It is
    // recorded after the FOLDED tip, not the log's last event: a log compacted at its tip is
    // `[0]` with the checkpoint above it, and a denial appended at `lastEvent + 1` landed in
    // the checkpoint's freed slot — the log then looked never-compacted and the next fold
    // started from scratch, losing the suspension (ADR 0106).
    const resumeDenial = this.authzDenial(
      "resume",
      executionId,
      workflowId,
      options?.principal,
      options?.system,
      await this.ownerForAuthz(executionId, options?.principal, options?.system, {
        first: firstEvent,
      })
    );
    if (resumeDenial !== undefined) {
      // recordExecutionDenied dedups consecutive identical denials internally.
      await this.denyOp(
        "resume",
        executionId,
        workflowId,
        options?.principal,
        resumeDenial.reason,
        vm.getState().sequence
      );
    }

    // K8.2 — cancelled is TERMINAL: a cancel-by-id of a suspended/detached
    // execution must not be undone by a later resume.
    if (vm.getState().status === "cancelled") {
      throw new Error(`Execution ${executionId} was cancelled; resume refused (terminal status)`);
    }

    // K11.5 — a previously-migrated execution resumes with its RECORDED migrated
    // input (folded `_input`), never the pre-migration EXECUTION_STARTED payload.
    const foldedInput = vm.getState().variables._input;
    const effectiveInput = foldedInput !== undefined ? foldedInput : originalInput;

    // K11 — resolve the CODE to resume on: the current version, a PINNED older
    // version whose hash matches the recorded one, a migrated target (K11.3), or
    // a loud refusal — never a silent fold with changed code (legacy logs = G2).
    const resolved = this.resolveFlowFor(executionId, workflowId, vm.getState(), options);

    // K12.2 — verify an approval that gates authority. A rejected (forged/
    // unverified) approval REFUSES the resume; a verified one records a durable
    // APPROVAL_GRANTED fact so "who approved" is evidence, not a claim.
    let parkedAt: number | undefined;
    if (this.resumeAuthenticator !== undefined && vm.getState().status === "suspended") {
      // The park may predate the snapshot (the carried fast path holds only the tail): then it
      // is at or before the snapshot, and is walked back to from there.
      parkedAt = await this.locatePark(executionId, vm.getState(), {
        events: allEvents ?? tailEvents,
        complete: allEvents !== undefined,
        ...(snapshot !== null && { searchFrom: snapshot.sequence }),
      });
    }
    const approval = this.verifyApproval(executionId, resumeEvent, {
      parkedAtSequence: parkedAt,
      principal: options?.principal,
      parkNotLocated: parkedAt === undefined && vm.getState().status === "suspended",
    });
    assertAuthorizedOverride(executionId, resumeEvent, approval);

    // #304/#305 — the ingress gate: WHICH event, to an execution in WHICH state. Placed
    // after the authenticator for the same reason the shape check is (below): the
    // gate-mismatch message names the gate the execution is parked on, which an
    // unauthenticated caller has no business learning.
    this.assertResumable(executionId, vm.getState(), resumeEvent, "all", options?.system);

    // TR (ADR 0077) — shape AFTER identity: the authenticator must see the exact event the
    // caller signed (a Zod transform could reshape it out from under a signature), and an
    // unauthenticated caller learns nothing about the gate's contract. Both refuse before
    // `execute`, so neither appends.
    const resumePayload = this.recordedPayload(
      resumeEvent,
      vm.getState(),
      this.parseResumePayload(executionId, resolved.definition, resumeEvent)
    );
    assertInDoubtVerdict(executionId, vm.getState(), resumePayload);
    assertNullAnswerTakes(executionId, resumeEvent.eventType, vm.getState(), resumePayload);

    let report: StrayPassthroughReport | undefined;
    if (scanTail !== undefined && carried !== undefined) {
      // R1a — continue the carried scan over the tail. Only a result that is still clean is
      // trusted; anything else (or code whose step kinds differ) re-scans the whole log.
      if (carried.definition === resolved.definition) {
        carried.scanner.feed(scanTail);
        const r = carried.scanner.report(vm.getState());
        if (r.verdict === undefined && r.ambiguousHumanStep === undefined) report = r;
      }
      if (report === undefined) {
        this.strayScans.delete(executionId);
        allEvents = await this.eventStore.read(executionId);
      }
    }
    report ??= this.scanWholeLog(
      executionId,
      allEvents as EventEnvelope[],
      vm.getState(),
      resolved.definition,
      false
    );
    const discardEvents = this.checkStrayPassthroughs(
      executionId,
      report,
      vm.getState(),
      resumeEvent.discardLegacyAnswers,
      approval
    );

    // ADR 0118 D2 — the conditional fence is taken LAST, after every check that can refuse without
    // appending: a fence acquired and then abandoned supersedes whoever holds the old one.
    // R3k (D2) — the owner recorded at sequence 0, on every resume path (an approval, a timer
    // wake, recovery, a remote worker): never the resumer. Computed BEFORE the acquire so the fence
    // is strictly last (an await that can throw between acquire and append burns the token).
    const acting = await this.actingPrincipal(executionId, options?.principal, {
      first: firstEvent,
    });
    let runVm = vm;
    let fence = options?.fence;
    if (options?.fenceIfParkedAt !== undefined) {
      const got = await this.acquireFenceIfParked(
        executionId,
        resumeEvent,
        options.fenceIfParkedAt,
        options.system,
        { vm, events: allEvents ?? tailEvents }
      );
      fence = got.fence;
      runVm = got.vm;
    }

    return this.execute(
      executionId,
      workflowId,
      runVm,
      resolved.runner as FlowRunner<unknown, unknown>,
      effectiveInput,
      [
        ...(approval !== undefined ? [approval] : []),
        ...discardEvents,
        { eventType: resumeEvent.eventType, payload: resumePayload },
        ...answerEvents(runVm.getState(), resumePayload),
      ],
      fence,
      options?.deadlineMs ?? resolved.definition.deadlineMs,
      acting
    );
  }

  /**
   * K11.3 — resume an execution ON DIFFERENT FLOW CODE, recording the migration
   * as a durable `EXECUTION_MIGRATED` fact (which also re-points the execution's
   * recorded `_flowHash`/`_migratedTo`, so subsequent resumes check against the
   * NEW code). Strategies:
   *
   *  - `"replay-check"` — prove fold-compatibility first: every step recorded in
   *    the log must still exist in the new flow (the same rule `@loom/deploy-sim`
   *    enforces as `step-removed`); an orphaned recorded step refuses the
   *    migration with {@link FlowMigrationCheckError}.
   *  - `"operator-ack"` — the operator vouches; no check.
   *
   * The migration is itself durable and replay-deterministic: replaying the log
   * re-applies the same verdict at the same sequence (G1).
   */
  async resumeAs(
    executionId: string,
    newFlowId: string,
    resumeEvent: ResumeEvent,
    options: {
      strategy: "replay-check" | "operator-ack";
      /**
       * K11.5 (ADR 0056) — contract-versioned state migration. The durable state
       * contract a resumed runner sees is its recorded input (folded `_input`);
       * when the target flow's contract evolved, supply the old→new transform
       * (typically a Zod transform's `parse`). The RESULT is recorded on
       * EXECUTION_MIGRATED (`migratedInput`), so every later resume/restore/
       * replay folds the same migrated value — the outcome is durable, not the
       * function. A throwing transform refuses the migration (StateMigrationError)
       * with nothing appended. Absent = today's behavior, byte-identical.
       */
      transformState?: (input: unknown) => unknown;
    } & Omit<RunOptions, "executionId" | "allowFlowCodeMismatch">
  ): Promise<ExecutionHandle> {
    // Before any read or append (see `start`): an invalid budget must leave the log untouched.
    assertValidBudget("deadlineMs", options.deadlineMs, "resumeAs options");
    assertNotReserved(executionId);
    const allEvents = await this.eventStore.read(executionId);
    if (allEvents.length === 0) {
      await this.denyMissing("resume", executionId, options.principal, options.system);
      throw new Error(`No execution found for id: ${executionId}`);
    }
    const firstEvent = allEvents[0]!;
    const originalInput = (firstEvent.payload as { input?: unknown }).input;
    const workflowId = firstEvent.workflowId;

    const target = this.flows.get(newFlowId);
    if (!target) {
      throw new Error(`No flow registered for workflowId: "${newFlowId}"`);
    }
    const toHash = this.flowHashes.get(newFlowId);

    const snapshot = await this.snapshotStore.loadLatest(executionId);
    let vm: ReplayVM;
    if (snapshot) {
      const tail = await this.eventStore.readFrom(executionId, snapshot.sequence + 1);
      vm = new ReplayVM(tail, this.seedOf(snapshot, executionId, workflowId));
    } else {
      vm = new ReplayVM(allEvents, {
        executionId,
        workflowId,
        workflowVersion: target.definition.version,
      });
    }
    const state = vm.getState();
    if (state.status === "cancelled") {
      throw new Error(`Execution ${executionId} was cancelled; resume refused (terminal status)`);
    }
    // ADR 0109: a continued execution handed its work to a successor; re-opening it would run
    // the same flow twice. Resume the head of the chain instead.
    if (state.status === "continued") {
      throw new Error(
        `Execution ${executionId} was continued as ${String(state.variables._continuedTo)}; resume refused (terminal status)`
      );
    }

    if (options.strategy === "replay-check") {
      // Fold-compatibility: a recorded step missing from the new flow means its
      // durable output is orphaned and the new runner would re-execute it live.
      const newStepIds = new Set(target.definition.steps.map((s) => s.id));
      const orphaned = Object.keys(state.frames).filter((stepId) => !newStepIds.has(stepId));
      if (orphaned.length > 0) {
        throw new FlowMigrationCheckError(executionId, newFlowId, orphaned);
      }
    }

    // K11.5 — the recorded input is the state contract carrier: prefer the folded
    // `_input` (which a PRIOR migration may already have replaced) over the raw
    // EXECUTION_STARTED payload.
    const recordedInput =
      state.variables._input !== undefined ? state.variables._input : originalInput;
    let migratedInput: unknown;
    let stateMigrated = false;
    if (options.transformState !== undefined) {
      try {
        migratedInput = options.transformState(recordedInput);
      } catch (err) {
        throw new StateMigrationError(executionId, newFlowId, String(err));
      }
      if (migratedInput === undefined) {
        throw new StateMigrationError(executionId, newFlowId, "transform returned undefined");
      }
      stateMigrated = true;
    }

    // C.1 / K12.2 — the same identity gates as `resume`. A migration that answers a parked
    // gate IS an approval of that gate; before ADR 0104 it skipped both.
    const resumeDenial = this.authzDenial(
      "resume",
      executionId,
      workflowId,
      options.principal,
      options.system,
      await this.ownerForAuthz(executionId, options.principal, options.system, {
        first: firstEvent,
      })
    );
    if (resumeDenial !== undefined) {
      await this.denyOp(
        "resume",
        executionId,
        workflowId,
        options.principal,
        resumeDenial.reason,
        state.sequence
      );
    }
    const migrationPark = await this.locatePark(executionId, state, {
      events: allEvents,
      complete: true,
    });
    const approval = this.verifyApproval(executionId, resumeEvent, {
      parkedAtSequence: migrationPark,
      principal: options.principal,
      parkNotLocated: migrationPark === undefined && state.status === "suspended",
    });
    assertAuthorizedOverride(executionId, resumeEvent, approval);

    // #304 — the kernel namespace is closed here too: a migration is still a caller-supplied
    // event landing in the log, and `EXECUTION_MIGRATED` is precisely the type that rewrites
    // the K11 code pin. ADR 0104 — onto an execution PARKED at a gate, the resume is that
    // gate's answer, so it must name that gate (the recorded one, which the operator can
    // read) and pass its declared shape, exactly as `resume` requires; otherwise any event
    // name answered the gate with a payload no schema checked. Onto a crashed or terminal
    // execution nothing is parked and nothing is answered (see `answerEvents`), so the gate
    // checks cannot apply and the namespace check stands alone.
    this.assertResumable(
      executionId,
      state,
      resumeEvent,
      state.status === "suspended" ? "all" : "kernel-namespace-only",
      options.system
    );

    // TR (ADR 0077) — validate against the TARGET flow's gate contract: the execution is being
    // resumed onto that code, so that code's declared shape is the one that must hold. Refuses
    // before the EXECUTION_MIGRATED append, so a rejected payload leaves no migration behind.
    const resumePayload = this.recordedPayload(
      resumeEvent,
      state,
      this.parseResumePayload(executionId, target.definition, resumeEvent)
    );
    assertInDoubtVerdict(executionId, state, resumePayload);
    assertNullAnswerTakes(executionId, resumeEvent.eventType, state, resumePayload);
    const discardEvents = this.checkStrayPassthroughs(
      executionId,
      this.scanWholeLog(
        executionId,
        allEvents,
        state,
        target.definition,
        state.status !== "suspended" && state.status !== "running" && state.status !== "pending"
      ),
      state,
      resumeEvent.discardLegacyAnswers,
      approval
    );

    const recorded = state.variables._flowHash;
    // ADR 0118 D2 — last, after every refusal that appends nothing (see `resume`).
    const acting = await this.actingPrincipal(executionId, options.principal, {
      first: firstEvent,
    });
    let runVm = vm;
    let fence = options.fence;
    if (options.fenceIfParkedAt !== undefined) {
      const got = await this.acquireFenceIfParked(
        executionId,
        resumeEvent,
        options.fenceIfParkedAt,
        options.system,
        { vm, events: allEvents }
      );
      fence = got.fence;
      runVm = got.vm;
    }
    return this.execute(
      executionId,
      workflowId,
      runVm,
      target.runner as FlowRunner<unknown, unknown>,
      stateMigrated ? migratedInput : recordedInput,
      [
        ...(approval !== undefined ? [approval] : []),
        ...discardEvents,
        {
          eventType: "EXECUTION_MIGRATED",
          payload: {
            toFlowId: newFlowId,
            strategy: options.strategy,
            ...(toHash !== undefined && { toHash }),
            ...(typeof recorded === "string" && { fromHash: recorded }),
            ...(stateMigrated && { migratedInput }),
          },
        },
        { eventType: resumeEvent.eventType, payload: resumePayload },
        ...answerEvents(runVm.getState(), resumePayload),
      ],
      fence,
      options.deadlineMs ?? target.definition.deadlineMs,
      acting
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
  async loadState(
    executionId: string,
    options?: { principal?: PrincipalChain; system?: SystemGrant }
  ): Promise<ExecutionState | null> {
    const state = await this.foldState(executionId);
    if (state === null) {
      await this.denyMissing("query", executionId, options?.principal, options?.system);
      return null;
    }
    // C.1 — gate the query. Folding is pure (no side effects), so authorizing AFTER
    // is safe: on a denial we simply withhold the data (no durable record — a read
    // must never write). Kernel-internal callers use `foldState` and bypass this.
    const denial = this.authzDenial(
      "query",
      executionId,
      state.workflowId,
      options?.principal,
      options?.system,
      await this.ownerForAuthz(executionId, options?.principal, options?.system)
    );
    if (denial !== undefined) {
      throw new ExecutionDeniedError("query", executionId, denial.reason);
    }
    return state;
  }

  /**
   * L11 (ADR 0106) — the state a snapshot seeds a fold with, checked against the execution it
   * was loaded FOR. Compaction before ADR 0106 checkpointed `executionId`/`workflowId`/
   * `workflowVersion` as `""`, and those checkpoints are durable: a BLANK field is filled —
   * the id the caller read, the workflowId sequence 0 records, and the registered flow's
   * version (exactly what the un-snapshotted path seeds, so both paths fold to the same
   * state). A NON-blank field that disagrees is refused ({@link SnapshotIdentityMismatchError}):
   * only a store or tenant-scoping defect produces one, and papering over it would write this
   * execution's events under another's identity. `retarget` is fork's explicit exception: a
   * parent's snapshot seeds a CHILD, so its executionId is replaced, never compared.
   */
  private seedOf(
    snapshot: Snapshot,
    executionId: string,
    workflowId: string,
    retarget = false
  ): ExecutionState {
    const state = normalizeSnapshotState(snapshot.state);
    assertSnapshotIdentity(state, executionId, workflowId, { retarget });
    if (
      state.executionId === executionId &&
      state.workflowId === workflowId &&
      state.workflowVersion !== ""
    ) {
      return state;
    }
    return {
      ...state,
      executionId,
      workflowId,
      workflowVersion:
        state.workflowVersion || (this.flows.get(workflowId)?.definition.version ?? ""),
    };
  }

  /**
   * The un-authorized fold used by the kernel internally (cancel, timers, recovery).
   *
   * Snapshot FIRST, then a bounded tail — never the whole log. Reading the full log up
   * front (as this once did) meant snapshots bounded the fold's CPU but not its I/O, so
   * every `loadState` on a long execution paid O(log). That compounds badly: `liveQuery`
   * re-folds on every event, making a live subscriber O(N) rows per event and O(N²) over
   * an execution's lifetime.
   *
   * The full read was load-bearing for one thing, though — "no events ⇒ null". Dropping
   * it naively would resurrect swept executions: `LogLifecycle` deletes events and then
   * calls `snapshotStore.deleteExecution?.()`, which is OPTIONAL, so a retention sweep
   * against a snapshot store that does not implement it leaves an ORPHANED snapshot
   * behind. Folding that orphan would hand back state the sweep was supposed to erase.
   *
   * So existence is still checked — against sequence 0 rather than the whole log. That
   * is the `EXECUTION_STARTED` bootstrap, which `truncatePrefix` explicitly preserves as
   * the execution's metadata anchor and `deleteExecution` removes with everything else;
   * "does sequence 0 exist" is therefore exactly "does this execution exist", in one
   * indexed point-read. It doubles as the identity anchor the un-snapshotted path needs.
   */
  private async foldState(executionId: string): Promise<ExecutionState | null> {
    // ADR 0107 — `""` is no execution, whatever a pre-0106 bug left in its stream.
    if (executionId === "") return null;
    const snapshot = await this.snapshotStore.loadLatest(executionId);
    if (snapshot !== null) {
      // Confirm the execution still exists before trusting the snapshot (orphan case
      // above). One row, not the log.
      const anchor = await readRangeOf(this.eventStore, executionId, 0, 0);
      if (anchor.length === 0) return null;
      const tail = await this.eventStore.readFrom(executionId, snapshot.sequence + 1);
      return new ReplayVM(
        tail,
        this.seedOf(snapshot, executionId, anchor[0]!.workflowId)
      ).getState();
    }
    // No snapshot: the log IS the bounded read (it is shorter than `snapshotEvery`, or
    // snapshots are off), and it answers existence itself — no extra round-trip. Same
    // query count as before on this path.
    const allEvents = await this.eventStore.read(executionId);
    if (allEvents.length === 0) {
      return null;
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
   *
   * A compacted parent (ADR 0107): a fork point is served exactly or refused, never folded
   * across compacted history. It is exact when every event between the nearest snapshot and
   * the fork point survives, or when a snapshot sits exactly at it (the checkpoint of a `[0]`
   * log, so the range is the FOLDED tip, not the log's). Anything else throws
   * {@link CompactedForkPointError} with nothing written.
   */
  async fork(
    parentExecutionId: string,
    atSequence: number,
    opts?: ForkOptions
  ): Promise<ForkResult> {
    // The tip, without materializing the log to find it. `fork()` used to `read()` the whole
    // parent just to learn how long it was — on a long-lived parent that is the dominant cost
    // of a fork, and it was paid even when the store could copy the prefix natively.
    assertNotReserved(parentExecutionId);
    if (opts?.executionId !== undefined) assertNotReserved(opts.executionId);
    const childId = opts?.executionId ?? ulid();
    // R3 — a fork READS the parent (its whole prefix, input included) and CREATES an execution,
    // so it is gated as `query` on the parent and `start` on the child, before anything is read
    // beyond sequence 0 or written. Both used to be skipped.
    if (this.authzApplies(opts?.principal, opts?.system)) {
      const parentWorkflowId = await this.workflowIdOf(parentExecutionId);
      if (parentWorkflowId === undefined) {
        await this.denyMissing("query", parentExecutionId, opts?.principal, opts?.system);
      } else {
        const parentOwner = await this.ownerForAuthz(
          parentExecutionId,
          opts?.principal,
          opts?.system
        );
        const queryDenial = this.authzDenial(
          "query",
          parentExecutionId,
          parentWorkflowId,
          opts?.principal,
          opts?.system,
          parentOwner
        );
        if (queryDenial !== undefined) {
          await this.denyOp(
            "query",
            parentExecutionId,
            parentWorkflowId,
            opts?.principal,
            queryDenial.reason,
            undefined
          );
        }
        const startDenial = this.authzDenial(
          "start",
          childId,
          parentWorkflowId,
          opts?.principal,
          opts?.system
        );
        if (startDenial !== undefined) {
          await this.denyOp(
            "start",
            childId,
            parentWorkflowId,
            opts?.principal,
            startDenial.reason,
            undefined
          );
        }
        // R3k (ADR 0111 D7) — acting as the parent's OWNER is an escalation over the default
        // (a fork acts as the forker), so it is a separate, default-deny op on the parent.
        if (opts?.actAs === "owner") {
          const ownerDenial = this.authzDenial(
            "actAsOwner",
            parentExecutionId,
            parentWorkflowId,
            opts?.principal,
            opts?.system,
            parentOwner
          );
          if (ownerDenial !== undefined) {
            await this.denyOp(
              "actAsOwner",
              parentExecutionId,
              parentWorkflowId,
              opts?.principal,
              ownerDenial.reason,
              undefined
            );
          }
        }
      }
    }
    if (opts?.actAs !== undefined && opts.actAs !== "owner") {
      throw new Error(`fork: unknown actAs "${String(opts.actAs)}" (only "owner" is defined)`);
    }
    // R3k (D7) — the fork acts as the FORKER: its record (built exactly as a start's) rides in the
    // metadata of every copied envelope, sequence 0 included, and the resolver prefers it over the
    // copied `principal`. Built before anything is read or written, so a record the configuration
    // forbids refuses the fork with nothing written. `actAs: "owner"` omits it and says so in the
    // log (`forkActAs`, descriptive; nothing reads it).
    const forkedBy =
      opts?.actAs === "owner" ? undefined : this.principalRecordFor(opts?.principal, "metadata");
    const tip = await headOf(this.eventStore, parentExecutionId);
    if (tip === null) {
      throw new Error(`No execution found for id: ${parentExecutionId}`);
    }
    // ADR 0107 — the range is the FOLDED tip: a log compacted through its tip is `[0]` with
    // its checkpoint above it, and that checkpoint is a fork point like any other. Only a point
    // past every event AND every snapshot is out of range; anything else above the log's tip
    // is compacted history, refused below. The latest snapshot is read only on these paths.
    const outOfRange = async (): Promise<Error> => {
      const latest = await this.snapshotStore.loadLatest(parentExecutionId);
      return new Error(
        `Invalid fork point ${atSequence} for execution ${parentExecutionId} (valid range 0..${Math.max(tip, latest?.sequence ?? tip)})`
      );
    };
    if (!Number.isSafeInteger(atSequence) || atSequence < 0) throw await outOfRange();
    const base = await this.snapshotStore.loadLatestBefore(parentExecutionId, atSequence);
    if (atSequence > tip && base?.sequence !== atSequence) {
      const latest = await this.snapshotStore.loadLatest(parentExecutionId);
      if (atSequence > Math.max(tip, latest?.sequence ?? tip)) throw await outOfRange();
    }

    // Only two things need the parent's events: folding the state at the fork point (which
    // starts from the nearest snapshot at/below it, so usually a short tail), and the copy
    // itself when the store cannot do it natively — or when live projections have to see the
    // copied prefix. Read the WIDER of those windows once, never the whole log, and never
    // anything above the fork point.
    const needsPrefix = this.eventStore.copyPrefix === undefined || this.onEvent !== undefined;
    const from = needsPrefix || base === null ? 0 : base.sequence + 1;
    const window = await readRangeOf(this.eventStore, parentExecutionId, from, atSequence);
    const parentEvents = window;
    // ADR 0107 — before anything is written: is the state at the fork point exactly
    // recoverable, and does the child's copied prefix have a shape every log reader accepts?
    await this.assertForkable(parentExecutionId, atSequence, tip, base, window, from);

    // `||`, not `??`: a checkpoint written before ADR 0106 carries a BLANK workflowId.
    const workflowId =
      base?.state.workflowId ||
      window[0]?.workflowId ||
      (await readRangeOf(this.eventStore, parentExecutionId, 0, 0))[0]?.workflowId ||
      "";
    const workflowVersion = this.flows.get(workflowId)?.definition.version ?? "";

    // 1. Materialize state at the fork point (reusing the nearest prior snapshot).
    const materialized = this.materializeStateAt(
      base,
      atSequence,
      window,
      childId,
      workflowId,
      workflowVersion
    );
    // The child's fold reads `forkedBy` from sequence 0's envelope in preference to the payload,
    // so the seed snapshot must carry the same `_principal` or snapshot-then-suffix would differ
    // from the full fold (ADR 0111 D7).
    const forkState: ExecutionState =
      forkedBy === undefined
        ? materialized
        : { ...materialized, variables: { ...materialized.variables, _principal: forkedBy } };

    // 2. Copy the prefix [0..atSequence] into the child log. Re-stamp id +
    //    executionId, record provenance in metadata. This BYPASSES the journal —
    //    the envelopes are verbatim, pre-sequenced copies, so they must not be
    //    re-sequenced. No synthetic EXECUTION_FORKED event either — inserting one
    //    would perturb sequence numbering and break the prefix-identity guarantee.
    // The copy merges this into every copied envelope's metadata. An override therefore
    // lands on sequence 0 — the anchor `placementOf` reads — as well as on the rest of the
    // prefix, which is harmless: metadata is operational, and the one key the fold reads
    // (`flowEmit`, ADR 0102) is preserved by the merge — which is what lets a forked child
    // serve its inherited emits instead of re-appending them.
    const forkMeta = {
      forkedFrom: parentExecutionId,
      forkSequence: atSequence,
      ...(opts?.computeTarget !== undefined && { [COMPUTE_TARGET_KEY]: opts.computeTarget }),
      ...(forkedBy !== undefined ? { forkedBy } : { forkActAs: "owner" }),
    };
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

    // 3b. Re-register the forked gate's durable wake.
    //
    //     The prefix copy carries the parent's EXECUTION_SUSPENDED verbatim, so the child
    //     IS parked on the same condition — but a timer row is keyed by executionId, and
    //     the parent's row wakes only the parent. Without this the child inherits a
    //     deadline recorded in its own log that can never fire, and nothing else sweeps it:
    //     `recoverAbandoned` (correctly) ignores suspended executions, since suspension is
    //     a normal outcome rather than an abandonment.
    //
    //     The child's wake MUST be the RECORDED `wakeAt`, never a fresh one. `TimerService`
    //     fires only when `state.suspendedOn.wakeAt === timer.wakeAt`, and the copied prefix
    //     is byte-identical by design — so a re-based deadline would be a timer that can
    //     never match its own log. A branch that wants its own deadline resumes the gate and
    //     suspends again with a new `timeout`; that is a fact it appends, not one it inherits.
    //
    //     Scheduled only after the prefix and the seed snapshot are durable — the same
    //     invariant the suspend path holds, that a timer must never fire into a log which
    //     does not yet record the suspend. A failure here is reported rather than thrown:
    //     the fork is already complete and durable, and this matches the suspend path's
    //     policy for the identical write.
    const forkWakeAt = forkState.status === "suspended" ? forkState.suspendedOn?.wakeAt : undefined;
    if (this.timerStore !== undefined && forkWakeAt !== undefined) {
      try {
        await this.timerStore.schedule({ executionId: childId, wakeAt: forkWakeAt });
      } catch (timerErr) {
        this.onStorageError?.(childId, timerErr);
      }
    }

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

    // R3 — the child exists now: its owner is whoever forked it (or, for a kernel-internal
    // fork, inherited from the parent by the policy).
    this.notifyStarted(childId, workflowId, opts?.principal, opts?.system, parentExecutionId, true);

    return {
      executionId: childId,
      parentExecutionId,
      forkSequence: atSequence,
      branchName,
      state: forkState,
    };
  }

  /**
   * ADR 0107 — refuse a fork point compaction made unservable, before anything is written.
   *
   * The state at `atSequence` is exact iff every event in `(base, atSequence]` survives, where
   * `base` is the nearest snapshot at or below it (or `-1` with none: the whole prefix must
   * survive). That is the replay inspector's rule for a compacted position (ADR 0106 D4), and
   * it is what `fork()` never checked: it folded the survivors across the hole and copied a
   * prefix missing the history the state claims. `window` holds every event in
   * `[from, atSequence]`, and `from ≤ base + 1`, so the count needs no further read.
   *
   * A fork point AT a snapshot whose own event was compacted away (the checkpoint of a log
   * compacted through its tip, or an older suspend snapshot below a later checkpoint) is
   * exact too, and the child is seeded from that snapshot. Its copied prefix is then the
   * parent's survivors at or below the fork point, with the seed above them. That is the
   * `[0]`-plus-checkpoint shape when only the bootstrap survives, and it is refused when
   * pinned events survive below the fork point: the child would carry its checkpoint above a
   * non-bootstrap tip, which ADR 0106's tip rule forbids and no reader handles.
   */
  private async assertForkable(
    parentExecutionId: string,
    atSequence: number,
    tip: number,
    base: Snapshot | null,
    window: readonly EventEnvelope[],
    from: number
  ): Promise<void> {
    const floor = base?.sequence ?? -1;
    let present = 0;
    for (let i = window.length - 1; i >= 0 && window[i]!.sequence > floor; i--) present++;
    if (present !== atSequence - floor) {
      throw await this.compactedForkPoint(parentExecutionId, atSequence, "compacted");
    }
    // The log's tip is an event that survives by definition (the common fork: a durable gate
    // at the tip of a long-lived parent), so only a fork point below it pays a read here.
    if (floor !== atSequence || atSequence === 0 || atSequence === tip) return;
    // The state is the snapshot's. Does the fork point's own event survive, and if not, does
    // anything but the bootstrap survive below it?
    let survivors: readonly EventEnvelope[];
    if (from === 0) {
      survivors = window;
    } else {
      const own = await readRangeOf(this.eventStore, parentExecutionId, atSequence, atSequence);
      if (own.length > 0) return;
      // Below a compacted fork point only kept (pinned-kind) events survive: a short read.
      survivors = await readRangeOf(this.eventStore, parentExecutionId, 0, atSequence - 1);
    }
    const top = survivors[survivors.length - 1]?.sequence ?? 0;
    if (top !== atSequence && top !== 0) {
      throw await this.compactedForkPoint(parentExecutionId, atSequence, "checkpoint-above-prefix");
    }
  }

  /**
   * The refusal, naming the lowest sequence from which the parent is forkable through its tip.
   * Only reached for a compacted parent (or one whose checkpoint is gone), whose log is its
   * kept events plus the tail above its latest checkpoint, so reading it whole is cheap here.
   */
  private async compactedForkPoint(
    parentExecutionId: string,
    atSequence: number,
    reason: "compacted" | "checkpoint-above-prefix"
  ): Promise<CompactedForkPointError> {
    const events = await this.eventStore.read(parentExecutionId);
    const latest = await this.snapshotStore.loadLatest(parentExecutionId);
    const foldedTip = Math.max(events[events.length - 1]?.sequence ?? 0, latest?.sequence ?? 0);
    let forkableFrom: number | null = null;
    if (events.length <= 1) {
      // `[0]`: compacted through its tip; its latest snapshot is its checkpoint.
      forkableFrom = latest !== null && latest.sequence > 0 ? latest.sequence : null;
    } else {
      const gap = highestMissing(events);
      if (gap < 0) {
        forkableFrom = 0; // gap-free: every position through the tip survives
      } else {
        // Under the tip rule `gap + 1 ≤ tip` survives, so the snapshot at or below it that
        // anchors the tail is at `gap` (the checkpoint) or `gap + 1`.
        const anchor = await this.snapshotStore.loadLatestBefore(parentExecutionId, gap + 1);
        if (anchor !== null && anchor.sequence >= gap) {
          const keptBelow = events.some((e) => e.sequence > 0 && e.sequence < gap);
          forkableFrom = anchor.sequence === gap && !keptBelow ? gap : gap + 1;
        } else {
          // A branch of a compacted parent copies the gap but not the parent's checkpoint: its
          // lowest snapshot above the gap (its fork seed) anchors everything from there up.
          forkableFrom = await this.lowestSnapshotFrom(parentExecutionId, gap, events[0]!);
        }
      }
    }
    return new CompactedForkPointError(
      parentExecutionId,
      atSequence,
      reason,
      forkableFrom,
      forkableFrom === null ? null : foldedTip
    );
  }

  /**
   * The lowest snapshot sequence at or above `floor`, or null. A forked child's sequence 0
   * names its fork seed (`metadata.forkSequence`), which is its first snapshot: one point read.
   * Otherwise the snapshots are walked down from the top — only on a refusal, over a
   * compacted log's tail.
   */
  private async lowestSnapshotFrom(
    executionId: string,
    floor: number,
    anchor: EventEnvelope
  ): Promise<number | null> {
    const seed = anchor.metadata?.forkSequence;
    if (typeof seed === "number" && seed >= floor) {
      if ((await this.snapshotStore.loadAt(executionId, seed)) !== null) return seed;
    }
    let lowest: number | null = null;
    for (
      let s = await this.snapshotStore.loadLatest(executionId);
      s !== null && s.sequence >= floor;
      s =
        s.sequence > 0
          ? await this.snapshotStore.loadLatestBefore(executionId, s.sequence - 1)
          : null
    ) {
      lowest = s.sequence;
    }
    return lowest;
  }

  /**
   * Fold ExecutionState at `atSequence` for a fork, stamped with the child executionId.
   * Pure: the caller has already read the snapshot and exactly the window of events this
   * needs, so long histories neither replay from zero nor load anything above the fork point.
   */
  private materializeStateAt(
    base: Snapshot | null,
    atSequence: number,
    window: EventEnvelope[],
    childId: string,
    workflowId: string,
    workflowVersion: string
  ): ExecutionState {
    let vm: ReplayVM;
    if (base) {
      // `window` may start at 0 (when the copy path needed the whole prefix), so slice the
      // [base+1..at] tail out of it rather than replaying events the snapshot already folded.
      const tail = sliceBySequence(window, base.sequence + 1, atSequence);
      vm = new ReplayVM(tail, this.seedOf(base, childId, workflowId, true));
    } else {
      vm = new ReplayVM(window, { executionId: childId, workflowId, workflowVersion });
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
    deadlineMs?: number,
    principal?: PrincipalChain
  ): ExecutionHandle {
    // Backstop: `start`/`resume`/`resumeAs`/`restoreFromState` already validated the per-call
    // `options.deadlineMs` before appending anything; this covers the flow definition's own budget.
    assertValidBudget("deadlineMs", deadlineMs, `execution "${executionId}"`);
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
    // Sequence of the most recent checkpoint this run has issued, used ONLY to decide
    // whether the settle checkpoint below is worth taking. On resume it starts at the
    // restored tip (a resumed execution has just loaded that state), and -1 clamps to 0
    // on a fresh start.
    let lastSnapshotSequence = Math.max(0, vm.getState().sequence);
    const maybeSnapshot = (sequence: number): void => {
      const every = this.snapshotEvery;
      if (!every || sequence <= 0 || sequence % every !== 0 || snapshotInFlight) return;
      // Never checkpoint state whose events failed to persist (e.g. a fenced
      // zombie, K9.4): a snapshot must only ever reference durable events.
      if (journal.failed) return;
      snapshotInFlight = true;
      lastSnapshotSequence = sequence;
      const state = vm.getState(); // stable: copy-on-write folds never mutate a prior state
      void this.snapshotStore
        .save({ id: ulid(), executionId, workflowId, sequence, state, createdAt: Date.now() })
        .catch((err: unknown) => this.onStorageError?.(executionId, err))
        .finally(() => {
          snapshotInFlight = false;
        });
    };

    /**
     * Settle-time checkpoint, the completion counterpart to the one `suspend` already
     * takes at its tip.
     *
     * The cadence trigger above can only fire while the execution is still committing.
     * An execution that races to completion inside the window of a single in-flight save
     * therefore keeps whatever early checkpoint it managed — measurably, a 102-event run
     * with `snapshotEvery: 2` ends up with ONE snapshot, at sequence 2 — and every later
     * read folds the whole tail behind it, forever.
     *
     * Note what does NOT fix this: changing the trigger from an exact multiple to an
     * interval since the last checkpoint. That was tried and measured inert in both
     * regimes — a fast execution has no commits left by the time the save resolves, and
     * a slow one lets the exact-multiple trigger keep up anyway (299 vs 300 checkpoints
     * over the same workload). The settle checkpoint is what actually bounds the read.
     *
     * Gated so it costs nothing where it would not pay: only when snapshots are opted
     * into at all, and only when the tail since the last checkpoint has actually reached
     * the configured cadence. Short executions skip it; with `snapshotEvery` unset
     * (the default) this is inert.
     *
     * Deliberately NOT gated on `snapshotInFlight`: this is the checkpoint that matters
     * most, and two concurrent saves are safe — ids are distinct and `loadLatest` takes
     * the greatest sequence.
     */
    const checkpointOnSettle = async (): Promise<void> => {
      const every = this.snapshotEvery;
      if (!every) return;
      // Same invariant as the cadence path: never checkpoint state whose events are not
      // durable. Callers invoke this only after a drain barrier.
      if (journal.failed) return;
      const state = vm.getState();
      if (state.sequence - lastSnapshotSequence < every) return;
      lastSnapshotSequence = state.sequence;
      try {
        await this.snapshotStore.save({
          id: ulid(),
          executionId,
          workflowId,
          sequence: state.sequence,
          state,
          createdAt: Date.now(),
        });
      } catch (err: unknown) {
        // A lost checkpoint only costs a longer replay — never fail the execution for it.
        this.onStorageError?.(executionId, err);
      }
    };

    const journal = new ExecutionJournal(
      this.eventStore,
      { executionId, workflowId },
      vm,
      this.onEvent,
      (err) => {
        this.onStorageError?.(executionId, err);
        if (!cancelled) controller.abort(err);
      },
      maybeSnapshot,
      fence,
      this.now
    );

    // Commit bootstrap events (EXECUTION_STARTED / resume+RESUMED / restore) so
    // they flow through the same sequencer + writer as everything else.
    for (const b of bootstrapEvents) {
      if (b.durable !== undefined) {
        journal.adopt(b.durable); // ADR 0103 — already stored by start()'s barrier
        continue;
      }
      journal.commit(
        b.eventType,
        b.payload,
        b.metadata !== undefined ? { metadata: b.metadata } : undefined
      );
    }

    const ctx = new WorkflowContextImpl(
      executionId,
      workflowId,
      vm,
      journal,
      this.effectRuntime,
      controller.signal,
      principal,
      this.now,
      {
        ...(this.parkDrainMs !== undefined && { parkDrainMs: this.parkDrainMs }),
        onWarn: this.onWarn,
        scopes: this.scopes,
        ...(this.errorClasses !== undefined && { errorClasses: this.errorClasses }),
      }
    );

    const cancel = (reason?: unknown): void => {
      if (cancelled) return;
      cancelled = true;
      // A caller-supplied Error is the abort reason as-is; otherwise a named
      // ExecutionCancelledError, so every consumer of the signal can classify it. ONE
      // object: the signal's reason and the completion rejection are the same error.
      const err =
        reason instanceof Error
          ? reason
          : new ExecutionCancelledError("Execution cancelled", reason);
      controller.abort(err);
      // Synchronous: enqueue the durable CANCELLED write (drained by run()'s
      // cancelled branch) and reject the caller immediately.
      journal.commit("EXECUTION_CANCELLED", {
        ...(reason !== undefined && { reason: String(reason) }),
      });
      rejectCompletion(err);
    };

    // K8.3 — execution deadline, anchored to the LOGGED EXECUTION_STARTED
    // timestamp (already folded from the bootstrap above on a fresh start, or
    // from the original log on resume) — a crash/resume never resets the clock,
    // and resuming past the deadline cancels immediately. Breach is a
    // kernel-driven cancel: durable EXECUTION_CANCELLED, in-flight effect aborted.
    let clearDeadline: (() => void) | undefined;
    if (deadlineMs !== undefined) {
      const startedAt = vm.getState().startedAt || this.now();
      // `startedAt` is a journal timestamp (`this.now`), so measure against the same clock.
      clearDeadline = armDeadline(
        () => remainingBudget(deadlineMs, startedAt, this.now),
        () =>
          cancel(
            new ExecutionCancelledError(
              `execution deadline exceeded (deadlineMs=${deadlineMs})`,
              undefined,
              "deadline"
            )
          )
      );
    }

    const run = async () => {
      try {
        const output = await runner(ctx, input);

        journal.commit("EXECUTION_COMPLETED", { output });
        // ADR 0112 D3 — nothing from this execution's own (abandoned) work follows its terminal.
        ctx.seal();
        await journal.drain(); // durability barrier
        await checkpointOnSettle(); // bound reads of the settled execution
        resolveCompletion(vm.getState());
      } catch (err) {
        if (err instanceof SuspendError) {
          // T1 — when a timer store is wired, a wake time becomes part of the
          // durable condition: explicit (`ctx.sleep`'s wakeAt) or derived ONCE
          // from `suspend({ timeout })` (this is the only place wall clock
          // enters the log — replay serves the recorded value, P9). Unwired,
          // the condition is committed byte-identically to before (G2).
          // EVENT_SCHEMA 1.23.0 — the park is committed from what the KERNEL decided, never from
          // what userspace put in the error. `waits` (ADR 0110 D4) is written only by the
          // kernel's own multi-wait writer, which adds it AFTER this strip and stamps the event;
          // `stepId` (ADR 0104) is kept only on a park the kernel built for a human step. Every
          // path funnels here — `ctx.suspend`, a raw `throw new SuspendError`, a human step.
          const {
            waits: _waits,
            stepId: claimedStep,
            ...stripped
          } = err.condition as {
            on: string;
            timeout?: number;
            correlationKey?: string;
            wakeAt?: number;
            waits?: unknown;
            stepId?: unknown;
          };
          const condition: typeof stripped & { stepId?: unknown } =
            isKernelHumanPark(err) && claimedStep !== undefined
              ? { ...stripped, stepId: claimedStep }
              : stripped;
          const wakeAt =
            this.timerStore !== undefined
              ? (condition.wakeAt ??
                (condition.timeout !== undefined ? this.now() + condition.timeout : undefined))
              : condition.wakeAt;
          // The flow declared a deadline this runtime cannot keep. Unwired, the condition is
          // committed WITHOUT a wakeAt — byte-identically, silently — so nothing downstream
          // can tell "no deadline" from "the deadline was dropped on the machine that
          // suspended". That gap is invisible while everything runs in one process and
          // becomes a lost gate the moment compute is split: a worker built as "a runtime
          // with the flows registered" discards every timeout of every execution it parks.
          if (
            this.timerStore === undefined &&
            condition.timeout !== undefined &&
            condition.wakeAt === undefined
          ) {
            const key = `${workflowId}:${condition.on}`;
            if (!this.warnedDroppedDeadlines.has(key)) {
              this.warnedDroppedDeadlines.add(key);
              this.onWarn(
                `flow "${workflowId}" suspended on "${condition.on}" with a timeout, but no TimerStore is wired — the deadline is NOT recorded and nothing will fire it. Wire \`timers: { store }\` on every runtime that can suspend (only one needs the TimerService). \`loom verify\`'s suspension-safety rule checks this statically.`
              );
            }
          }
          const committedCondition =
            wakeAt !== undefined && condition.wakeAt === undefined
              ? { ...condition, wakeAt }
              : condition;
          // ADR 0112 D3 — the PARK BARRIER. The park is decided: freeze new step starts and let
          // the steps already in flight settle, so their events land BEFORE the park (nothing from
          // this execution's own siblings follows EXECUTION_SUSPENDED). Bounded by `parkDrainMs`.
          const drained = ctx.parkBarrier();
          if (drained !== undefined) await drained;
          // Cancelled while draining: EXECUTION_CANCELLED owns the outcome, never a park after it.
          if (cancelled) {
            await journal.drain().catch(() => {});
            return;
          }
          journal.commit("EXECUTION_SUSPENDED", { condition: committedCondition });
          // Sealed the instant the park is enqueued — not only when the drain gave up: a branch
          // that settled cleanly may still run user code, and none of it may append after the park.
          ctx.seal();
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
          try {
            await this.snapshotStore.save(snap);
          } catch (err: unknown) {
            // Same policy as the cadence and settle checkpoints: a lost snapshot costs a
            // longer replay, never correctness — EXECUTION_SUSPENDED is already durable
            // (drained above), so this execution IS suspended whether or not the
            // checkpoint landed, and a resume folds from the log instead.
            //
            // This is the one save on the run loop nobody awaits, which is what made it
            // different in kind: an escaping rejection skipped `resolveSuspend` below, so
            // a snapshot store that rejected here left `waitForSuspend`/`waitForCompletion`
            // pending FOREVER and surfaced only as an unhandled rejection. A transient
            // blip in a network-backed SnapshotStore wedged the execution.
            this.onStorageError?.(executionId, err);
          }
          // T1 — schedule the durable wake ONLY after the suspension is durable, so a
          // timer can never fire into a log that doesn't yet record the suspend. The
          // snapshot is a replay optimization and is deliberately NOT part of that
          // invariant — the log is what a woken execution reads.
          if (this.timerStore !== undefined && wakeAt !== undefined) {
            try {
              await this.timerStore.schedule({ executionId, wakeAt });
            } catch (timerErr) {
              this.onStorageError?.(executionId, timerErr);
            }
          }
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
        ctx.seal();
        try {
          await journal.drain();
        } catch (drainErr) {
          // ADR 0105 — the terminal failure is NOT durable. The log ends at the step failure,
          // which folds `running` (only EXECUTION_FAILED fails an execution), so a later
          // recovery pass re-drives it. Telling the caller "failed" would be a lie it cannot
          // detect; report the write failure (StorageWriteError, `cause` = the store's error),
          // as the storage-died branch above does.
          rejectCompletion(drainErr);
          return;
        }
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
      clearDeadline?.();
      this.liveHandles.delete(executionId);
      this.startRecords.delete(executionId);
    });

    return handle;
  }
}
