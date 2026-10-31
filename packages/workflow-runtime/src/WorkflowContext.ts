import { tainted } from "@loom/classify";
import { BUILTIN_METER_DIMENSIONS, SuspendError, TypedFailure, fnv1a64 } from "@loom/core";
import type { ExecutableTask, StepDefinition, SuspendWait } from "@loom/core";
import type { EffectRuntime, PrincipalChain, ResourceSnapshot } from "@loom/effect-runtime";
import { FLOW_DIVERGED_GATE } from "@loom/replay-vm";
import type { ReplayVM } from "@loom/replay-vm";
import { linkSignals, parallelLimit } from "@loom/scheduler";
import type { DecisionInner } from "./DivergenceGuard";
import type { ExecutionJournal } from "./ExecutionJournal";
import { createContextStore } from "./contextStore";
import {
  CarryTooLargeError,
  ContinueAsNewRefusedError,
  ContinueAsNewSignal,
  ContinueAsNewUnavailableError,
} from "./continuation";
import { armDeadline, assertValidBudget, remainingBudget } from "./deadlineTimer";
import { asInDoubtVerdict, inDoubtDecisionId } from "./inDoubt";
import {
  type QuarantineEntry,
  assertDeliverable,
  cursorFor,
  cursorsOf,
  dedupeKeyOf,
  quarantineQueue,
  sealedEnvelopeIn,
  topicProblem,
} from "./inbox";
import { WaitsPark, markKernelHumanPark } from "./kernelPark";
import type { CopyRead } from "./quarantine";
import { discardDecisionId } from "./strayPassthroughs";
import { SealedPayloadUnreadableError } from "./types";
import {
  DecideScopeClosedError,
  EFFECT_INDOUBT_RESOLVED,
  ExecutionCancelledError,
  FlowDivergenceError,
  ParallelScopeFailedError,
  StepTimeoutError,
  TIMER_FIRED,
} from "./types";
import type {
  BranchContext,
  CheckedBranch,
  DecideOptions,
  DecideScope,
  EffectInDoubtResolution,
  ErrorClassCtor,
  ExplicitParallelBranches,
  InboxSource,
  ParallelBranch,
  ParallelOptions,
  ParallelResults,
  ResourceDimension,
  SelectArm,
  SelectResult,
  SuspendConfig,
  WorkflowContext,
} from "./types";
import { assertEstimatedCost, assertFlowDecisionId, guardUserspaceEmit } from "./userspaceEmit";

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

/**
 * Byte budget of a scope record's serialized `consumed` (runs `[branchScopePath, startIdx, count]`);
 * past it the record omits the list and a re-run falls back to taking answers by position.
 */
const SCOPE_CONSUMED_BYTES = 16 * 1024;
/** A typed failure's payload rides the scope record only while its JSON stays this small. */
const SCOPE_PAYLOAD_CAP = 1024;

/** One `parallel` call: its controller, and what the call has learned about its branches. */
interface ScopeGroup {
  readonly controller: AbortController;
  parked: boolean;
  /** Step ids that recorded `STEP_CANCELLED` under this scope (descendants included). */
  readonly cancelled: string[];
  /**
   * Gate answers consumed under this scope (descendants included), per branch path, as runs of
   * contiguous answer indices `[startIdx, count]`.
   */
  readonly consumed: Map<string, Array<[number, number]>>;
  /** Approximate serialized size of `consumed`, against {@link SCOPE_CONSUMED_BYTES}. */
  consumedBytes: number;
  consumedOverflow: boolean;
}

/** The runs a served branch takes, with a read position. */
interface ServedRuns {
  readonly runs: Array<[number, number]>;
  run: number;
  offset: number;
}

/** A scope replaying its journaled outcome: which answer each branch consumed on the first run. */
interface ServedScope {
  /** `undefined` for a record that predates the consumption field: answers are taken positionally. */
  readonly consumed: Map<string, ServedRuns> | undefined;
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
  /** Set when this scope replays a journaled outcome: it serves frames and never starts work. */
  readonly served: ServedScope | undefined;
}

function scopeIsParked(scope: Scope | undefined): boolean {
  for (let s = scope; s !== undefined; s = s.parent) if (s.group?.parked === true) return true;
  return false;
}

/**
 * The scope the CURRENT async context runs in. A branch that closes over the root `ctx` (instead of
 * using the `BranchContext` it was handed) still belongs to its scope: abort cancels it, and the
 * `parallel` calls it makes are numbered in its own scope, not in whichever order timing delivers.
 * Work detached through a callback that does not propagate async context (an event emitter bound
 * outside the branch, a thread pool) falls back to the ROOT scope.
 */
const scopeStore = createContextStore<{ owner: object; scope: Scope }>();

function flattenRuns(m: Map<string, Array<[number, number]>>): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  for (const [path, runs] of m) for (const [start, count] of runs) out.push([path, start, count]);
  return out;
}

/** The journaled outcome of a fail-fast scope, as the fold holds it (`_scopes[scopePath]`). */
interface RecordedScope {
  failedBranch: number | undefined;
  error: string;
  errorName: string | undefined;
  errorChannel: string | undefined;
  errorPayload: unknown;
  launched: number | undefined;
  consumed: Array<[string, number, number]> | undefined;
  cursor: number | undefined;
}

const BUILTIN_ERROR_CLASSES: ReadonlyArray<readonly [string, ErrorClassCtor]> = [
  ["Error", Error],
  ["TypeError", TypeError],
  ["RangeError", RangeError],
  ["ReferenceError", ReferenceError],
  ["SyntaxError", SyntaxError],
  ["EvalError", EvalError],
  ["URIError", URIError],
];

/** `JSON` round trip, or `undefined` when the value cannot (or should not) ride a scope record. */
function jsonBounded(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    if (text === undefined || text.length > SCOPE_PAYLOAD_CAP) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Strip every leading `${name}: ` — `String(error)` of an error whose message repeats its name. */
function stripNamePrefix(text: string, name: string): string {
  const prefix = `${name}: `;
  let out = text;
  while (out.startsWith(prefix)) out = out.slice(prefix.length);
  return out;
}

/** Builds the `ctx.ui` accessor from `ctx.emit` (ADR 0114); agent-surface's `createSurfaceEmitter`. */
export type SurfaceFactory = (emit: (eventType: string, payload: unknown) => void) => unknown;

// ── ADR 0110 — registered waits ──────────────────────────────────────────────────────────────────

/** One arm of a registered `select`: a wait with a deterministic identity. */
interface ArmReg {
  readonly waitId: string;
  readonly kind: "gate" | "inbox" | "timer";
  /** The gate name, the inbox topic, or `"timer"`: what a recorded answer is compared with. */
  readonly name: string;
  readonly index: number;
  readonly viewDigest?: string;
  readonly correlationKey?: string;
  readonly wakeAt?: number;
}

/** A `select` that has registered and not yet been answered. */
interface PendingSelect {
  readonly arms: readonly ArmReg[];
  /** The scope the select registered in (concurrent waits in one scope have no stable identity). */
  readonly scope: Scope;
  /** `workTicks` at registration: equal to the current value iff no ctx operation ran since. */
  readonly turn: number;
  settled: boolean;
  resolve(value: SelectResult): void;
  reject(err: unknown): void;
  /** Detaches the scope-abort listener. */
  detach?: () => void;
}

/** What the runtime hands the context to serve `receive` / `select` (ADR 0110). */
export interface InboxBinding {
  /** `kernel.features.inbox`. Off: `receive` / `select` reject with a message naming the flag. */
  readonly enabled: boolean;
  /** The chain whose stream this execution reads (the execution itself until R1b continues one). */
  readonly chainId: string;
  readonly read: InboxSource;
  /**
   * ADR 0130 residuals D9 - how the live run reads a topic's held copy and whether this node lifts a
   * hold by itself (`kernel.inbox.autoRelease`). Absent: the node predates quarantine and a held topic
   * is simply skipped (it never delivers past a hold).
   */
  readonly quarantine?: {
    readCopy(entry: QuarantineEntry): Promise<CopyRead>;
    readonly autoRelease: boolean;
  };
}

/** What the runtime hands the context to serve `continueAsNew` (ADR 0109). */
export interface ContinuationBinding {
  /** `kernel.features.continueAsNew`. Off: the call throws {@link ContinueAsNewUnavailableError}. */
  readonly enabled: boolean;
  /** The kernel cap on a carry, in bytes of its JSON text. */
  readonly maxCarryBytes: number;
  /**
   * Contract validation of the carry as the successor's `input` (`validateInput`, ADR 0051 D7):
   * returns the parsed value or throws, before anything is appended.
   */
  readonly validate?: (carry: unknown) => unknown;
}

/** How many messages one inbox read asks for beyond the waits it must satisfy (duplicates are skipped). */
const INBOX_READ_SLACK = 16;
/** Bound on one quiescence pass's reads (a stream of nothing but duplicates cannot spin it). */
const INBOX_READ_PASSES = 8;

/** What the context tells the replay-divergence detector (ADR 0113 D3). */
export interface DivergenceHooks {
  visit(id: string): void;
  scopeOpen(path: string, stepIds: readonly string[], allExplicit: boolean): void;
  scopeClose(): void;
  decisionServed(decisionId: string, inner: DecisionInner | undefined): void;
}

/** The steps a live decider has run so far (and its enclosing deciders'), per async context. */
interface InnerSteps {
  readonly ids: Set<string>;
  readonly parent: InnerSteps | undefined;
  /** Past {@link MAX_INNER_STEPS} ids or {@link MAX_INNER_BYTES} of them: the record lists the first ones and says so. */
  overflowed: boolean;
  /** Total length of the ids held (a byte cap beside the count cap). */
  bytes: number;
}
const deciderStore = createContextStore<{ owner: object; inner: InnerSteps }>();
/**
 * A decision record lists its inner steps only up to this many; past it the record carries
 * `innerStepsOverflow` and a served decision also exempts the frames first started during it.
 */
const MAX_INNER_STEPS = 4096;
/** ...and at most this many characters of ids in total (a record must stay small). */
const MAX_INNER_BYTES = 64 * 1024;

export class WorkflowContextImpl implements WorkflowContext {
  readonly executionId: string;
  readonly workflowId: string;
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
  private sealedReplayRefusalError: SealedPayloadUnreadableError | undefined;
  private sealedByCancel = false;
  private warnedSealed = false;
  private readonly parkDrainMs: number;
  private readonly onWarn: (message: string) => void;
  private readonly scopesEnabled: boolean;
  private readonly errorClasses: Map<string, ErrorClassCtor>;
  private readonly surfaceFactory: SurfaceFactory | undefined;
  private surfaceAccessor: unknown;
  // ADR 0110 — registered waits. `waitOrdinals` numbers waits per scope path (a pure function of the
  // flow's control flow, so a re-run mints the same ids); `pending` is the set of selects not yet
  // answered, in registration order; `epoch` moves on every change quiescence depends on.
  private readonly inboxBinding: InboxBinding | undefined;
  // ADR 0109 — continue-as-new. `openParallels` counts `parallel` calls in flight (a hand-rolled
  // `Promise.all([ctx.parallel(..), ctx.continueAsNew(..)])` is refused); `continuation` is the
  // accepted request, after which new step starts are frozen exactly like a park.
  private readonly continuationBinding: ContinuationBinding | undefined;
  private openParallels = 0;
  /** ADR 0113 D3 — true while a `parallel` call is in flight (the detector defers to its close). */
  get parallelOpen(): boolean {
    return this.openParallels > 0;
  }
  private readonly divergence: DivergenceHooks | undefined;
  private readonly dispatchGate: (() => void) | undefined;
  private continuation: ContinueAsNewSignal | undefined;
  private rejectContinue: ((err: unknown) => void) | undefined;
  /** Rejects with a {@link ContinueAsNewSignal} once a continuation was accepted (even if the flow swallowed the throw). */
  readonly continueSignal: Promise<never>;
  private readonly waitOrdinals = new Map<string, number>();
  private readonly pending = new Set<PendingSelect>();
  /** Moves on every start AND end of a ctx operation (see `registerSelect`'s concurrent-wait check). */
  private workTicks = 0;
  private epoch = 0;
  private quiescenceScheduled = false;
  private quiescenceChecking = false;
  private parkDecided = false;
  private rejectPark: ((err: unknown) => void) | undefined;
  /** Rejects with a {@link WaitsPark} once the flow is quiescent with waits registered. */
  readonly parkSignal: Promise<never>;

  /**
   * `ctx.ui` (ADR 0114). The kernel does not know what a surface is: the accessor comes from the
   * injected `WorkflowRuntimeDeps.surface` factory (`defineConfig`, `@loom/testing` and the scaffold
   * pass agent-surface's `createSurfaceEmitter`). Its patches are plain `emit`s, so they are durable and
   * replay deterministically alongside every other event. Built lazily, once; with no factory the
   * access throws a message naming the dep (a bare runtime, "break now").
   */
  get ui(): unknown {
    if (this.surfaceFactory === undefined) {
      throw new Error(
        "ctx.ui is not available: this WorkflowRuntime was built without the `surface` dep " +
          "(ADR 0114). Pass `surface: createSurfaceEmitter` from @loom/agent-surface in " +
          "WorkflowRuntimeDeps, build the runtime through defineConfig, or use `surface(ctx)` " +
          "from @loom/agent-surface."
      );
    }
    this.surfaceAccessor ??= this.surfaceFactory((eventType, payload) =>
      this.emit(eventType, payload)
    );
    return this.surfaceAccessor;
  }

  /** ADR 0115 — per-dimension overrides of the metering sanity ceilings (the guard reads them). */
  private readonly meterCeilings: Readonly<Record<string, number>> | undefined;

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
    opts: {
      parkDrainMs?: number;
      onWarn?: (message: string) => void;
      scopes?: boolean;
      errorClasses?: Record<string, ErrorClassCtor>;
      surface?: SurfaceFactory;
      inbox?: InboxBinding;
      continuation?: ContinuationBinding;
      meterCeilings?: Readonly<Record<string, number>>;
      /** ADR 0113 D3 — told which recorded steps the re-run asks for. */
      divergence?: DivergenceHooks;
      /** ADR 0130 D11 — throws (a lost lease) when no effect may be dispatched any more. */
      dispatchGate?: () => void;
    } = {}
  ) {
    this.divergence = opts.divergence;
    this.dispatchGate = opts.dispatchGate;
    this.inboxBinding = opts.inbox;
    this.continuationBinding = opts.continuation;
    this.continueSignal = new Promise<never>((_resolve, reject) => {
      this.rejectContinue = reject;
    });
    this.continueSignal.catch(() => {});
    this.meterCeilings = opts.meterCeilings;
    this.parkSignal = new Promise<never>((_resolve, reject) => {
      this.rejectPark = reject;
    });
    this.parkSignal.catch(() => {});
    this.surfaceFactory = opts.surface;
    this.parkDrainMs = opts.parkDrainMs ?? DEFAULT_PARK_DRAIN_MS;
    this.onWarn = opts.onWarn ?? (() => {});
    this.scopesEnabled = opts.scopes === true;
    this.errorClasses = new Map(BUILTIN_ERROR_CLASSES);
    for (const [name, ctor] of Object.entries(opts.errorClasses ?? {})) {
      if (typeof ctor === "function") this.errorClasses.set(name, ctor);
    }
    this.rootScope = {
      path: "",
      parent: undefined,
      group: undefined,
      // Scopes off (the pre-R6 semantics): the execution's own signal, no park-drain abort.
      signal: this.scopesEnabled
        ? linkSignals(this.signal, this.parkController.signal)
        : this.signal,
      parallelCount: 0,
      served: undefined,
    };
    this.executionId = executionId;
    this.workflowId = workflowId;
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
    const payload = guardUserspaceEmit(
      eventType,
      rawPayload,
      {
        kind: "flow",
        conflicts: this.decisionConflict,
      },
      this.meterCeilings
    ); // ADR 0104
    const digest = flowEmitDigest(eventType, payload, this.suspendPassthroughsConsumed);
    if (digest === undefined) {
      this.commit(eventType, payload, { unguarded: true }); // cannot be matched: always append (never stamped)
      return;
    }
    const seen = this.flowEmitsSeen.get(digest) ?? 0;
    this.flowEmitsSeen.set(digest, seen + 1);
    const logged = this.vm.flowEmitCount(digest);
    if (seen < logged && !this.segmentLive) return; // proven: a replay of a logged emit
    if (seen < logged || this.inFlight > 0 || this.unsettled) {
      this.commit(eventType, payload, { unguarded: true }); // appended, unstamped: serves nothing later
      return;
    }
    if (this.isSealed(eventType)) return;
    this.journal.commit(eventType, payload, {
      metadata: { flowEmit: digest },
      unguarded: true, // ADR 0113: a flow-level emit is not judged (an unprovable one re-appends on every re-run)
    });
  }

  // Synchronous: the journal allocates a sequence, folds the VM, fires onEvent,
  // and enqueues the durable write. The async persistence is drained at barriers.
  // The kernel's own facts (STEP_*, DECISION_RECORDED, EFFECT_INDOUBT) and
  // `EffectContext.emit` come through here, never through the flow-level `emit`:
  // their callers are already served from the fold on a re-run, and they must not
  // consume a flow-emit ordinal (ADR 0102).
  private commit(
    eventType: string,
    payload: unknown,
    opts?: { metadata?: Record<string, unknown>; unguarded?: boolean }
  ): void {
    if (this.isSealed(eventType)) return;
    this.journal.commit(eventType, payload, opts);
  }

  /**
   * ADR 0112 D3 — after the park is committed (or its drain gave up), nothing this context's
   * work appends reaches the log: a late sibling's effect ran, its result is dropped, and it
   * re-runs on resume under the same idempotency key. A typed, logged warning, never a write.
   */
  private isSealed(eventType: string): boolean {
    if (!this.sealed) return false;
    // A cancel seals everything EXCEPT the STEP_CANCELLED records of steps the abort interrupts.
    if (this.sealedByCancel && eventType === "STEP_CANCELLED") return false;
    if (!this.warnedSealed) {
      this.warnedSealed = true;
      this.onWarn(
        `execution "${this.executionId}": a ${eventType} from work still running after the execution's park or terminal event was committed was DROPPED (journal sealed, ADR 0112) — a parked execution re-runs it on resume under the same idempotency key`
      );
    }
    return true;
  }

  /**
   * The runtime calls this the instant it enqueues `EXECUTION_SUSPENDED` / `EXECUTION_COMPLETED` /
   * `EXECUTION_FAILED`: from then on nothing this context's (abandoned, or still-running) work
   * appends reaches the log. The barrier drains in-flight STEPS; user code between steps (an
   * `emit`, a `decide`) can still run after a branch settled, and must not follow the terminal.
   */
  /** ADR 0130 — set when a replayed inbox answer was still sealed on this node: the attempt is refused. */
  get sealedReplayRefusal(): SealedPayloadUnreadableError | undefined {
    return this.sealedReplayRefusalError;
  }

  seal(opts?: { cancel?: boolean }): void {
    this.sealedByCancel = opts?.cancel === true && !this.sealed;
    this.sealed = true;
    this.releasePending();
  }

  // ── ADR 0112 D3 — the park barrier (called by the runtime around the park commit) ─────────

  private beginWork(): void {
    this.activeWork++;
    this.workTicks++;
    this.epoch++;
  }

  private endWork(): void {
    this.workTicks++;
    this.epoch++;
    if (--this.activeWork > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
    this.scheduleQuiescence();
  }

  /** Resolves when the in-flight set is empty (no timeout: see `continueAsNew`). */
  private idle(): Promise<void> {
    if (this.activeWork === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
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
      // Scopes off: no abort (pre-R6 semantics) — whatever is still running is sealed out.
      if (this.scopesEnabled) {
        this.parkController.abort(new ScopeAbortedError("", "park drain exceeded parkDrainMs"));
      }
      if (
        !this.scopesEnabled ||
        !(await this.idleWithin(Math.min(this.parkDrainMs, ABORT_GRACE_CAP_MS)))
      ) {
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
    return this.executeIn(this.currentScope(), task, input);
  }

  /** `execute` as a step of `scope` (ADR 0112): the scope's signal governs it, its path names it. */
  private async executeIn<TIn, TOut>(
    scope: Scope,
    task: ExecutableTask<TIn, TOut>,
    input: TIn
  ): Promise<TOut> {
    const id = task.id;
    this.divergence?.visit(id); // ADR 0113 D3 — the re-run asked for this recorded step
    const deciding = deciderStore.getStore();
    if (deciding !== undefined && deciding.owner === this) {
      // Inside a live decider: the decision's record names this step (ADR 0113 D3, `innerSteps`).
      for (let d: InnerSteps | undefined = deciding.inner; d !== undefined; d = d.parent) {
        if (d.ids.has(id)) continue;
        if (d.ids.size < MAX_INNER_STEPS && d.bytes + id.length <= MAX_INNER_BYTES) {
          d.ids.add(id);
          d.bytes += id.length;
        } else d.overflowed = true;
      }
    }
    // ADR 0104 — a `kind: "human"` step (HumanEffect) is a SUSPEND POINT: its effect parks the
    // execution and the resume that answers it is a `_resumePayloads` entry. It consumes that
    // entry in order with every `ctx.suspend`, live AND on replay past the completed step —
    // otherwise the entry was served to the flow's next gate as its approval.
    const isHuman = this.effectRuntime.kindOf(task.toolId ?? id) === "human";
    if (this.vm.hasCompleted(id)) {
      if (isHuman) {
        // It took its answer — after any entries the operator discarded for it — so a
        // replay past it takes the same number (ADR 0104).
        for (let k = this.discardedFor(id); k >= 0; k--) this.takeIn(scope, id);
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
    if (scope.served !== undefined) throw new ScopeServedError(id, scope.path);

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
    // ADR 0113 D3 — with scopes on, the scope path the step starts in rides the record (kernel-stamped)
    // so a re-run knows which recorded frames belong to which scope.
    this.commit(
      "STEP_STARTED",
      { stepId: id, input, ...(this.scopesEnabled && { scope: scope.path }) },
      this.scopesEnabled ? { metadata: { kernel: true } } : undefined
    );

    // K9.3 — STEP_STARTED is the pre-effect marker the in-doubt guard above reads on recovery, so
    // for a tool declared `idempotent: false` it must be DURABLE before the effect can have any
    // external side effect (the journal is write-behind). One awaited store round trip, on those
    // steps only; undeclared and `idempotent: true` tools keep the write-behind hot path. A
    // refused write (stale fence, storage error) throws here, so the effect is never dispatched
    // and the run fails like any other storage failure (the journal already aborted the run).
    if (this.effectRuntime.declaredIdempotence(toolId) === false) {
      // The drain window counts as in flight (like the dispatch below), so a sibling flow-level
      // emit is stamped exactly as it was when commit + dispatch were synchronous. Decremented on
      // every exit (ack, throw); the dispatch below takes over the count synchronously.
      this.inFlight++;
      try {
        await this.journal.drain();
      } finally {
        this.inFlight--;
      }
      // The drain yielded: a terminal seal may have landed (terminal commit, sealed inbox payload,
      // a park barrier that gave up). A sealed context never dispatches: nothing it did could be
      // recorded, and nothing waits on its idle set any more, so the call simply never settles.
      // A FROZEN / parked-scope context is different: this step was already in flight (it holds
      // activeWork, so the park barrier is waiting for it) and, like any in-flight step at a
      // barrier, it runs to completion and journals its result before EXECUTION_SUSPENDED.
      // Bailing here would leave activeWork > 0 forever (stalling the barrier for parkDrainMs)
      // and strand a STEP_STARTED with no dispatch, which resume would park as EFFECT_INDOUBT.
      if (this.sealed) {
        // A CANCEL seal settles instead (the abort precedes the seal, so the signal is already
        // aborted): execute's finally then ends the work, so the park barrier / run() is not held
        // for parkDrainMs behind an activeWork count nothing will ever lower.
        this.throwIfCancelled(scope.signal);
        this.throwIfCancelled();
        return new Promise<TOut>(() => {});
      }
    }

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
      // ADR 0140 - the frame's task kind, so middleware can tell an agent's tool frames from its model turn.
      ...("kind" in task && typeof task.kind === "string" && { taskKind: task.kind }),
      emit: (eventType: string, payload: unknown) =>
        this.commit(
          eventType,
          guardUserspaceEmit(
            eventType,
            payload,
            {
              kind: "effect",
              stepId: id,
              attempt: this.vm.peekState().frames[id]?.attempts ?? 1,
              conflicts: this.decisionConflict,
            },
            this.meterCeilings
          )
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
        this.dispatchGate?.();
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
    return this.decideIn(this.currentScope(), decisionId, decider, opts);
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
      // ADR 0113 D3 — the decider is skipped, and so is every step it ran.
      this.divergence?.decisionServed(decisionId, this.vm.getDecisionInner(decisionId));
      return this.vm.getDecision(decisionId) as T;
    }
    if (opts?.estimatedCost !== undefined) assertEstimatedCost(opts.estimatedCost);

    // ADR 0112 — a decision is a start of work too. A scope served from its journaled outcome never
    // makes one the first run did not (it would append what no first run recorded); a cancelled
    // scope makes none; and once a park is decided none starts before the park is committed.
    if (cancelScope.served !== undefined) throw new ScopeServedError(decisionId, cancelScope.path);
    if (cancelScope !== this.rootScope) this.throwIfCancelled(cancelScope.signal);
    if (this.frozen || scopeIsParked(cancelScope)) return new Promise<T>(() => {});

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
        this.dispatchGate?.();
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
          ...(o?.onDelta !== undefined && { onDelta: o.onDelta }),
        });
      },
    };
    const decisionFrom = this.vm.peekState().sequence;
    const inner: InnerSteps = {
      ids: new Set(),
      overflowed: false,
      bytes: 0,
      parent: (() => {
        const outer = deciderStore.getStore();
        return outer !== undefined && outer.owner === this ? outer.inner : undefined;
      })(),
    };
    try {
      choice = await deciderStore.run({ owner: this, inner }, () => decider(scope));
    } catch (err) {
      this.unsettled = true;
      throw err;
    } finally {
      scopeOpen = false;
      scopeCtl.abort(new DecideScopeClosedError(decisionId));
      this.inFlight--;
      this.endWork();
    }

    // ADR 0113 D3 — the steps the decider ran ride the record (kernel-stamped), so a re-run that
    // serves this decision knows exactly which recorded frames it will never be asked for.
    // ALWAYS written, even empty (kernel-stamped): an absent field means a pre-R7 record, for which
    // the served decision falls back to the naming convention. The decider must AWAIT the steps it
    // runs: one it detaches and finishes after returning is not in the record (a residual).
    const innerSteps = [...inner.ids];
    this.commit(
      "DECISION_RECORDED",
      {
        decisionId,
        choice,
        innerSteps,
        ...(inner.overflowed && { innerStepsOverflow: true, innerFrom: decisionFrom }),
        ...(opts?.rationale !== undefined && { rationale: opts.rationale }),
        ...(opts?.source !== undefined && { source: opts.source }),
        ...(opts?.alternatives !== undefined && { alternatives: opts.alternatives }),
        ...(opts?.estimatedCostUsd !== undefined && { estimatedCostUsd: opts.estimatedCostUsd }),
        ...(opts?.estimatedCost !== undefined && { estimatedCost: opts.estimatedCost }),
        ...(opts?.estimatedLatencyMs !== undefined && {
          estimatedLatencyMs: opts.estimatedLatencyMs,
        }),
        ...(opts?.confidence !== undefined && { confidence: opts.confidence }),
        // ADR 0079 — the learning half of the D1 metadata: what the policy SAW and
        // which policy it was. Descriptive only; `getDecision` still returns `choice`.
        ...(opts?.context !== undefined && { context: opts.context }),
        ...(opts?.policy !== undefined && { policy: opts.policy }),
      },
      { metadata: { kernel: true } }
    );

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
    const r = this.vm.peekState().variables._resources as
      | (Record<string, unknown> & { custom?: Record<string, number> })
      | undefined;
    if (r === undefined) return 0;
    // ADR 0115 — a built-in is a top-level field, anything else lives in `custom`. Own-property
    // reads only: a dimension is a caller-chosen name (`constructor` must not read a prototype).
    if (BUILTIN_METER_DIMENSIONS.has(dimension)) return (r[dimension] as number | undefined) ?? 0;
    const custom = r.custom;
    return custom !== undefined && Object.hasOwn(custom, dimension)
      ? (custom[dimension] as number)
      : 0;
  }

  parallel<const B extends readonly ParallelBranch[]>(
    branches: B & { readonly [K in keyof B]: CheckedBranch<B[K]> },
    options?: ParallelOptions
  ): Promise<ParallelResults<B>>;
  parallel<TResults extends unknown[]>(
    branches: ExplicitParallelBranches<TResults>,
    options?: ParallelOptions
  ): Promise<TResults>;
  parallel(branches: unknown, options?: ParallelOptions): Promise<unknown> {
    return this.parallelIn(this.currentScope(), branches as Branch[], options);
  }

  /** The scope the current async context belongs to: its branch's, or the root. */
  private currentScope(): Scope {
    const store = scopeStore.getStore();
    return store !== undefined && store.owner === this ? store.scope : this.rootScope;
  }

  /** The context a branch function receives: this context, with the branch's scope bound in. */
  private branchContext(scope: Scope, legacy = false): BranchContext {
    // A wait's identity is `<scopePath>#<ordinal>`: deterministic only when concurrent waits live in
    // DISTINCT scopes. With scopes off `ctx.parallel` is the pre-R6 `Promise.all` and every branch
    // shares the root scope, so branch waits would be numbered by timing and could swap answers on a
    // re-run: refused loudly rather than mis-delivered (ADR 0110 D3, ADR 0112).
    const needScopes = (): Promise<never> =>
      Promise.reject(
        new Error(
          "ctx.receive / ctx.select inside ctx.parallel need `kernel.features.scopes`: without scopes the branches share one scope and their waits cannot have a deterministic identity (ADR 0110 D3, ADR 0112)"
        )
      );
    const overrides: Record<string, unknown> = {
      scopePath: scope.path,
      execute: (task: ExecutableTask, input: unknown) => this.executeIn(scope, task, input),
      run: (step: StepDefinition, input: unknown) => this.executeIn(scope, step, input),
      decide: (id: string, decider: (s: DecideScope) => unknown, o?: DecideOptions) =>
        this.decideIn(scope, id, decider, o),
      parallel: (b: Branch[], o?: ParallelOptions) => this.parallelIn(scope, b, o),
      suspend: (config: SuspendConfig) => this.suspendIn(scope, config),
      receive: legacy ? needScopes : (topic: string) => this.receiveIn(scope, topic),
      select: legacy ? needScopes : (arms: readonly SelectArm[]) => this.selectIn(scope, arms),
      sleep: (ms: number) => this.sleepIn(scope, ms),
      sleepUntil: (wakeAt: number) => this.sleepUntilIn(scope, wakeAt),
    };
    return new Proxy(this, {
      get(target, prop) {
        if (typeof prop === "string" && Object.hasOwn(overrides, prop)) return overrides[prop];
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as BranchContext;
  }

  /** Scopes off (pre-R6 semantics): bounded concurrency, input-order results, no scope at all. */
  private async parallelLegacy(
    scope: Scope,
    branches: Branch[],
    options?: ParallelOptions
  ): Promise<unknown[]> {
    const tasks = branches.map(
      (branch) => () =>
        Array.isArray(branch)
          ? this.executeIn(scope, branch[0], branch[1])
          : Promise.resolve(branch(this.branchContext(scope, true)))
    );
    return parallelLimit(tasks, {
      ...(options?.limit !== undefined && { limit: options.limit }),
      ...(this.signal !== undefined && { signal: this.signal }),
    });
  }

  /**
   * ADR 0112 D1/D2 — one `parallel` call as a cancellation scope.
   *
   * Identity: the call is `"<parent>/<k>"` (`k` = how many `parallel` calls the parent scope has
   * made), its branches `"<parent>/<k>.<i>"` — a pure function of the flow's control flow.
   * A first REAL branch failure (not a park, not cancellation noise) aborts the scope's signal;
   * the call settles once every branch has (bounded by a grace for work that ignores the
   * signal), journals `PARALLEL_COMPLETED`, and throws the first real error by input order —
   * NORMALIZED from the record (see {@link errorFromRecord}), so the first run and every re-run
   * throw the same value.
   * A re-run that finds the scope in `_scopes` is SERVED from the record: exactly the branches the
   * first run launched are launched, each serves its frames and consumes exactly the gate answers
   * it consumed then, none starts work, and the recorded error is thrown.
   */
  private async parallelIn(
    parent: Scope,
    branches: Branch[],
    options?: ParallelOptions
  ): Promise<unknown[]> {
    // ADR 0109 — an open `parallel` is a state `continueAsNew` must refuse (a rotation inside a
    // scope would orphan its branches), however the flow reaches it.
    this.openParallels++;
    this.divergence?.scopeOpen(
      this.scopesEnabled ? `${parent.path}/${parent.parallelCount}` : "",
      branches.flatMap((b) => (Array.isArray(b) ? [(b[0] as StepDefinition).id] : [])),
      branches.every((b) => Array.isArray(b))
    );
    try {
      return await this.parallelScoped(parent, branches, options);
    } finally {
      this.openParallels--;
      this.divergence?.scopeClose();
    }
  }

  private async parallelScoped(
    parent: Scope,
    branches: Branch[],
    options?: ParallelOptions
  ): Promise<unknown[]> {
    if (!this.scopesEnabled) return this.parallelLegacy(parent, branches, options);
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
    // A served scope launches exactly what the first run launched (a `limit` leaves branches the
    // first run never started: starting them now would run live work the record knows nothing of).
    const toLaunch =
      recorded?.launched !== undefined ? Math.min(Math.max(recorded.launched, 0), n) : n;
    const served: ServedScope | undefined =
      recorded !== undefined ? this.servedFrom(recorded) : parent.served;
    const group: ScopeGroup = {
      controller: new AbortController(),
      parked: false,
      cancelled: [],
      consumed: new Map(),
      consumedBytes: 2,
      consumedOverflow: false,
    };
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

    const maybeFinish = (): void => {
      if (running === 0 && (started >= toLaunch || !canStart())) finish?.();
    };

    const launch = (): void => {
      while (running < limit && started < toLaunch && canStart()) {
        const i = started++;
        running++;
        const node: Scope = {
          path: `${scopePath}.${i}`,
          parent,
          group,
          signal: groupSignal,
          parallelCount: 0,
          served,
        };
        const branch = branches[i]!;
        let p: Promise<unknown>;
        try {
          // The branch runs INSIDE its scope's async context: a call through the root `ctx` it
          // closed over is still this scope's.
          p = scopeStore.run({ owner: this, scope: node }, () =>
            Array.isArray(branch)
              ? this.executeIn(node, branch[0], branch[1])
              : Promise.resolve(branch(this.branchContext(node)))
          );
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
      maybeFinish();
    };

    launch();
    maybeFinish();
    await done;
    if (graceTimer !== undefined) clearTimeout(graceTimer);

    if (firstPark !== undefined) throw firstPark;

    if (recorded !== undefined) {
      // Served: the gate answers the first run consumed are consumed, the cursor lands where the
      // first run left it, and the recorded failure is thrown — never the branch's own error.
      if (recorded.cursor !== undefined) {
        this.suspendPassthroughsConsumed = Math.max(
          this.suspendPassthroughsConsumed,
          recorded.cursor
        );
      }
      throw this.errorFromRecord(recorded, scopePath);
    }

    // Real errors by input order (cancellation noise excluded).
    let failed = -1;
    for (let i = 0; i < n; i++) {
      const e = errors[i];
      if (e !== undefined && isReal(e.err)) {
        failed = i;
        break;
      }
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
      // Journaled BEFORE the throw, exactly once: a re-run serves the scope from this record
      // instead of re-deriving it from timing (a cancelled/untyped-failed frame re-executes).
      const record = this.describeFailure(failure, failed);
      if (group.consumedOverflow) {
        this.onWarn(
          `execution "${this.executionId}": parallel scope "${scopePath}" consumed more than ${SCOPE_CONSUMED_BYTES} bytes of gate-answer record (nest \`parallel\` per chunk for very large scopes) — its record omits the consumption list, so a re-run falls back to taking answers by position`
        );
      }
      // An empty list is exact too ("consumed nothing"); only an overflow drops it.
      const exact = !group.consumedOverflow;
      this.commit("PARALLEL_COMPLETED", {
        scopePath,
        failedBranch: failed,
        error: record.error,
        errorName: record.errorName,
        ...(record.errorChannel !== undefined && { errorChannel: record.errorChannel }),
        ...(record.errorPayload !== undefined && { errorPayload: record.errorPayload }),
        cancelled: group.cancelled.slice(0, SCOPE_CANCELLED_CAP),
        launched: started,
        ...(exact && {
          consumed: flattenRuns(group.consumed),
          cursor: this.suspendPassthroughsConsumed,
        }),
      });
      // The first run throws what a served re-run will throw: the value rebuilt from the record.
      // `cause` (the ORIGINAL error, with its stack) exists on the FIRST run only: a served re-run
      // has nothing but the record. It is set after the record is committed, so determinism is
      // untouched — never branch control flow on it.
      const rebuilt = this.errorFromRecord(record, scopePath, failed);
      try {
        Object.defineProperty(rebuilt, "cause", {
          value: failure,
          configurable: true,
          writable: true,
          enumerable: false,
        });
      } catch {
        // A frozen/sealed rebuilt error simply carries no cause.
      }
      this.onWarn(
        `execution "${this.executionId}": parallel scope "${scopePath}" failed in branch ${failed}; original error: ${
          failure instanceof Error ? (failure.stack ?? String(failure)) : String(failure)
        }`
      );
      throw rebuilt;
    }
    throw failure;
  }

  /** How a failing error is journaled: name + message (+ a typed failure's channel and payload). */
  private describeFailure(
    failure: unknown,
    failedBranch: number
  ): Pick<RecordedScope, "error" | "errorName" | "errorChannel" | "errorPayload"> & {
    failedBranch: number;
  } {
    const isObj = typeof failure === "object" && failure !== null;
    const rawName = isObj ? (failure as { name?: unknown }).name : undefined;
    const errorName =
      typeof rawName === "string" && rawName.length > 0 && rawName.length <= 128
        ? rawName
        : "Error";
    const rawMessage = isObj ? (failure as { message?: unknown }).message : undefined;
    const text = stripNamePrefix(
      typeof rawMessage === "string" ? rawMessage : String(failure),
      errorName
    );
    const typed = failure instanceof TypedFailure ? failure : undefined;
    const payload = typed !== undefined ? jsonBounded(typed.payload) : undefined;
    return {
      failedBranch,
      error: `${errorName}: ${text}`.slice(0, SCOPE_ERROR_CAP),
      errorName,
      errorChannel: typed?.channel,
      errorPayload: payload,
    };
  }

  /**
   * ADR 0112 D2 — the one value a failed scope throws, built from its RECORD alone (so the first
   * run and a served re-run cannot differ): a `TypedFailure` stays typed; an error class named in
   * the registry (the built-in `Error` family + `WorkflowRuntimeDeps.errorClasses`) is rebuilt
   * from the recorded message; anything else is a `ParallelScopeFailedError` carrying the name.
   */
  private errorFromRecord(
    rec: Pick<RecordedScope, "error" | "errorName" | "errorChannel" | "errorPayload"> & {
      failedBranch?: number | undefined;
    },
    scopePath: string,
    failedBranch: number | undefined = rec.failedBranch
  ): Error {
    let name = rec.errorName;
    let text = rec.error;
    if (name !== undefined) {
      text = stripNamePrefix(text, name);
    } else {
      // A record that predates `errorName`: the text is `String(error)`, "Name: message".
      const m = /^([A-Za-z_$][\w$]*): ([\s\S]*)$/.exec(rec.error);
      if (m !== null) {
        name = m[1] as string;
        text = m[2] as string;
      }
    }
    if (name === "TypedFailure" && rec.errorChannel !== undefined) {
      return new TypedFailure(rec.errorChannel, rec.errorPayload, text);
    }
    const ctor = name !== undefined ? this.errorClasses.get(name) : undefined;
    if (ctor !== undefined) {
      try {
        const rebuilt = new ctor(text);
        if (rebuilt instanceof Error) return rebuilt;
      } catch {
        // A constructor that throws is not a rehydration: fall through to the typed carrier.
      }
    }
    return new ParallelScopeFailedError(text, scopePath, failedBranch, name);
  }

  private servedFrom(rec: RecordedScope): ServedScope {
    if (rec.consumed === undefined) return { consumed: undefined };
    const consumed = new Map<string, ServedRuns>();
    for (const [path, start, count] of rec.consumed) {
      const entry = consumed.get(path);
      if (entry === undefined) consumed.set(path, { runs: [[start, count]], run: 0, offset: 0 });
      else entry.runs.push([start, count]);
    }
    return { consumed };
  }

  /** The journaled outcome of the scope at `scopePath`, when a previous run recorded one. */
  private recordedScope(scopePath: string): RecordedScope | undefined {
    const scopes = this.vm.peekState().variables._scopes as Record<string, unknown> | undefined;
    if (scopes === undefined || !Object.hasOwn(scopes, scopePath)) return undefined;
    const r = scopes[scopePath] as Record<string, unknown> | undefined;
    if (r === undefined || r === null || typeof r !== "object") return undefined;
    const consumed = Array.isArray(r.consumed)
      ? (r.consumed as unknown[]).filter(
          (e): e is [string, number, number] =>
            Array.isArray(e) &&
            e.length === 3 &&
            typeof e[0] === "string" &&
            Number.isSafeInteger(e[1]) &&
            (e[1] as number) >= 0 &&
            Number.isSafeInteger(e[2]) &&
            (e[2] as number) >= 1
        )
      : undefined;
    return {
      failedBranch: typeof r.failedBranch === "number" ? r.failedBranch : undefined,
      error: typeof r.error === "string" ? r.error : String(r.error ?? "parallel scope failed"),
      errorName: typeof r.errorName === "string" ? r.errorName : undefined,
      errorChannel: typeof r.errorChannel === "string" ? r.errorChannel : undefined,
      errorPayload: r.errorPayload,
      launched: Number.isSafeInteger(r.launched) ? (r.launched as number) : undefined,
      consumed,
      cursor: Number.isSafeInteger(r.cursor) ? (r.cursor as number) : undefined,
    };
  }

  stream(eventType: string, delta: string, done = false): void {
    this.emit(eventType, { delta, done });
  }

  suspend<T = never>(config: SuspendConfig): Promise<T> {
    return this.suspendIn(this.currentScope(), config);
  }

  private suspendIn<T = never>(scope: Scope, _config: SuspendConfig): Promise<T> {
    if (_config.on === FLOW_DIVERGED_GATE) {
      throw new TypeError(
        `ctx.suspend: "${FLOW_DIVERGED_GATE}" is reserved for the kernel (the park of a refused, diverged re-run, ADR 0113); name the gate something else`
      );
    }
    // ADR 0112 — a gate inside a CANCELLED scope never opens and never consumes an answer: the
    // aborted branch unwinds with the scope's own noise. (Taking one would hand a sibling-scope's
    // — or a later gate's — answer to work that is already dead.)
    if (scope !== this.rootScope) this.throwIfCancelled(scope.signal);
    // During resume replay, gates that were already resumed pass through IN
    // ORDER, each receiving ITS OWN recorded payload — the fold's ordered
    // `_resumePayloads` list (1.16.0, ADR 0057). The i-th suspend call in a
    // re-run consumes payload i; a gate beyond the recorded resumes throws and
    // parks as before. (The single-latest `_resumePayload` fed gate 1 the LAST
    // gate's payload in multi-gate flows — the silent bug the list fixes.)
    // Legacy fallback: a pre-1.16 snapshot folded only `_resumePayload`; treat
    // it as a one-entry list so single-gate flows resume byte-identically.
    const answer = this.takeIn(scope, "suspend");
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

  // ── ADR 0109 — continueAsNew ─────────────────────────────────────────────────────────────────

  /**
   * End this execution and start its successor with `carry` (ADR 0109 D1). Never returns: it
   * rejects with a kernel sentinel the runner unwinds on (and the runtime ALSO reads
   * {@link continueSignal}, so a flow that swallows the rejection still rotates). Every refusal
   * below is raised BEFORE anything is frozen or appended: the flow may catch it and carry on.
   */
  async continueAsNew(carry?: unknown): Promise<never> {
    const binding = this.continuationBinding;
    if (binding === undefined || !binding.enabled) throw new ContinueAsNewUnavailableError();
    // A second call after an accepted one is the same rotation (the flow swallowed the first).
    if (this.continuation !== undefined) throw this.continuation;
    const refuse = (reason: string): never => {
      throw new ContinueAsNewRefusedError(this.executionId, reason);
    };
    this.throwIfCancelled();
    if (this.sealed) refuse("the execution is no longer running (its journal is sealed)");
    const preconditions = (): void => {
      if (this.currentScope() !== this.rootScope || this.openParallels > 0) {
        refuse(
          "a ctx.parallel scope is open; finish it first (a rotation inside a scope would orphan its branches)"
        );
      }
      if (this.pending.size > 0) {
        refuse(
          "a ctx.receive / ctx.select wait is outstanding; a parked wait is not a rotation point (answer or cancel it first)"
        );
      }
    };
    preconditions();
    // The carry: JSON, bounded, normalised once (the predecessor's re-drive and the successor's
    // start must see the same value).
    let json: string | undefined;
    try {
      json = JSON.stringify(carry);
    } catch {
      return refuse("the carry has no JSON form (a cycle or a BigInt)");
    }
    const bytes = json === undefined ? 0 : Buffer.byteLength(json, "utf8");
    if (bytes > binding.maxCarryBytes) {
      throw new CarryTooLargeError(this.executionId, bytes, binding.maxCarryBytes);
    }
    let normalized: unknown = json === undefined ? undefined : JSON.parse(json);
    if (binding.validate !== undefined) normalized = binding.validate(normalized);
    // The park barrier (ADR 0112 D3): every step in flight — including one a hand-rolled
    // `Promise.all` started outside a scope — settles first, so a continuation never commits
    // while a sibling of the predecessor can still append. UNBOUNDED, on purpose: a refusal that
    // depended on how long a step took would be decided by the wall clock, and on a re-run (the
    // step now a cache hit) the same call would be accepted where the original was refused,
    // diverging the replay. Waiting is what `await p` would do; the steps' results are journaled
    // as usual, and a cancel (which aborts them) is re-judged just below.
    while (this.activeWork > 0) await this.idle();
    this.throwIfCancelled();
    if (this.sealed) refuse("the execution is no longer running (its journal is sealed)");
    if (this.continuation !== undefined) throw this.continuation;
    preconditions(); // the drain awaited: re-judge everything it could have changed
    // Accepted. Synchronous from here: nothing starts between the idle check and the freeze.
    this.frozen = true;
    this.continuation = new ContinueAsNewSignal(normalized);
    this.rejectContinue?.(this.continuation);
    throw this.continuation;
  }

  /** The accepted continuation, once `continueAsNew` committed to one (the runtime reads it). */
  get continuationRequest(): ContinueAsNewSignal | undefined {
    return this.continuation;
  }

  // ── ADR 0110 — receive / select ──────────────────────────────────────────────────────────────

  receive<T = unknown>(topic: string): Promise<T> {
    return this.receiveIn(this.currentScope(), topic) as Promise<T>;
  }

  select<T = unknown>(arms: readonly SelectArm[]): Promise<SelectResult<T>> {
    return this.selectIn(this.currentScope(), arms) as Promise<SelectResult<T>>;
  }

  private async receiveIn(scope: Scope, topic: string): Promise<unknown> {
    const r = await this.selectIn(scope, [{ inbox: topic }]);
    return r.value;
  }

  /** The next ordinal of a wait in `scope` (ids are `<scopePath>#<ordinal>`, ADR 0110 D3). */
  private nextWaitId(scope: Scope): string {
    const n = this.waitOrdinals.get(scope.path) ?? 0;
    this.waitOrdinals.set(scope.path, n + 1);
    return `${scope.path}#${n}`;
  }

  private armOf(arm: SelectArm, index: number, waitId: string): ArmReg {
    const named = (["gate", "inbox", "timer"] as const).filter(
      (k) => arm !== null && typeof arm === "object" && Object.hasOwn(arm, k)
    );
    if (named.length !== 1) {
      throw new TypeError(
        `ctx.select arm ${index} must name exactly one of gate / inbox / timer (got ${named.length})`
      );
    }
    if ("gate" in arm) {
      if (typeof arm.gate !== "string" || arm.gate.length === 0) {
        throw new TypeError(`ctx.select arm ${index}: gate must be a non-empty string`);
      }
      return {
        waitId,
        kind: "gate",
        name: arm.gate,
        index,
        ...(arm.viewDigest !== undefined && { viewDigest: arm.viewDigest }),
        ...(arm.correlationKey !== undefined && { correlationKey: arm.correlationKey }),
      };
    }
    if ("inbox" in arm) {
      const problem = topicProblem(arm.inbox);
      if (problem !== undefined) throw new TypeError(`ctx.select arm ${index}: ${problem}`);
      return { waitId, kind: "inbox", name: arm.inbox, index };
    }
    if ("timer" in arm && arm.timer !== null && typeof arm.timer === "object") {
      const t = arm.timer as { afterMs?: unknown; at?: unknown };
      const requested =
        typeof t.at === "number" && Number.isFinite(t.at)
          ? t.at
          : typeof t.afterMs === "number" && Number.isFinite(t.afterMs) && t.afterMs >= 0
            ? this.now() + t.afterMs
            : undefined;
      if (requested === undefined) {
        throw new TypeError(
          `ctx.select arm ${index}: a timer needs a finite { afterMs >= 0 } or { at }`
        );
      }
      // `wakeAt` is recorded at FIRST registration (the fold's `_waits`) and served on every later
      // one: an `afterMs` is a request, the recorded instant is the fact (ADR 0110 D4).
      const waits = this.vm.peekState().variables._waits as Record<string, unknown> | undefined;
      const recorded =
        waits !== undefined && Object.hasOwn(waits, waitId)
          ? (waits[waitId] as { wakeAt?: unknown } | undefined)?.wakeAt
          : undefined;
      return {
        waitId,
        kind: "timer",
        name: "timer",
        index,
        wakeAt: typeof recorded === "number" && Number.isFinite(recorded) ? recorded : requested,
      };
    }
    throw new TypeError(`ctx.select arm ${index}: unknown arm shape`);
  }

  private selectIn(scope: Scope, armsIn: readonly SelectArm[]): Promise<SelectResult> {
    try {
      return this.registerSelect(scope, armsIn);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  private registerSelect(scope: Scope, armsIn: readonly SelectArm[]): Promise<SelectResult> {
    const binding = this.inboxBinding;
    if (binding === undefined || !binding.enabled) {
      throw new Error(
        "ctx.receive / ctx.select need the durable inbox: turn on `kernel.features.inbox` (WorkflowRuntimeDeps.inboxEnabled) once every node folds MESSAGE_CONSUMED and multi-wait parks (ADR 0110)"
      );
    }
    if (!Array.isArray(armsIn) || armsIn.length === 0) {
      throw new TypeError("ctx.select needs at least one arm");
    }
    // A wait inside a CANCELLED scope never registers and never consumes (ADR 0112).
    if (scope !== this.rootScope) this.throwIfCancelled(scope.signal);
    const turn = this.workTicks;
    const arms = armsIn.map((a, i) => this.armOf(a, i, this.nextWaitId(scope)));

    // Replay: the lowest-index arm the log has answered. Only one can be (the first answer settles).
    const answers = this.vm.peekState().variables._waitAnswers as
      | Record<string, { kind?: unknown; name?: unknown; payload?: unknown }>
      | undefined;
    if (answers !== undefined) {
      for (const arm of arms) {
        if (!Object.hasOwn(answers, arm.waitId)) continue;
        const rec = answers[arm.waitId] as { kind?: unknown; name?: unknown; payload?: unknown };
        if (rec.kind !== arm.kind || rec.name !== arm.name) {
          throw new FlowDivergenceError(
            this.executionId,
            arm.waitId,
            { kind: String(rec.kind), name: String(rec.name) },
            { kind: arm.kind, name: arm.name }
          );
        }
        // ADR 0130 — a recorded inbox answer that is still a sealed envelope on THIS node means the
        // node cannot open what a capable node journaled. Handing it to the flow would let the run
        // complete with ciphertext as its data. Refuse this ATTEMPT: latch (a flow that swallows
        // the rejection cannot get past it), seal the journal (nothing more is appended, and never
        // an EXECUTION_FAILED: the execution stays where it was for a capable node).
        if (arm.kind === "inbox" && sealedEnvelopeIn(rec.payload) !== "clean") {
          const refusal = new SealedPayloadUnreadableError(
            this.executionId,
            arm.waitId,
            arm.name,
            sealedEnvelopeIn(rec.payload) === "unverified",
            true
          );
          this.sealedReplayRefusalError = refusal;
          // Frozen too: a flow that swallows the rejection must not dispatch NEW tools, effects or
          // children on a node that cannot open the message (step entry and decisions check it).
          this.frozen = true;
          this.seal();
          throw refusal;
        }
        return Promise.resolve({
          arm: arm.index,
          kind: arm.kind,
          value: this.deliveredValue(arm, rec.payload),
        });
      }
    }
    // A scope served from its recorded outcome never starts a wait it did not have an answer for.
    if (scope.served !== undefined) throw new ScopeServedError("select", scope.path);
    // A wait's identity is its ordinal in its scope, which is a pure function of the flow's control
    // flow ONLY while one wait is registered at a time (or several in one synchronous turn, whose
    // order is the call order). A second wait registered after ANY ctx operation started or finished
    // while an earlier one in the same scope is still unanswered got its ordinal from completion order: a re-run
    // may number the two the other way round and hand each the other's payload with no divergence
    // error. Refused loudly; a branch of `ctx.parallel` has its own scope and is the supported way
    // to wait on several things concurrently (ADR 0110 D3).
    for (const other of this.pending) {
      if (!other.settled && other.scope === scope && other.turn !== turn) {
        throw new Error(
          `ctx.receive / ctx.select: a second wait was registered in scope "${scope.path}" while an earlier one is still unanswered. Concurrent waits in one scope are numbered by timing, so a replay could hand each the other's message; wait on several things at once with ctx.parallel (one scope per branch) or register them in the same synchronous turn (ADR 0110 D3).`
        );
      }
    }

    return new Promise<SelectResult>((resolve, reject) => {
      const sel: PendingSelect = { arms, scope, turn, settled: false, resolve, reject };
      const signal = scope.signal;
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.dropPending(sel);
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new ExecutionCancelledError("execution cancelled", signal.reason)
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        sel.detach = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.add(sel);
      this.epoch++;
      this.scheduleQuiescence();
    });
  }

  /** What a settled arm hands the flow: the (tainted) message, the gate's payload, the timer's `{ wakeAt }`. */
  private deliveredValue(arm: ArmReg, payload: unknown): unknown {
    return arm.kind === "inbox" ? tainted(payload, `inbox:${arm.name}`) : payload;
  }

  private dropPending(sel: PendingSelect): void {
    sel.settled = true;
    sel.detach?.();
    if (this.pending.delete(sel)) this.epoch++;
  }

  /** Nothing registered will ever be answered by this context again: free what it holds. */
  private releasePending(): void {
    for (const sel of this.pending) sel.detach?.();
    this.pending.clear();
  }

  /** The waits a park must list: every unsettled arm of every pending select, in registration order. */
  pendingWaits(): SuspendWait[] {
    const out: SuspendWait[] = [];
    for (const sel of this.pending) {
      if (sel.settled) continue;
      for (const a of sel.arms) {
        out.push({
          waitId: a.waitId,
          kind: a.kind,
          ...(a.kind === "gate" && { on: a.name }),
          ...(a.kind === "inbox" && { topic: a.name }),
          ...(a.viewDigest !== undefined && { viewDigest: a.viewDigest }),
          ...(a.correlationKey !== undefined && { correlationKey: a.correlationKey }),
          ...(a.wakeAt !== undefined && { wakeAt: a.wakeAt }),
        });
      }
    }
    return out;
  }

  /**
   * ADR 0110 D2 — quiescence, evaluated at a MACROTASK boundary after the last settlement: the
   * in-flight set of `ctx` operations is empty and every live branch is blocked on a registered
   * wait, so continuations that run in microtasks after a settlement have had the chance to
   * register their next wait or start their next step. Sees only `ctx` operations (a bare
   * non-`ctx` promise is invisible to it: the determinism rule).
   */
  private scheduleQuiescence(): void {
    if (this.quiescenceScheduled || this.parkDecided || this.sealed) return;
    this.quiescenceScheduled = true;
    setImmediate(() => {
      this.quiescenceScheduled = false;
      void this.checkQuiescence();
    });
  }

  private async checkQuiescence(): Promise<void> {
    if (this.parkDecided || this.sealed || this.quiescenceChecking) return;
    if (this.pending.size === 0 || this.activeWork > 0) return;
    this.quiescenceChecking = true;
    const epoch = this.epoch;
    try {
      // Closure 1 of the lost-wakeup protocol (ADR 0110 D5): a message already waiting satisfies
      // its wait LIVE (MESSAGE_CONSUMED) instead of parking.
      const delivered = await this.satisfyFromInbox();
      if (delivered || this.epoch !== epoch || this.activeWork > 0 || this.sealed) {
        this.quiescenceChecking = false;
        this.scheduleQuiescence();
        return;
      }
      this.parkDecided = true;
      this.rejectPark?.(new WaitsPark(this.pendingWaits()));
    } catch (err) {
      this.parkDecided = true;
      this.rejectPark?.(err);
    } finally {
      this.quiescenceChecking = false;
    }
  }

  /**
   * Read each pending inbox topic past its cursor and consume what is there, FIFO, one message per
   * wait (and at most one per `select`, which the first answered arm settles). Returns whether
   * anything was delivered. A duplicate (`messageId` inside the dedupe window) advances the cursor
   * with a `MESSAGE_CONSUMED` that delivers nothing.
   */
  private async satisfyFromInbox(): Promise<boolean> {
    const binding = this.inboxBinding;
    if (binding === undefined) return false;
    let delivered = false;
    const topics = new Set<string>();
    for (const sel of this.pending) {
      for (const a of sel.arms) if (a.kind === "inbox") topics.add(a.name);
    }
    for (const topic of topics) {
      for (let pass = 0; pass < INBOX_READ_PASSES; pass++) {
        const waiting = this.waitsOnTopic(topic);
        if (waiting.length === 0) break;
        // ADR 0130 residuals D9: a topic with a quarantine queue is delivered from the HELD copy,
        // first, at its original position, or skipped; it is never read past its cursor.
        const heldQueue = quarantineQueue(this.vm.peekState().variables, topic);
        if (heldQueue !== undefined) {
          const outcome = await this.deliverHeld(topic, heldQueue[0] as QuarantineEntry);
          if (this.sealed || this.parkDecided) return delivered;
          if (outcome === "delivered") {
            delivered = true;
            continue;
          }
          if (outcome === "dropped") continue; // a duplicate entry was dropped: the next pass reads the topic on
          break;
        }
        const cursor = cursorFor(cursorsOf(this.vm.peekState().variables), topic);
        const msgs = await binding.read(
          binding.chainId,
          topic,
          cursor,
          waiting.length + INBOX_READ_SLACK
        );
        if (this.sealed || this.parkDecided) return delivered;
        if (msgs.length === 0) break;
        for (const m of msgs) {
          const target = this.waitsOnTopic(topic)[0];
          if (target === undefined) break;
          // Exactly the fold's own test (the key is in the folded window), so the live run and a
          // replay of its log can never disagree about what was delivered (ADR 0110 D6).
          const key = dedupeKeyOf(m);
          const duplicate = this.isDuplicate(key);
          if (!duplicate) {
            // ADR 0130: a sealed payload this node cannot open is NOT delivered and NOT journaled.
            // Park instead of failing: the message stays in the inbox (FIFO, so it holds this
            // topic's head) and the post-park notify pass reports the typed error; a node that can
            // open it consumes it on its next notify.
            try {
              assertDeliverable(this.executionId, m);
            } catch (err) {
              if (err instanceof SealedPayloadUnreadableError) return delivered;
              throw err;
            }
          }
          this.commit("MESSAGE_CONSUMED", {
            waitId: target.arm.waitId,
            topic,
            messageId: key,
            inboxSeq: m.inboxSeq,
            sender: m.sender,
            // A duplicate delivers nothing: the fold reads only its cursor and id, so its payload is
            // not copied into the log.
            payload: duplicate ? null : m.payload,
          });
          if (duplicate) continue;
          delivered = true;
          this.dropPending(target.sel);
          target.sel.resolve({
            arm: target.arm.index,
            kind: "inbox",
            value: this.deliveredValue(target.arm, m.payload),
          });
        }
        if (msgs.length < waiting.length + INBOX_READ_SLACK) break;
      }
    }
    return delivered;
  }

  /**
   * ADR 0130 residuals D9 - the live half of the delivery rule for a topic whose first quarantine entry
   * is `entry`: a `released` entry is delivered from its copy (the release is already durable), a
   * `held` entry this node can open is released AND delivered in ONE atomic batch (when auto-release
   * is on). Anything this node cannot deliver is `"skip"`: the topic is passed over and the run parks
   * on it; the post-park notify pass reports why. Never journals a sealed or REDACTED copy.
   */
  private async deliverHeld(
    topic: string,
    entry: QuarantineEntry
  ): Promise<"delivered" | "dropped" | "skip"> {
    const held = this.inboxBinding?.quarantine;
    if (held === undefined) return "skip";
    if (entry.state === "held" && !held.autoRelease) return "skip";
    const copy = await held.readCopy(entry);
    if (this.sealed || this.parkDecided) return "skip";
    const target = this.waitsOnTopic(topic)[0];
    if (target === undefined) return "skip";
    // The held key was delivered meanwhile (a same-key message on another topic, or a retry): the
    // window has it, so the entry is dropped by a consumption that delivers nothing (at most once),
    // which needs no ability to open the copy. The run goes on to the topic's next message.
    if (this.isDuplicate(entry.key)) {
      if (entry.state === "held" && this.isSealed("INBOX_RELEASED")) return "skip";
      const dup = {
        waitId: target.arm.waitId,
        topic,
        messageId: entry.key,
        inboxSeq: entry.inboxSeq,
        sender: copy.ok ? copy.message.sender : (copy.message?.sender ?? {}),
        payload: null,
      };
      if (entry.state === "held") {
        this.journal.commitAtomic([
          {
            eventType: "INBOX_RELEASED",
            payload: {
              topic,
              key: entry.key,
              messageId: copy.ok ? copy.message.messageId : (copy.message?.messageId ?? entry.key),
              disposition: "deliver",
              auto: true,
            },
          },
          { eventType: "MESSAGE_CONSUMED", payload: dup },
        ]);
      } else {
        this.commit("MESSAGE_CONSUMED", dup);
      }
      return "dropped";
    }
    if (!copy.ok) return "skip";
    const consumed = {
      waitId: target.arm.waitId,
      topic,
      messageId: entry.key,
      inboxSeq: entry.inboxSeq,
      sender: copy.message.sender,
      payload: copy.message.payload,
    };
    if (entry.state === "held") {
      if (this.isSealed("INBOX_RELEASED")) return "skip";
      this.journal.commitAtomic([
        {
          eventType: "INBOX_RELEASED",
          payload: {
            topic,
            key: entry.key,
            messageId: copy.message.messageId,
            disposition: "deliver",
            auto: true,
          },
        },
        { eventType: "MESSAGE_CONSUMED", payload: consumed },
      ]);
    } else {
      this.commit("MESSAGE_CONSUMED", consumed);
    }
    this.dropPending(target.sel);
    target.sel.resolve({
      arm: target.arm.index,
      kind: "inbox",
      value: this.deliveredValue(target.arm, copy.message.payload),
    });
    return "delivered";
  }

  /** The unsettled inbox arms on `topic`, in registration order (one entry per arm). */
  private waitsOnTopic(topic: string): Array<{ sel: PendingSelect; arm: ArmReg }> {
    const out: Array<{ sel: PendingSelect; arm: ArmReg }> = [];
    for (const sel of this.pending) {
      if (sel.settled) continue;
      for (const arm of sel.arms)
        if (arm.kind === "inbox" && arm.name === topic) out.push({ sel, arm });
    }
    return out;
  }

  private isDuplicate(key: string): boolean {
    const dedupe = (this.vm.peekState().variables._inbox as { dedupe?: string[] } | undefined)
      ?.dedupe;
    return dedupe?.includes(key) === true;
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
  private takePassthrough(): { payload: unknown; index: number } | undefined {
    const recorded = this.recordedPassthroughs();
    if (this.suspendPassthroughsConsumed >= recorded.length) return undefined;
    this.segmentLive = false; // ADR 0102 — a new gate segment starts served
    const index = this.suspendPassthroughsConsumed++;
    return { payload: recorded[index], index };
  }

  /**
   * A gate answer for a branch of `scope` (ADR 0112). Live, answers are taken in call order as
   * ever, and which one this branch took is journaled with the scope. SERVED, the branch takes
   * exactly the answers the first run gave it — never "the next one", which on a re-run belongs to
   * a LATER gate — and a branch that took none then (it parked or was aborted there) gets none.
   */
  private takeIn(scope: Scope, what: string): { payload: unknown } | undefined {
    const served = scope.served;
    if (served?.consumed !== undefined) {
      const entry = served.consumed.get(scope.path);
      const cur = entry?.runs[entry.run];
      if (entry === undefined || cur === undefined) {
        throw new ScopeServedError(what, scope.path);
      }
      const recorded = this.recordedPassthroughs();
      const index = cur[0] + entry.offset;
      if (++entry.offset >= cur[1]) {
        entry.run++;
        entry.offset = 0;
      }
      if (index >= recorded.length) throw new ScopeServedError(what, scope.path);
      this.segmentLive = false;
      return { payload: recorded[index] };
    }
    const answer = this.takePassthrough();
    if (answer !== undefined) {
      for (let g: Scope | undefined = scope; g !== undefined; g = g.parent) {
        const group = g.group;
        if (group === undefined) continue;
        if (group.consumedOverflow) continue;
        const runs = group.consumed.get(scope.path);
        const last = runs?.[runs.length - 1];
        if (last !== undefined && last[0] + last[1] === answer.index) {
          last[1]++;
        } else {
          // A new run: ~ `["<path>",<start>,<count>],` — the budget counts what the record will weigh.
          group.consumedBytes += scope.path.length + String(answer.index).length + 12;
          if (group.consumedBytes > SCOPE_CONSUMED_BYTES) {
            group.consumedOverflow = true;
            group.consumed.clear();
            continue;
          }
          if (runs === undefined) group.consumed.set(scope.path, [[answer.index, 1]]);
          else runs.push([answer.index, 1]);
        }
      }
    }
    return answer;
  }

  // T1 — durable sleep. The absolute wake time is computed ONCE on the live
  // call and recorded in the EXECUTION_SUSPENDED condition (P9 — wall clock
  // enters the log exactly once); on resume replay the suspend passthrough
  // returns before this recomputes anything, so the fold never sees drift.
  // The runtime's injectable clock, not raw `Date.now()`: the TimerService compares this
  // wakeAt with the same clock (it defaults to `runtime.clock`), so both must agree.
  async sleep(ms: number): Promise<void> {
    await this.sleepIn(this.currentScope(), ms);
  }

  async sleepUntil(wakeAt: number): Promise<void> {
    await this.sleepUntilIn(this.currentScope(), wakeAt);
  }

  private async sleepIn(scope: Scope, ms: number): Promise<void> {
    await this.sleepUntilIn(scope, this.now() + ms);
  }

  private async sleepUntilIn(scope: Scope, wakeAt: number): Promise<void> {
    await this.suspendIn(scope, { on: TIMER_FIRED, wakeAt });
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
