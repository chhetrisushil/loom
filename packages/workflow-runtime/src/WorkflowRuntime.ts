import {
  StorageWriteError,
  SuspendError,
  flowContentHash,
  legacyFlowContentHash,
} from "@loom/core";
import type { EventEnvelope, ExecutionState, FlowDefinition, SuspendWait } from "@loom/core";
import { LazyEffect } from "@loom/effect-runtime";
import type {
  Effect,
  EffectRuntime,
  PrincipalChain,
  TransientInvokeOptions,
} from "@loom/effect-runtime";
import type { BranchRegistry, EventStore, TimerStore } from "@loom/event-runtime";
import {
  RESERVED_STREAM_PREFIX,
  hasInboxStreamShape,
  inboxChainOf,
  isKeyUnavailable,
  isReservedStream,
  recordsErasureIntent,
} from "@loom/event-runtime";
import {
  QUARANTINE_STREAM_PREFIX,
  appendBatchOf,
  headOf,
  inboxStreamsOfChain,
  isAnsweringKind,
  quarantineStreamId,
  readRangeOf,
} from "@loom/event-runtime";
// Import the pure sequence helper from the browser-safe subpath, not the barrel:
// the barrel eagerly re-exports the SQLite store (better-sqlite3 / node:fs), which
// would otherwise leak into every browser app that builds on the WorkflowRuntime.
import { sliceBySequence } from "@loom/event-runtime/sequence";
import {
  EVENT_SCHEMA_VERSION,
  FAILED_WHILE_PARKED,
  FLOW_DIVERGED_GATE,
  INBOX_DEDUPE_CAP,
  QUARANTINE_FOLD_CAP,
  ReplayVM,
  knownEventTypes,
  normalizeSnapshotState,
} from "@loom/replay-vm";
import { type Snapshot, type SnapshotStore, assertSnapshotIdentity } from "@loom/snapshot-runtime";
import { ulid } from "ulid";
import { DivergenceGuard, type DivergenceMode } from "./DivergenceGuard";
import { ExecutionJournal } from "./ExecutionJournal";
import { highestMissing } from "./LogLifecycle";
import { WorkflowContextImpl } from "./WorkflowContext";
import type { SurfaceFactory } from "./WorkflowContext";
import { PlaintextCheckpointError, assertCheckpointSealed } from "./checkpointGuard";
import {
  ChainHopLimitError,
  type ChainIdentity,
  ContinuationConflictError,
  ContinueAsNewSignal,
  DEFAULT_MAX_CARRY_BYTES,
  DEFAULT_MAX_CHAIN_HOPS,
  ForkPastContinuationError,
  ReservedSuccessorIdError,
  carriedOf,
  chainDeadlineOf,
  chainOfFirstEnvelope,
  chainOfState,
  derivedParentOf,
  isVerifiedSuccessor,
  sameLineage,
  successorIdOf,
  successorShapeOf,
} from "./continuation";
import {
  armDeadline,
  assertFlowBudgets,
  assertValidBudget,
  remainingBudget,
} from "./deadlineTimer";
import { type DriverLease, DriverLeases, type HeartbeatOptions, NO_LEASE } from "./driverLease";
import { UNKNOWN_OWNER_REASON } from "./executionAccessPolicy";
import { asInDoubtVerdict, inDoubtDecisionId } from "./inDoubt";
import {
  DEFAULT_INBOX_MAX_BACKLOG,
  DEFAULT_INBOX_MAX_PAYLOAD_BYTES,
  DISCARD_WAIT_ID,
  INBOX_STREAM_PREFIX,
  INBOX_TOPIC_SEQ_BASE,
  INBOX_TTL_ACTOR,
  INBOX_WAKE_AT,
  type InboxTtlConfig,
  MAX_MESSAGE_ID_LENGTH,
  type QuarantineEntry,
  WAITS_PARK_ON,
  activateInboxLayout,
  appendInboxMessage,
  asMessage,
  assertDeliverable,
  assertTtlConfig,
  chainIdOf,
  chainIdOfFirst,
  createInboxSource,
  cursorFor,
  cursorsOf,
  dedupeKeyOf,
  deleteInbox,
  discardFacts,
  inboxDeliverable,
  inboxLayoutActive,
  inboxStreamId,
  inboxTopicStreamId,
  maxCursor,
  quarantineQueue,
  quarantineQueues,
  readRegisteredTopics,
  registerInboxTopic,
  retireInboxTopic,
  scanExpired,
  scanInbox,
  sealedEnvelopeIn,
  seedInboxFloors,
  staleInboxBatch,
  topicProblem,
  trimInbox,
  trimTopicStream,
  ttlOfTopic,
} from "./inbox";
import { WaitsPark, isKernelHumanPark } from "./kernelPark";
import { LeaseHeldError, LeaseLostError } from "./leaseKeeper";
import type { LeaseKeeper } from "./leaseKeeper";
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
  DEFAULT_QUARANTINE_MAX,
  appendQuarantineCopy,
  assertQuarantineMax,
  findQuarantineCopy,
  readInboxEnvelope,
  readQuarantineCopy,
  readsAsRedacted,
  retainedSpan,
  skippedDuplicateFact,
  stampOf,
  trimQuarantine,
} from "./quarantine";
import type { CopyRead } from "./quarantine";
import {
  type QuarantineEventReader,
  SealGuardedEventStore,
  SealGuardedSnapshotStore,
  type SealedDetail,
  SealedStreamUnreadableError,
  isSealedUnreadable,
  principalLooksSealed,
  readLeftOpaque,
  sealedDetailOf,
  withSealedDetail,
} from "./sealGuard";
import {
  type StrayPassthroughReport,
  StrayScanner,
  discardDecisionId,
  strayPassthroughMessage,
} from "./strayPassthroughs";
import { assertNotTransientFold, markTransientFold } from "./transientFold";
import {
  ApprovalRejectedError,
  CompactedForkPointError,
  EFFECT_INDOUBT_RESOLVED,
  EXECUTION_RECOVERED,
  ExecutionAlreadyExistsError,
  ExecutionCancelledError,
  ExecutionDeniedError,
  ExecutionNotTerminalError,
  ExecutionStoreUnavailableError,
  FlowCodeMismatchError,
  FlowMigrationCheckError,
  FlowReplayDivergenceError,
  InboxClosedError,
  InboxDiscardRefusedError,
  InboxFullError,
  InboxMessageRefusedError,
  InboxQuarantineRefusedError,
  InboxTopicStreamsRequiredError,
  InputValidationError,
  OutcomeContendedError,
  OutcomeRefusedError,
  QuarantineHeldError,
  ResumeContendedError,
  ResumePayloadValidationError,
  ResumeRefusedError,
  SealedPayloadUnreadableError,
  StartFencedOutError,
  StartLeaseHeldError,
  StateMigrationError,
  TIMER_FIRED,
} from "./types";
import type {
  DiscardInboxInput,
  DiscardInboxOptions,
  DiscardInboxResult,
  ErrorClassCtor,
  ExecutionAuthorizer,
  ExecutionAuthzRequest,
  ExecutionHandle,
  ExecutionOp,
  FlowRunner,
  ForkOptions,
  ForkResult,
  InboxExpiryResult,
  InboxMessage,
  InboxSource,
  LineageGrant,
  QuarantineInboxInput,
  QuarantineInboxOptions,
  QuarantineInboxResult,
  RecordOutcomeInput,
  RecordOutcomeOptions,
  RecordOutcomeResult,
  RecoveryClaimGrant,
  RegisteredFlow,
  ReleaseInboxInput,
  ReleaseInboxOptions,
  ReleaseInboxResult,
  ResumeAuthenticator,
  ResumeEvent,
  RunOptions,
  SendMessage,
  SendOptions,
  SendResult,
  SystemGrant,
} from "./types";
import { OUTCOME_SCORE_BOUND, assertMeterCeilings } from "./userspaceEmit";
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
  /**
   * ADR 0110 D5 — consecutive `atomic` bootstrap events are committed through ONE durable write
   * (`ExecutionJournal.commitAtomic`): all land or none do.
   */
  atomic?: true;
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
   * ADR 0110 — the durable inbox: `ctx.receive` / `ctx.select` (registering, multi-wait parks,
   * wait-addressed resumes) and the authorized `runtime.send`. **Default `false`** (the
   * rolling-upgrade rule, `kernel.features.inbox`): an execution that has ever parked with
   * `waits` cannot be driven by a pre-1.23.0 node, so turn it on only once every node folds
   * `MESSAGE_CONSUMED` and `condition.waits`. Off, `ctx.receive` / `ctx.select` and `send` throw
   * a message naming the flag. Set by `defineConfig({ kernel: { features: { inbox: true } } })`.
   */
  inboxEnabled?: boolean;
  /**
   * ADR 0109 — `ctx.continueAsNew` (bounded history). **Default `false`** (the rolling-upgrade
   * rule, `kernel.features.continueAsNew`): a pre-1.23.0 node ignores `EXECUTION_CONTINUED` and the
   * `continued` status, so it would read the predecessor as still running and re-drive it. Turn it
   * on only once every node runs a kernel that folds them. Off, `ctx.continueAsNew` throws
   * {@link ContinueAsNewUnavailableError}; existing chains stay readable, resumable and cancellable
   * either way. Set by `defineConfig({ kernel: { features: { continueAsNew: true } } })`.
   */
  continueAsNewEnabled?: boolean;
  /**
   * ADR 0113 D3 — the replay-divergence detector. A re-run that is about to make a LIVE journal
   * append (a step, a decision, an emit, a timer or suspend, a spawn, a receive, a continuation)
   * or to complete, while a step the log records as completed was never asked for, has diverged
   * from its log: the body changed shape under an in-flight execution.
   *
   * - `"warn"` (**default**): report once per run through `onWarn` (and count it, see
   *   {@link WorkflowRuntime.divergenceWarnings}); the run proceeds. It can only report a fault
   *   already silently present.
   * - `"fail"`: raise {@link FlowReplayDivergenceError} BEFORE that append, so nothing runs under
   *   the diverged body; no terminal event is written (a deploy fault must not make an execution
   *   permanently failed — fix the code or migrate, and it resumes). `defineConfig` makes this the
   *   default under `security.strict`.
   * - `"off"`: silent.
   *
   * Membership only, no order; frames before an `EXECUTION_MIGRATED` are exempt; steps of an open
   * `parallel` scope are compared as a set once it closes.
   */
  divergence?: DivergenceMode;
  /**
   * ADR 0113 D1 — record the structural flow hash as `sha256:<hex>` on new starts. **Default
   * `false`** (the rolling-upgrade rule, `kernel.features.sha256FlowHash`): a node that predates
   * ADR 0113 compares the recorded value with its own 32-bit `fnv1a:` hash and would refuse to
   * resume every execution a newer node started (`FlowCodeMismatchError`). Off, new starts keep
   * writing `fnv1a:`; either form is always READ and accepted. Turn it on once every node reads
   * `sha256:`.
   */
  sha256FlowHash?: boolean;
  /** ADR 0109 D1 — the kernel cap on a carry, in bytes of its JSON text. Default 1 MiB (1 048 576). */
  maxCarryBytes?: number;
  /**
   * ADR 0109 D4 — a head walk (`resume`, `send`, `cancel`, follow-to-head) is ROUTED to the newest
   * generation of the chain (an O(log n) probe over the deterministic ids, verified link by link), so
   * the first id stays addressable forever. This bounds only the RESIDUAL forward stepping after that
   * (the start-to-commit window, or the fallback when the deepest log fails verification): past it
   * the walk refuses with {@link ChainHopLimitError} naming the furthest id it reached. Default 8.
   */
  maxChainHops?: number;
  /**
   * ADR 0110 D1 — the reader seam over the inbox stream. The default reads this runtime's own
   * `EventStore`. A function type, not a versioned SPI, until a second implementation exists.
   */
  inbox?: InboxSource;
  /** ADR 0110 D1 — `send` refuses past this many unconsumed messages per chain. Default 10 000. */
  inboxMaxBacklog?: number;
  /**
   * ADR 0110 D1 — `send` refuses once the stream RETAINS this many entries above its trim floor,
   * whatever their consumption state. Default 4 x `inboxMaxBacklog`. The stream is trimmed by
   * prefix only (the `EventStore` SPI has no per-entry delete), so ONE unconsumed message on a topic
   * nobody waits on pins every entry above it, consumed or not; without this cap a hot topic would
   * grow the stream without bound behind it. Refusing is the bounded-storage answer: the sender
   * sees `InboxFullError` naming the pin, and a consume of the pinned message (or retirement of the
   * chain) releases it.
   */
  inboxMaxRetained?: number;
  /**
   * ADR 0115 D2 — per-dimension override of the sanity ceiling on one `RESOURCE_METERED`
   * increment, applied in `guardUserspaceEmit` (never in the fold, which is pure and uses the
   * fixed defaults). Built-in dimensions keep their defaults unless named; a custom dimension
   * defaults to 1e15 and may only be lowered.
   */
  meterCeilings?: Readonly<Record<string, number>>;
  /** ADR 0110 D1 — the largest JSON payload `send` accepts, in bytes. Default 65 536. */
  inboxMaxPayloadBytes?: number;
  /**
   * ADR 0130 residuals D9 - held (quarantined) messages per chain; bounds the RETAINED span of the
   * chain's quarantine stream and refuses `quarantineInbox` past it. Default 256, ceiling 1024 (the
   * fold's own cap, which a fold cannot read from a setting).
   */
  inboxQuarantineMax?: number;
  /**
   * ADR 0130 residuals D9 - a node that CAN open a held message lifts the hold itself, lazily, at the
   * delivery points (notify scan, timer poll, recovery, a live receive on the held topic) in ONE atomic
   * batch with the delivery. Default `true`. A node-local policy, never read by the fold: `false`
   * leaves every hold for an operator's `releaseInbox`.
   */
  inboxAutoRelease?: boolean;
  /**
   * ADR 0110 amendment, D10a — expire UNCONSUMED inbox messages after this many milliseconds
   * (a number for every topic, or `{ default?, topics? }`). OFF by default: with no TTL configured
   * nothing below changes. An expiry is a journaled discard (`MESSAGE_CONSUMED` with the reserved
   * discard wait, `reason: "expired"`, recorded as the runtime, not an operator), so it replays; it
   * is decided from the injected clock against the message's envelope timestamp, never inside the
   * fold, and it is driven by `TimerService` rows (written by `send`, re-armed by each pass, swept
   * by `recoverAbandoned`). Needs a `timerStore`, and every node of a fleet must configure it alike.
   */
  inboxMessageTtlMs?: InboxTtlConfig;
  /**
   * ADR 0110 amendment, D10b — this node may WRITE per-topic inbox streams, once the FLEET has opted
   * in (a durable switch written by {@link WorkflowRuntime.enableInboxTopicStreams}; until then the
   * node keeps writing the legacy single stream). Off by default: the node writes exactly as before.
   * Every D10-aware node READS both layouts whatever this says, so turn it on only after every node
   * runs this version (a pre-D10 node cannot read a topic stream). See the ADR's operator procedure.
   */
  inboxTopicStreams?: boolean;
  /** ADR 0110 D10b — topics a chain may have streams for (counted from its registry). Default 64. */
  inboxMaxTopics?: number;
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
   * ADR 0114 — the factory behind `ctx.ui`: `(emit) => accessor`. The kernel names no UI
   * vocabulary, so a composed app passes `createSurfaceEmitter` from `@loom/agent-surface`
   * (`defineConfig`, `@loom/testing` and the scaffold already do). Without it `ctx.ui` THROWS a
   * message naming this dep — the deliberate "break now" for a bare `new WorkflowRuntime`. The
   * documented spelling for new code is `surface(ctx)` from `@loom/agent-surface`.
   */
  surface?: SurfaceFactory;
  /**
   * Take a mid-run snapshot every N committed events, bounding the replay tail so
   * a resume/recovery folds only ~N events instead of the whole log. Omit (or 0)
   * to keep the default cadence (snapshots only at suspend + fork). A larger N
   * means fewer writes but a longer worst-case replay.
   */
  snapshotEvery?: number;
  /**
   * ADR 0130 D8 - escape hatch for the kernel's refusal of a plaintext checkpoint. By default, when
   * the event store seals payloads (`sealingCapability()` has covers), a snapshot store that does not
   * seal the whole folded state under the SAME KeyStore makes this constructor throw
   * `PlaintextCheckpointError`. `true` accepts plaintext checkpoints (a snapshot store on an
   * encrypted volume, or a migration in progress). Set by `defineConfig` from
   * `security.crypto.allowPlaintextCheckpoints`.
   */
  allowPlaintextCheckpoints?: boolean;
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
  /**
   * ADR 0130 D11 (S7c) - heartbeat leases. Given, EVERY driver of an execution (`start`, `resume`,
   * the `send`/notify winner, a continuation successor, a worker attempt) holds a lease through ONE
   * per-runtime {@link LeaseKeeper} from before its first append until its suspend/terminal commit
   * (released AWAITED before the handle resolves), lease BEFORE fence. A driver whose acquire finds
   * another live owner stands down ({@link LeaseHeldError}) without taking the fence; a driver that
   * loses its lease aborts its run (`LeaseLostError` on the abort signal and the handles), appends
   * nothing, and is gated before every effect dispatch and every append. Absent or
   * absent = no keeper and today's behaviour byte-for-byte (G2).
   */
  heartbeat?: HeartbeatOptions;
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
    // ADR 0113 — the refusal park is re-driven, not answered: status-only, so the answer never
    // reaches `_resumePayloads` (where the body's next gate would take it as its approval).
    if (condition?.on === FLOW_DIVERGED_GATE)
      return [{ eventType: "EXECUTION_RESUMED", payload: null }];
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

/**
 * Is `err` PROOF the record was erased: a `PayloadShreddedError`, or a `KeyUnavailableError` whose
 * redacted view records the erase intent (the ShredIncomplete window)? The ONLY failures that mean
 * "unknown owner" rather than "the store/resolver faulted, retry" (ADR 0039, amendment 2026-10-17).
 */
function isErasure(err: unknown): boolean {
  const e = err as { name?: unknown } | null;
  if (e?.name === "PayloadShreddedError") return true;
  return (
    isKeyUnavailable(err) &&
    recordsErasureIntent(
      err.redacted ?? [],
      typeof err.subjectId === "string" ? err.subjectId : undefined
    )
  );
}
/** Bound on the per-execution sealed-refusal report counters. */
const SEALED_REPORT_CAP = 1024;
/** ADR 0116 — how many times a reopen re-slots its bootstrap over late outcomes that took its slot. */
const REOPEN_ATTEMPTS = 3;
/** ADR 0116 — bounded sequence-CAS attempts of `recordOutcome` before it reports contention. */
const RECORD_OUTCOME_ATTEMPTS = 8;
/** The folded `_outcomes` entry fields `recordOutcome` compares for idempotency. */
interface RecordedOutcome {
  key?: string;
  decisionId?: string;
  success?: boolean;
  score?: number;
  late?: boolean;
}
const OUTCOME_KEY_MAX = 256;
/** ADR 0116 — a reward's magnitude bound: huge-but-finite scores overflow a SUM to Infinity. */
export const OUTCOME_SCORE_MAX = OUTCOME_SCORE_BOUND;
/** ADR 0116 — late outcomes one execution accepts; the duplicate check and the fold are O(n). */
export const LATE_OUTCOMES_MAX = 1024;

function outcomeShapeProblem(o: RecordOutcomeInput): string | undefined {
  if (typeof o !== "object" || o === null) return "the outcome is not an object";
  if (typeof o.decisionId !== "string" || o.decisionId.length === 0) {
    return "decisionId must be a non-empty string";
  }
  if (typeof o.key !== "string" || o.key.length === 0 || o.key.length > OUTCOME_KEY_MAX) {
    return `key must be a non-empty string of at most ${OUTCOME_KEY_MAX} characters`;
  }
  if (o.success !== undefined && typeof o.success !== "boolean") return "success must be a boolean";
  if (
    o.score !== undefined &&
    !(
      typeof o.score === "number" &&
      Number.isFinite(o.score) &&
      Math.abs(o.score) <= OUTCOME_SCORE_MAX
    )
  ) {
    return `score must be a finite number with |score| <= ${OUTCOME_SCORE_MAX}`;
  }
  if (o.success === undefined && o.score === undefined) {
    return "an outcome needs a success or a score";
  }
  return undefined;
}
/** How many of an owner's newest events `send` reads to tell parked from running. */
const SEND_TIP_WALK = 8;

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

/**
 * ADR 0110 D4 — the legacy single-gate fields of a quiescent park. A single GATE wait writes them
 * byte-identically to a `ctx.suspend` park (`locatePark` and an older reader are unaffected);
 * any other combination carries the reserved `on`.
 */
function legacyConditionOf(waits: readonly SuspendWait[]): {
  on: string;
  correlationKey?: string;
  viewDigest?: string;
} {
  const only = waits.length === 1 ? waits[0] : undefined;
  if (only?.kind === "gate" && only.on !== undefined) {
    return {
      on: only.on,
      ...(only.correlationKey !== undefined && { correlationKey: only.correlationKey }),
      ...(only.viewDigest !== undefined && { viewDigest: only.viewDigest }),
    };
  }
  return { on: WAITS_PARK_ON };
}

/** How many chains' inbox bookkeeping a runtime remembers (FIFO eviction; both maps are only hints). */
const INBOX_HINT_MEMORY = 4096;

function rememberBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key); // re-insert at the end: eviction order = recency
  if (map.size >= INBOX_HINT_MEMORY) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** An inbox bound, when given, must be a positive integer: NaN / 0 / negative / fractional never silently clamp. */
function assertPositiveInt(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name} must be a positive integer (got ${String(value)}): it bounds the durable inbox (ADR 0110)`
    );
  }
}

/** How long a scan that found a chain's inbox full is trusted (see `assertInboxHasRoom`). */
const INBOX_FULL_TTL_MS = 250;

/**
 * A delivery batch built from cursors that an append has since moved past (a journaled operator
 * discard is the one that can land under the notifier's fence). Internal: `notifyAttempt` turns it
 * into a refold. The batch is never written: a consumption at or below the folded cursor must not
 * be recorded as an answer (the fold would accept it).
 */
class StaleInboxBatch extends Error {
  constructor(executionId: string) {
    super(`The inbox batch for "${executionId}" was built from cursors that have since moved.`);
    this.name = "StaleInboxBatch";
  }
}

/** ADR 0130 D9 - events a release's idempotent-repeat search examines (backwards from the tail), and its read chunk. */
const RELEASE_SEARCH_BUDGET = 4096;

/** The two operator verbs that may fold an owner from the log when the checkpoint is sealed (S5b). */
type QuarantineVerb = "quarantineInbox" | "releaseInbox";
const RELEASE_SEARCH_CHUNK = 64;
const RETRY = Symbol("notify-retry");
const RETRY_FENCED = Symbol("notify-retry-fenced");
const NOTIFY_ATTEMPTS = 4;
/** ADR 0110 D10b — default `inboxMaxTopics`. */
const DEFAULT_INBOX_MAX_TOPICS = 64;
/** ADR 0110 D10a — most messages one expiry pass discards (the rest are armed for the very next tick). */
const INBOX_EXPIRY_BATCH = 1024;
/** ADR 0110 D10a — expiry rows land on whole multiples of this, so messages expiring together share a pass. */
const INBOX_EXPIRY_GRANULARITY_MS = 1000;
/** Messages one notify read asks for. */
const NOTIFY_PAGE = 64;
/** The most MESSAGE_CONSUMED facts one atomic batch carries. */
const NOTIFY_BATCH_CAP = 1024;

/** The `eventType` of the kernel's own inbox-delivery resume (ADR 0110 D5): never a caller's. */
const INBOX_DELIVERY = "InboxDelivery";

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
  // ADR 0110 — the durable inbox.
  private readonly inboxEnabled: boolean;
  // ADR 0109 — continue-as-new.
  private readonly continueAsNewEnabled: boolean;
  private readonly maxCarryBytes: number;
  private readonly maxChainHops: number;
  // ADR 0113 D3 — the replay-divergence detector's mode, and how often it warned.
  private readonly divergenceMode: DivergenceMode;
  private readonly sha256FlowHash: boolean;
  private divergenceWarned = 0;
  /** The hash a NEW start / migration records for `flowId` (see `sha256FlowHash`). */
  private recordedHashOf(flowId: string): string | undefined {
    return (this.sha256FlowHash ? this.flowHashes : this.flowLegacyHashes).get(flowId);
  }

  /** ADR 0113 D3 — how many runs the detector has reported (`warn` mode) since this runtime was built. */
  get divergenceWarnings(): number {
    return this.divergenceWarned;
  }
  private readonly inboxSource: InboxSource;
  private readonly inboxMaxBacklog: number;
  private readonly inboxMaxPayloadBytes: number;
  private readonly inboxMaxRetained: number;
  private readonly inboxQuarantineMax: number;
  /** Chains whose quarantine stream this node knows may hold copies (see `trimQuarantineOf`); bounded. */
  private readonly quarantineChains = new Map<string, true>();
  private readonly inboxAutoRelease: boolean;
  private readonly inboxTtl: InboxTtlConfig | undefined;
  private readonly inboxTopicStreamsFlag: boolean;
  private readonly inboxMaxTopics: number;
  /** Sticky: the fleet switch was seen (it is one-way, so `true` is never re-checked). */
  private inboxLayoutSeen = false;
  /** Per chain, the topics this process knows are registered (a hint; the registry is the truth). */
  private readonly inboxKnownTopics = new Map<string, Set<string>>();
  /** Per topic stream, the cursor at which a drained-topic retirement was last evaluated (see `pruneDrainedTopic`). */
  private readonly inboxPruned = new Map<string, number>();
  /** Per chain, the instant of the expiry row this process last wrote (a pending one is not re-written per send). */
  private readonly inboxExpiryRows = new Map<string, number>();
  private readonly meterCeilings: Readonly<Record<string, number>> | undefined;
  /**
   * Chains already warned about a pinned inbox, with the inbox sequence of the pin warned about
   * (see `assertInboxHasRoom`). Re-armed eagerly: the trim that moves the floor past the pin
   * clears it, and a scan that finds a DIFFERENT oldest-unconsumed message warns again. The map is
   * bounded (FIFO): an entry evicted under extreme chain churn can cost one repeat warning.
   */
  private readonly inboxWarned = new Map<string, number>();
  /** Per chain, the last exact backlog count (see `assertInboxHasRoom`): an upper-bound base for later sends. */
  private readonly inboxCounted = new Map<string, { head: number; unconsumed: number }>();
  /** Per chain, the stream sequence this process last trimmed through (a cheap "nothing new" test). */
  private readonly inboxTrimmed = new Map<string, number>();
  /** Per chain, the highest sequence known consumed-and-trimmed: the cheap backlog floor. */
  private readonly inboxFloors = new Map<string, number>();
  /** Per chain, a backlog scan that found the stream FULL (see `assertInboxHasRoom`). */
  private readonly inboxFull = new Map<
    string,
    { head: number; until: number; unconsumed: number; pinnedAt?: number }
  >();
  private warnedNoInboxTimers = false;
  private readonly errorClasses: Record<string, ErrorClassCtor> | undefined;
  private readonly surface: SurfaceFactory | undefined;
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
  private readonly recoveryClaimToken: RecoveryClaimGrant = Object.freeze({
    __loomRecoveryClaim: true,
  });
  private readonly validateInput: boolean;
  private readonly now: () => number;
  // ADR 0130 D11 (S7c) - the per-runtime heartbeat keeper behind every driver; undefined = unwired.
  private readonly driverLeases: DriverLeases | undefined;
  private readonly onExecutionDenied:
    | ((request: ExecutionAuthzRequest, reason?: string) => void)
    | undefined;
  private readonly flows = new Map<string, RegisteredFlow>();
  // K11.1 — content hash of each flow id's CURRENT (most recently registered) version.
  private readonly flowHashes = new Map<string, string>();
  // ADR 0113 D1 — the pre-sha256 (`fnv1a:`) hash of the same, so a log that recorded one resumes.
  private readonly flowLegacyHashes = new Map<string, string>();
  // K11.2 — every registered version per flow id, for pinned resumption.
  private readonly flowVersions = new Map<
    string,
    Map<string, { flow: RegisteredFlow; hash: string; legacy: string }>
  >();
  // K8.2 — live executions this runtime instance is currently driving, so
  // cancel() can reach an in-flight run by id. Entries are removed when the run
  // settles (completes / suspends / fails / cancels).
  private readonly liveHandles = new Map<string, ExecutionHandle>();

  /** The seal-guarded store, kept typed so {@link quarantineReadsFor} can reach its read-only view. */
  private readonly guardedEvents: SealGuardedEventStore;

  /**
   * User ruling 2026-10-14. The ONLY door to the opaque-sealed read view: the quarantine verbs'
   * owner-log reads (`foldFromCompleteLog`, `classifyTip`, `findReleaseFact[Back]`) pass their verb
   * and get a view that steps over a `MESSAGE_CONSUMED.payload` seal; every other caller (verb
   * `undefined`) gets the ordinary guarded store. `sealGuardFitness.test.ts` pins this.
   */
  private quarantineReadsFor(verb: QuarantineVerb | undefined): QuarantineEventReader {
    return verb === undefined ? this.eventStore : this.guardedEvents.quarantineReadView();
  }

  constructor(deps: WorkflowRuntimeDeps) {
    // ADR 0130 residuals D7 - THE funnel: every read of a stored envelope into the fold, the replay
    // VM, an authorization decision or a flow passes the seal guard (a marker this node cannot open,
    // or a key it does not hold, is refused denial-shaped before anything is folded or appended).
    // `packages/spec` pins that no kernel source reads the unguarded store.
    const guardedEvents = new SealGuardedEventStore(deps.eventStore);
    this.eventStore = guardedEvents;
    // ADR 0130 D8 - fail fast: a sealing log beside a checkpoint store that does not seal the whole
    // state (under the same keys) is refused here; every `save` re-checks (stores can change late).
    const allowPlaintext = deps.allowPlaintextCheckpoints === true;
    if (!allowPlaintext) assertCheckpointSealed(guardedEvents, deps.snapshotStore);
    this.guardedEvents = guardedEvents;
    const guardedSnapshots = new SealGuardedSnapshotStore(deps.snapshotStore, async (id) => {
      // A key-unavailable snapshot load asks the LOG whether it was a real shred. Read the WHOLE
      // stream (a tombstone sits ABOVE the snapshot, not at sequence 0): the guarded read raises the
      // store's own erasure error when it can see the shred, and a `PAYLOAD_SHREDDED` fact in what
      // it returns is the erasure outcome too (named like the crypto plugin's error, which the
      // cancel / recordedPrincipal paths already match by name). Rare path, bounded by the back-off.
      const stream = await guardedEvents.read(id);
      let tomb: EventEnvelope | undefined;
      for (let i = stream.length - 1; i >= 0 && tomb === undefined; i--) {
        if (stream[i]!.eventType === "PAYLOAD_SHREDDED") tomb = stream[i];
      }
      if (tomb !== undefined) {
        const subjectId = (tomb.payload as { subjectId?: unknown } | null)?.subjectId;
        throw Object.assign(
          new Error(
            `execution "${id}" was crypto-shredded (PAYLOAD_SHREDDED in its log${typeof subjectId === "string" ? ` for subject "${subjectId}"` : ""})`
          ),
          { name: "PayloadShreddedError", subjectId, executionId: id }
        );
      }
    });
    if (!allowPlaintext) {
      guardedSnapshots.guardSaves((snap, store) =>
        assertCheckpointSealed(guardedEvents, store, snap.executionId)
      );
    }
    this.snapshotStore = guardedSnapshots;
    this.effectRuntime = deps.effectRuntime;
    this.onEvent = deps.onEvent;
    this.branchRegistry = deps.branchRegistry;
    this.onStorageError = deps.onStorageError;
    this.onWarn = deps.onWarn ?? ((m: string) => console.warn(`[loom] ${m}`));
    this.snapshotEvery = deps.snapshotEvery;
    this.parkDrainMs = deps.parkDrainMs;
    this.scopes = deps.scopes === true;
    this.inboxEnabled = deps.inboxEnabled === true;
    this.continueAsNewEnabled = deps.continueAsNewEnabled === true;
    assertPositiveInt("maxCarryBytes", deps.maxCarryBytes);
    assertPositiveInt("maxChainHops", deps.maxChainHops);
    this.maxCarryBytes = deps.maxCarryBytes ?? DEFAULT_MAX_CARRY_BYTES;
    this.maxChainHops = deps.maxChainHops ?? DEFAULT_MAX_CHAIN_HOPS;
    const divergence = deps.divergence ?? "warn";
    if (divergence !== "off" && divergence !== "warn" && divergence !== "fail") {
      throw new Error(`divergence must be "off", "warn" or "fail" (got ${String(divergence)})`);
    }
    this.divergenceMode = divergence;
    this.sha256FlowHash = deps.sha256FlowHash === true;
    if (this.inboxEnabled && deps.eventStore.appendBatch === undefined) {
      // The notify path journals `[MESSAGE_CONSUMED…, EXECUTION_RESUMED]` as ONE atomic write: a
      // sequential fallback can leave a consumption journaled with its resume missing and a
      // duplicate-only advance half applied. Refused at composition rather than degraded (ADR 0110).
      throw new Error(
        "kernel.features.inbox needs an EventStore with an atomic `appendBatch` (every first-party durable store has one): the inbox's consume-and-resume must land all-or-nothing. Wrap or replace the configured store, or leave the inbox off (ADR 0110)."
      );
    }
    this.inboxSource = deps.inbox ?? createInboxSource(deps.eventStore);
    assertPositiveInt("inboxMaxBacklog", deps.inboxMaxBacklog);
    assertPositiveInt("inboxMaxRetained", deps.inboxMaxRetained);
    assertPositiveInt("inboxMaxPayloadBytes", deps.inboxMaxPayloadBytes);
    assertTtlConfig(deps.inboxMessageTtlMs);
    assertPositiveInt("inboxMaxTopics", deps.inboxMaxTopics);
    assertQuarantineMax(deps.inboxQuarantineMax);
    this.inboxQuarantineMax = deps.inboxQuarantineMax ?? DEFAULT_QUARANTINE_MAX;
    this.inboxAutoRelease = deps.inboxAutoRelease !== false;
    this.inboxTopicStreamsFlag = deps.inboxTopicStreams === true && this.inboxEnabled;
    this.inboxMaxTopics = deps.inboxMaxTopics ?? DEFAULT_INBOX_MAX_TOPICS;
    this.inboxTtl = deps.inboxMessageTtlMs;
    assertMeterCeilings(deps.meterCeilings);
    this.meterCeilings = deps.meterCeilings === undefined ? undefined : { ...deps.meterCeilings };
    this.inboxMaxBacklog = deps.inboxMaxBacklog ?? DEFAULT_INBOX_MAX_BACKLOG;
    this.inboxMaxRetained = Math.max(
      this.inboxMaxBacklog,
      deps.inboxMaxRetained ?? this.inboxMaxBacklog * 4
    );
    this.inboxMaxPayloadBytes = deps.inboxMaxPayloadBytes ?? DEFAULT_INBOX_MAX_PAYLOAD_BYTES;
    this.errorClasses = deps.errorClasses;
    this.surface = deps.surface;
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
    this.driverLeases = deps.heartbeat !== undefined ? new DriverLeases(deps.heartbeat) : undefined;
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
   * ADR 0130 D11 (S7d): the option a resume passes after {@link claimRecovery} won, naming the marker
   * as already durable. The token is per runtime: a caller cannot forge it.
   *
   * @internal Used by `redriveAbandoned`; not part of the public runtime API.
   */
  recoveryClaimOptions(): { recoveryClaimed: RecoveryClaimGrant } {
    return { recoveryClaimed: this.recoveryClaimToken };
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
    op: ExecutionOp,
    executionId: string,
    principal: PrincipalChain | undefined,
    system: SystemGrant | undefined,
    known?: { first: EventEnvelope | undefined }
  ): Promise<AuthzOwners> {
    if (this.executionAuthorizer === undefined || !this.authzApplies(principal, system)) {
      return {};
    }
    try {
      // ADR 0130 residuals D7 - a principal this node cannot open is refused BEFORE the policy is
      // consulted (the policy would see `owner === undefined` and a lenient `unknownOwner` would
      // admit a stranger). The seal guard already refuses a MARKED stream at this read; the
      // backstop below catches an UNMARKED legacy stream whose principal record is itself a
      // ciphertext envelope (an O(1) shape check on the small record, never a payload walk).
      let knownFirst = known;
      if (knownFirst === undefined && !this.startRecords.has(executionId)) {
        knownFirst = { first: (await readRangeOf(this.eventStore, executionId, 0, 0))[0] };
      }
      if (knownFirst !== undefined && principalLooksSealed(knownFirst.first)) {
        throw new SealedStreamUnreadableError("query", executionId, {
          reason: "marker-unopenable",
          sequence: 0,
          covers: [],
          ...(knownFirst.first !== undefined && { workflowId: knownFirst.first.workflowId }),
        });
      }
      const recorded = await this.recordedPrincipal(executionId, knownFirst);
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
    } catch (err) {
      // A stream this node cannot open is NOT an "unknown owner" for the policy to judge.
      if (err instanceof SealedStreamUnreadableError) throw err;
      // Only a PROVEN erasure is an unknown owner (the policy's `unknownOwner` rule decides).
      if (isErasure(err)) return {};
      // ANY OTHER fault (the store, the principal resolver / codec, a lineage hop) is no evidence
      // about the execution: it is the sanitized, retryable error `readAnchor` raises, identical for
      // the owner and a stranger, never an "unknown owner" (which would falsely DENY the real owner
      // and could ADMIT a stranger under `unknownOwner: "allow"`). Nothing is allowed on a fault.
      this.onStorageError?.(executionId, err);
      throw new ExecutionStoreUnavailableError(op, executionId);
    }
  }

  /**
   * {@link ownerForAuthz} for an op that has no anchor in hand (a live `cancel`, `restoreFromState`):
   * sequence 0 is read through {@link readAnchor}, so a storage fault is the sanitized retryable
   * {@link ExecutionStoreUnavailableError} instead of `ownerForAuthz`'s catch-all "unknown owner"
   * (which would deny the legitimate owner). A live start's own record (not yet journalled) is used
   * as before, with no read.
   */
  private async ownerAtAnchor(
    op: ExecutionOp,
    executionId: string,
    principal: PrincipalChain | undefined,
    system: SystemGrant | undefined
  ): Promise<AuthzOwners> {
    if (!this.authzApplies(principal, system) || this.startRecords.has(executionId)) {
      return this.ownerForAuthz(op, executionId, principal, system);
    }
    const anchor = await this.readAnchor(op, executionId);
    return anchor.unreadable
      ? this.ownerForAuthz(op, executionId, principal, system)
      : this.ownerForAuthz(op, executionId, principal, system, { first: anchor.first });
  }

  /**
   * ADR 0130 residuals D7 - run a public op and turn a stream-level seal refusal into the
   * DENIAL-SHAPED error of THAT op: `onExecutionDenied` fires with the generic reason, the operator
   * channel gets the real cause (first then every 16th), and NOTHING is appended (no
   * `EXECUTION_DENIED` fact: an incapable node must not write into a log it cannot read, and an
   * unfenced append would let any stranger burn the owner's sequence numbers).
   */
  private async sealedOp<T>(
    op: ExecutionOp,
    executionId: string,
    principal: PrincipalChain | undefined,
    system: SystemGrant | undefined,
    body: () => Promise<T>,
    /**
     * Translate and report, but fire no `onExecutionDenied`: a kernel-internal caller (no principal
     * to deny) and a plain `query` (`loadState` never audits its ordinary denial either), so the
     * sealed refusal is observably the same as the ordinary one.
     */
    internal = false
  ): Promise<T> {
    try {
      return await body();
    } catch (err) {
      if (!(err instanceof SealedStreamUnreadableError) || this.sealedRefused.has(err)) throw err;
      const reason = this.sealedWording(op, executionId, principal, system, sealedDetailOf(err));
      const refusal = withSealedDetail(op, executionId, err, reason);
      this.sealedRefused.add(refusal);
      this.reportSealed(executionId, refusal);
      // A kernel-internal caller (the system grant) is not a caller being denied.
      if (!internal && (system === undefined || system !== this.systemGrantToken)) {
        this.onExecutionDenied?.(
          {
            op,
            executionId,
            // the plaintext workflow id the refusal carries (`""` only if the store gave none)
            workflowId: sealedDetailOf(err)?.workflowId ?? "",
            ...(principal !== undefined && { principal }),
          },
          reason
        );
      }
      throw refusal;
    }
  }

  /**
   * The caller-visible WORDING of a sealed refusal (user ruling 2026-10-14): what the same op gets
   * for an ordinary existing execution with an UNKNOWN owner. The policy is consulted with the owner
   * UNSET (exactly that input), never with the sealed principal, and only to phrase the error: the
   * refusal is unconditional, so a verdict of "allowed" (e.g. `unknownOwner: "allow"`) falls back to
   * the generic unknown-owner wording. The workflow id is the plaintext one carried on the refusal (`""` only if the store gave none).
   */
  private sealedWording(
    op: ExecutionOp,
    executionId: string,
    principal: PrincipalChain | undefined,
    system: SystemGrant | undefined,
    detail: SealedDetail | undefined
  ): string {
    try {
      return (
        this.authzDenial(op, executionId, detail?.workflowId ?? "", principal, system, {})
          ?.reason ?? UNKNOWN_OWNER_REASON
      );
    } catch {
      return UNKNOWN_OWNER_REASON;
    }
  }

  /** Refusals already translated by {@link sealedOp} (so a nested op does not double-report). */
  private readonly sealedRefused = new WeakSet<Error>();
  /** Per-execution refusal counts for first-then-every-16th operator reporting (bounded, LRU-ish). */
  private readonly sealedReports = new Map<string, number>();

  /**
   * ADR 0130 D8 - a checkpoint is saved on every cadence tick, settle and suspend, so a standing
   * `PlaintextCheckpointError` would flood `onStorageError`. The first refusal of an execution is
   * reported, then every 16th (bounded map, oldest dropped, like the sealed reports); any other
   * storage error is reported as before.
   */
  private reportCheckpointError(executionId: string, err: unknown): void {
    if (!(err instanceof PlaintextCheckpointError)) {
      this.onStorageError?.(executionId, err);
      return;
    }
    const n = (this.checkpointRefusals.get(executionId) ?? 0) + 1;
    this.checkpointRefusals.delete(executionId);
    if (this.checkpointRefusals.size >= SEALED_REPORT_CAP) {
      const oldest = this.checkpointRefusals.keys().next().value;
      if (oldest !== undefined) this.checkpointRefusals.delete(oldest);
    }
    this.checkpointRefusals.set(executionId, n);
    if (n === 1 || n % 16 === 0) this.onStorageError?.(executionId, err);
  }
  private readonly checkpointRefusals = new Map<string, number>();

  /** Operator report of a sealed refusal: the first, then only every 16th (not every poll). */
  private reportSealed(executionId: string, err: SealedStreamUnreadableError): void {
    const n = (this.sealedReports.get(executionId) ?? 0) + 1;
    this.sealedReports.delete(executionId);
    if (this.sealedReports.size >= SEALED_REPORT_CAP) {
      const oldest = this.sealedReports.keys().next().value;
      if (oldest !== undefined) this.sealedReports.delete(oldest);
    }
    this.sealedReports.set(executionId, n);
    if (n !== 1 && n % 16 !== 0) return;
    const d = sealedDetailOf(err);
    this.onWarn(
      `execution "${executionId}": REFUSED, this node cannot open the stream (${d?.reason ?? "unknown"}${
        d?.sequence !== undefined ? ` at sequence ${d.sequence}` : ""
      }${d?.covers !== undefined && d.covers.length > 0 ? `, sealed: ${d.covers.join(", ")}` : ""}). Nothing was appended. Run a node configured to open it (same sealed paths and key store).`
    );
    this.onStorageError?.(executionId, err);
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

  /**
   * Sequence 0, read for the AUTHORIZER and nothing else (the verdict comes BEFORE any fold). It is
   * the only data an authorization decision needs: the plaintext workflow id and the recorded
   * principal. A sequence 0 this node cannot decode BECAUSE OF AN ERASURE is `unreadable`: a
   * `PayloadShreddedError` (a crypto-shredded principal under a strict store), or a
   * `KeyUnavailableError` whose redacted view records the erase intent (the ShredIncomplete window).
   * It still EXISTS: its workflow id is the envelope's plaintext column, taken from the redacted view
   * the error carries (else the error's own `workflowId`, else `""` for a third-party decorator that
   * carries neither), and its owner is unknown, so the policy decides exactly as for any
   * unknown-owner execution and the caller never sees a status-revealing error.
   *
   * ANY OTHER failure (a storage fault, a key service blip, a `KeyUnavailableError` without the
   * erasure intent) is NOT evidence about the execution: it propagates as the sanitized, retryable
   * {@link ExecutionStoreUnavailableError} (identical for the owner and a stranger, no detail; the
   * real cause goes to `onStorageError`). Judging it "unreadable" would deny the legitimate owner
   * with a false denial and report a missing id as existing. A stream-level SEAL refusal propagates
   * untouched: `sealedOp` turns it into the denial-shaped refusal of the op (ADR 0130 residuals D7).
   */
  private async readAnchor(
    op: ExecutionOp,
    executionId: string
  ): Promise<{
    first: EventEnvelope | undefined;
    unreadable: boolean;
    workflowId: string;
  }> {
    try {
      const first = (await readRangeOf(this.eventStore, executionId, 0, 0))[0];
      return { first, unreadable: false, workflowId: first?.workflowId ?? "" };
    } catch (err) {
      if (isSealedUnreadable(err)) throw err;
      const e = err as {
        name?: unknown;
        redacted?: readonly EventEnvelope[];
        workflowId?: unknown;
        subjectId?: unknown;
      } | null;
      if (!isErasure(err)) {
        this.onStorageError?.(executionId, err);
        throw new ExecutionStoreUnavailableError(op, executionId);
      }
      const view = e?.redacted;
      const workflowId =
        view?.find((x) => x.sequence === 0)?.workflowId ??
        view?.[0]?.workflowId ??
        (typeof e?.workflowId === "string" ? e.workflowId : undefined);
      return { first: undefined, unreadable: true, workflowId: workflowId ?? "" };
    }
  }

  /**
   * The authorizer's verdict on `op`, reached from {@link readAnchor} ALONE: nothing is folded, no
   * checkpoint is loaded and no payload beyond the recorded principal is read, so what the log
   * holds (shredded, sealed, a corrupt or foreign checkpoint) cannot reach a caller the authorizer
   * refuses. `undefined` when the authorizer is not consulted for this call. `missing` = no
   * sequence 0 exists (the caller does its own not-found handling).
   */
  private async authzVerdictAtAnchor(
    op: ExecutionOp,
    executionId: string,
    principal: PrincipalChain | undefined,
    system: SystemGrant | undefined
  ): Promise<
    | {
        first: EventEnvelope | undefined;
        unreadable: boolean;
        missing: boolean;
        workflowId: string;
        denial: { reason?: string } | undefined;
      }
    | undefined
  > {
    if (!this.authzApplies(principal, system)) return undefined;
    const anchor = await this.readAnchor(op, executionId);
    const missing = anchor.first === undefined && !anchor.unreadable;
    if (missing) return { ...anchor, missing, denial: undefined };
    const owners = anchor.unreadable
      ? await this.ownerForAuthz(op, executionId, principal, system)
      : await this.ownerForAuthz(op, executionId, principal, system, { first: anchor.first });
    const denial = this.authzDenial(op, executionId, anchor.workflowId, principal, system, owners);
    return { ...anchor, missing, denial };
  }

  /**
   * {@link authzVerdictAtAnchor} for an op that audits its denial (`onExecutionDenied`, plus the
   * durable `EXECUTION_DENIED` after `tip()` when given): throws the denial, else returns sequence 0
   * for the caller's own use (`undefined` = no such execution). An authorized caller whose anchor
   * was unreadable re-reads it, so it gets the very error it got before the authorizer moved first.
   */
  private async authorizeAtAnchor(
    op: ExecutionOp,
    executionId: string,
    principal: PrincipalChain | undefined,
    system: SystemGrant | undefined,
    tip?: () => Promise<number | undefined>
  ): Promise<EventEnvelope | undefined> {
    const v = await this.authzVerdictAtAnchor(op, executionId, principal, system);
    if (v === undefined) return (await readRangeOf(this.eventStore, executionId, 0, 0))[0];
    if (v.denial !== undefined) {
      await this.denyOp(
        op,
        executionId,
        v.workflowId,
        principal,
        v.denial.reason,
        tip === undefined ? undefined : await tip()
      );
    }
    if (v.unreadable) return (await readRangeOf(this.eventStore, executionId, 0, 0))[0];
    return v.first;
  }

  /**
   * Where a write op's best-effort `EXECUTION_DENIED` goes: the folded tip, found only AFTER the
   * verdict. A fold that cannot be read (shredded, sealed, a bad checkpoint) skips the audit fact
   * rather than surface its error to the denied caller.
   */
  private async denialTipOf(executionId: string, forCancel = false): Promise<number | undefined> {
    try {
      const state = forCancel
        ? await this.foldStateForCancel(executionId)
        : await this.foldState(executionId);
      return state?.sequence;
    } catch {
      return undefined;
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
    const legacy = legacyFlowContentHash(definition);
    versions.set(definition.version, { flow: registered, hash, legacy });
    this.flowVersions.set(definition.id, versions);
    // The most recently registered version is the CURRENT one (used by start()
    // and as the resume default) — register the live version last, or rely on
    // pinned resumption to serve older in-flight executions.
    this.flows.set(definition.id, registered);
    this.flowHashes.set(definition.id, hash);
    this.flowLegacyHashes.set(definition.id, legacy);
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
   * Whether `start()` parses the input against a flow's declared `inputSchema` (the
   * `validateInput` option). Read-only and boolean, like {@link hasResumeAuthenticator}: lets a
   * tool say whether a schema it can see is ENFORCED or only declared.
   */
  validatesInput(): boolean {
    return this.validateInput;
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
    system?: SystemGrant,
    /** ADR 0110 — the kernel's own inbox delivery may address an inbox wait; no caller may. */
    allowInbox = false
  ): { wait?: SuspendWait } {
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
      return {};
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

    if (checks === "kernel-namespace-only") return {};

    if (state.status !== "suspended") {
      throw new ResumeRefusedError(
        executionId,
        eventType,
        "not-suspended",
        `the execution is "${state.status}", not parked at a gate. Nothing was appended.`
      );
    }

    const condition = state.suspendedOn;
    // ADR 0110 D4 — a park that lists registered waits (`ctx.select` / `ctx.receive`). The fold keeps
    // `waits` only from a kernel-stamped park, so this table is the kernel's own.
    const waits = Array.isArray(condition?.waits) ? (condition.waits as SuspendWait[]) : undefined;
    if (event.waitId !== undefined || (waits !== undefined && waits.length > 0)) {
      const addressed = this.assertWaitResumable(
        executionId,
        state,
        event,
        waits ?? [],
        system,
        allowInbox
      );
      if (addressed !== undefined) return addressed;
      // `undefined`: the event answers the park's POSITIONAL (ctx.suspend / ctx.sleep) gate, which a
      // mixed flow keeps beside its registered waits — the legacy checks below apply.
    }
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
    return {};
  }

  /**
   * ADR 0110 D4 — `assertResumable` for a park that lists registered waits. Returns the wait the
   * resume answers. `waitId` names it; without one the event name must match exactly one gate wait
   * (a derived single-gate park, or one unambiguous arm), else `ambiguous-wait`. A wait that is not
   * in the park — a losing arm of a settled `select`, a stale `waitId` — is `wait-settled`.
   */
  private assertWaitResumable(
    executionId: string,
    state: ExecutionState,
    event: ResumeEvent,
    waits: readonly SuspendWait[],
    system: SystemGrant | undefined,
    allowInbox: boolean
  ): { wait?: SuspendWait } | undefined {
    const { eventType } = event;
    const condition = state.suspendedOn;
    const answered = state.variables._waitAnswers as Record<string, unknown> | undefined;
    const isAnswered = (w: SuspendWait): boolean =>
      answered !== undefined && Object.hasOwn(answered, w.waitId);
    const refuse = (reason: ResumeRefusedError["reason"], detail: string): never => {
      throw new ResumeRefusedError(
        executionId,
        eventType,
        reason,
        `${detail} Nothing was appended.`
      );
    };
    const timerWake = (w: SuspendWait): void => {
      if (eventType !== TIMER_FIRED) {
        refuse(
          "gate-mismatch",
          `wait "${w.waitId}" is a timer arm; only the kernel's ${TIMER_FIRED} answers it.`
        );
      }
      if (this.systemGrantToken !== undefined && system !== this.systemGrantToken) {
        refuse(
          "timer-wake-not-system",
          `"${TIMER_FIRED}" is raised by the kernel's TimerService, not by a caller; this runtime fails closed, so a resume that does not carry the system grant is refused.`
        );
      }
    };
    let wait: SuspendWait | undefined;
    if (event.waitId !== undefined) {
      wait = waits.find((w) => w.waitId === event.waitId);
      if (wait === undefined || (isAnswered(wait) && !allowInbox)) {
        // Existence-hiding: a caller that names a wait the park does not list learns only this.
        refuse(
          "wait-settled",
          `the park does not list an unanswered wait "${event.waitId}" (its select was settled by another arm, or it is not a wait of this park).`
        );
      }
    } else if (eventType === TIMER_FIRED) {
      const timers = waits.filter((w) => w.kind === "timer" && !isAnswered(w));
      // A mixed park's positional ctx.sleep: the legacy timed-suspend path.
      if (timers.length === 0 && condition?.wakeAt !== undefined) return undefined;
      if (timers.length === 0) {
        refuse("gate-mismatch", "the park has no timer arm to wake.");
      }
      if (timers.length > 1) {
        refuse(
          "ambiguous-wait",
          `the park lists ${timers.length} timer arms; name one with waitId.`
        );
      }
      wait = timers[0];
    } else {
      if (eventType === WAITS_PARK_ON) {
        refuse("gate-mismatch", `"${WAITS_PARK_ON}" is reserved.`);
      }
      const matches = waits.filter(
        (w) => w.kind === "gate" && w.on === eventType && !isAnswered(w)
      );
      const legacyMatch = condition?.on === eventType;
      if (matches.length === 0) {
        if (legacyMatch) return undefined; // a positional ctx.suspend gate of a mixed park
        refuse(
          "gate-mismatch",
          `the execution is parked on ${waits.length} wait(s) (${waits
            .map((w) => `${w.kind}:${w.on ?? w.topic ?? w.waitId}`)
            .join(", ")}); none is the gate "${eventType}".`
        );
      }
      if (matches.length > 1 || (legacyMatch && waits.length > 1)) {
        refuse(
          "ambiguous-wait",
          `${matches.length} gate waits answer "${eventType}"; name one with waitId.`
        );
      }
      wait = matches[0];
    }
    const w = wait as SuspendWait;
    if (w.kind === "inbox") {
      if (!allowInbox) {
        refuse(
          "inbox-wait",
          `wait "${w.waitId}" is an inbox wait on "${w.topic}": it is answered by runtime.send, never by a resume.`
        );
      }
      return { wait: w };
    }
    if (w.kind === "timer") {
      timerWake(w);
      return { wait: w };
    }
    // A gate arm: the name must match, and ADR 0117's digest binds PER WAIT.
    if (w.on !== eventType) {
      refuse("gate-mismatch", `wait "${w.waitId}" is the gate "${w.on}", not "${eventType}".`);
    }
    if (w.viewDigest !== undefined) {
      const echoed = (event.payload as { viewDigest?: unknown } | null | undefined)?.viewDigest;
      if (echoed !== w.viewDigest) {
        refuse(
          "view-digest-mismatch",
          `the gate "${eventType}" was parked on a specific proposal and the resume does not carry its digest (${
            typeof echoed === "string" ? "a stale view" : "none supplied"
          }). Re-read the parked state and resume with payload.viewDigest set to that wait's viewDigest.`
        );
      }
    }
    return { wait: w };
  }

  /** What a wait-addressed resume RECORDS as the wait's answer (ADR 0110 D3). */
  private waitAnswerPayload(
    executionId: string,
    definition: FlowDefinition<unknown, unknown>,
    event: ResumeEvent,
    wait: SuspendWait
  ): unknown {
    if (wait.kind === "timer") return { wakeAt: wait.wakeAt }; // the kernel's fact, never the caller's
    if (wait.kind === "inbox") return null; // the answer is the MESSAGE_CONSUMED journaled beside it
    return this.parseResumePayload(executionId, definition, event);
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
    },
    /** The quarantine verb walking back for the park: reads through the opaque view (user ruling 2026-10-14). */
    logFoldFor?: QuarantineVerb
  ): Promise<number | undefined> {
    if (state.status !== "suspended") return undefined;
    const inHand = lastSuspendSequence(held.events);
    if (inHand !== undefined) return inHand;
    if (held.complete) return undefined;
    const CHUNK = 64;
    let hi = held.searchFrom ?? state.sequence;
    while (hi >= 0) {
      const lo = Math.max(0, hi - CHUNK + 1);
      const got = await readRangeOf(this.quarantineReadsFor(logFoldFor), executionId, lo, hi);
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
    return this.sealedOp(
      "query",
      executionId,
      options?.principal,
      options?.system,
      async () => {
        const state = await this.loadState(executionId, options);
        if (state === null || state.status !== "suspended") return undefined;
        return this.locatePark(executionId, state, { events: undefined, complete: false });
      },
      true
    );
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
      /** ADR 0110 D4 — a wait-addressed resume: the wait and the park that lists it. */
      waitId?: string;
      waitRegisteredAtSequence?: number | undefined;
    }
  ): { eventType: string; payload: unknown } | undefined {
    if (this.resumeAuthenticator === undefined) return undefined;
    const verdict = this.resumeAuthenticator.verify(resumeEvent, {
      executionId,
      parkedAtSequence: park.parkedAtSequence,
      principal: park.principal,
      ...(park.waitId !== undefined && {
        waitId: park.waitId,
        ...(park.waitRegisteredAtSequence !== undefined && {
          waitRegisteredAtSequence: park.waitRegisteredAtSequence,
        }),
      }),
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
    const legacyRecording = recorded.startsWith("fnv1a:"); // ADR 0113 D1
    const matches = (hash: string, legacy: string): boolean =>
      recorded === (legacyRecording ? legacy : hash);
    const currentHash = this.flowHashes.get(targetId);
    const currentLegacy = this.flowLegacyHashes.get(targetId);
    if (
      currentHash !== undefined &&
      currentLegacy !== undefined &&
      matches(currentHash, currentLegacy)
    ) {
      return this.assertCodeCompatible(executionId, targetId, state, current);
    }
    const versions = this.flowVersions.get(targetId);
    if (versions !== undefined) {
      for (const v of versions.values()) {
        if (matches(v.hash, v.legacy)) {
          return this.assertCodeCompatible(executionId, targetId, state, v.flow);
        }
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
   * ADR 0113 D2 — the body fingerprint, compared beside the structural hash. Both sides must carry
   * one (absent = "no fingerprint", today's behaviour); a recorded value the registered flow lists
   * in `compatibleWith` is the author's explicit assertion that the edit is replay-compatible.
   * `EXECUTION_MIGRATED` re-arms the comparison: it records the target flow's fingerprint
   * (`toCodeHash`, "" when it has none), so a migrated execution is held to the code it now runs.
   */
  private assertCodeCompatible(
    executionId: string,
    workflowId: string,
    state: ExecutionState,
    flow: RegisteredFlow
  ): RegisteredFlow {
    const recorded = state.variables._codeHash;
    const registered = flow.definition.codeFingerprint;
    if (
      typeof recorded !== "string" ||
      recorded === "" || // a migration onto code with no fingerprint clears it
      typeof registered !== "string" ||
      recorded === registered
    ) {
      return flow;
    }
    if (flow.definition.compatibleWith?.includes(recorded) === true) return flow;
    throw new FlowCodeMismatchError(executionId, workflowId, recorded, registered, "code");
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
    // Gated as the op it enables: a stream this node cannot open is refused denial-shaped as THAT op.
    return this.sealedOp(
      options?.gateAs ?? "cancel",
      executionId,
      options?.principal,
      options?.system,
      () => this.acquireFenceCore(executionId, options)
    );
  }

  private async acquireFenceCore(
    executionId: string,
    options?: { principal?: PrincipalChain; system?: SystemGrant; gateAs?: "resume" }
  ): Promise<number | undefined> {
    // R3 — a fence SUPERSEDES the current holder (a kill-class effect), and one acquired for an
    // id nobody has written poisons a later start of it, so it is gated like the ops it
    // enables: `cancel` on an execution that exists, `start` on one that does not.
    if (this.authzApplies(options?.principal, options?.system)) {
      // Sequence 0 only (see `readAnchor`): an unreadable one still EXISTS, so it is judged as the
      // op it enables with an unknown owner, never as a free id and never with a status-revealing error.
      const anchor = await this.readAnchor(options?.gateAs ?? "cancel", executionId);
      const workflowId = anchor.workflowId || undefined;
      const exists = anchor.unreadable || workflowId !== undefined;
      // `gateAs: "resume"` — a dispatcher fencing an EXISTING execution to RESUME it (not to kill
      // it) is judged as the resume it enables, so a `cancel: "deny"` policy does not refuse a
      // legitimate dispatched resume (and the audit names the op that was attempted).
      const op: ExecutionOp = !exists ? "start" : (options?.gateAs ?? "cancel");
      const denial = this.authzDenial(
        op,
        executionId,
        workflowId ?? "",
        options?.principal,
        options?.system,
        !exists
          ? undefined
          : anchor.unreadable
            ? await this.ownerForAuthz(op, executionId, options?.principal, options?.system)
            : await this.ownerForAuthz(op, executionId, options?.principal, options?.system, {
                first: anchor.first,
              })
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
      // An AUTHORIZED caller (no denial above) whose anchor was unreadable gets the very error it
      // got before the authorizer moved first: re-read, so a fence is never taken on an erased
      // execution just because `unknownOwner: "allow"` let the verdict through.
      if (anchor.unreadable) await readRangeOf(this.eventStore, executionId, 0, 0);
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
    held: { vm: ReplayVM; events: readonly EventEnvelope[] | undefined },
    allowInbox = false,
    /** An operator discard answers no wait: only "still parked" is checked, not "resumable by this event". */
    parkedOnly = false
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
        if (parkedOnly) {
          if (vm.getState().status !== "suspended") {
            throw notSuspended("the execution is no longer parked. Nothing was appended.");
          }
        } else {
          this.assertResumable(executionId, vm.getState(), resumeEvent, "all", system, allowInbox);
        }
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
    return this.sealedOp("cancel", executionId, options?.principal, options?.system, () =>
      this.cancelCore(executionId, reason, options)
    );
  }

  /** `cancel` without the sealed-stream translation (see `sealedOp`). */
  private async cancelCore(
    executionId: string,
    reason?: unknown,
    options?: { principal?: PrincipalChain; system?: SystemGrant }
  ): Promise<boolean> {
    assertNotReserved(executionId);
    const live = this.liveHandles.get(executionId);
    // ADR 0109 D4 — a cancel addressed to any generation reaches the chain's newest one (routed),
    // and is authorized AGAIN against that generation's recorded owner before it acts.
    const recheck = async (id: string): Promise<void> => {
      if (!this.authzApplies(options?.principal, options?.system)) return;
      const f = (await readRangeOf(this.eventStore, id, 0, 0))[0];
      if (f === undefined) return;
      const denial = this.authzDenial(
        "cancel",
        id,
        f.workflowId,
        options?.principal,
        options?.system,
        await this.ownerForAuthz("cancel", id, options?.principal, options?.system, { first: f })
      );
      if (denial !== undefined) {
        await this.denyOp("cancel", id, f.workflowId, options?.principal, denial.reason, undefined);
      }
    };

    // C.1 — gate the cancel (only when configured AND a principal is present). Use the
    // live handle's state when running here, else fold; a denial is best-effort
    // recorded WITHOUT a fence (never disrupts the still-running execution).
    // The verdict is reached from sequence 0 alone, BEFORE the fold (which can raise
    // status-revealing errors: a shredded or unreadable execution); the folded tip is found only to
    // place the best-effort EXECUTION_DENIED audit fact, and an unreadable fold skips that fact.
    if (live !== undefined) {
      if (this.authzApplies(options?.principal, options?.system)) {
        const gate = live.getState();
        const cancelDenial = this.authzDenial(
          "cancel",
          executionId,
          gate.workflowId,
          options?.principal,
          options?.system,
          await this.ownerAtAnchor("cancel", executionId, options?.principal, options?.system)
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
    } else if (this.authzApplies(options?.principal, options?.system)) {
      const verdict = await this.authzVerdictAtAnchor(
        "cancel",
        executionId,
        options?.principal,
        options?.system
      );
      if (verdict?.missing === true) {
        await this.denyMissing("cancel", executionId, options?.principal, options?.system);
        throw new Error(`No execution found for id: ${executionId}`);
      }
      if (verdict?.denial !== undefined) {
        await this.denyOp(
          "cancel",
          executionId,
          verdict.workflowId,
          options?.principal,
          verdict.denial.reason,
          await this.denialTipOf(executionId, true)
        );
      }
    }

    if (live !== undefined) {
      live.cancel(reason);
      // ADR 0109 D2 (i) — a successor may have started in the start-to-commit window.
      if (this.continueAsNewEnabled) await this.cancelSuccessorsOf(executionId, reason, recheck);
      return true;
    }
    const state = await this.foldStateForCancel(executionId);
    if (state === null) {
      throw new Error(`No execution found for id: ${executionId}`);
    }
    if (state.status === "continued") {
      // ADR 0109 D2 — a continued member's cancel is the CHAIN's: it reaches the live generation
      // (authorized above against the chain owner, which every generation inherits).
      return this.cancelForward(executionId, reason, recheck);
    }
    if (state.status === "cancelled") {
      // A cancel that raced the start-to-commit window: the successor, if one started, goes too.
      return this.continueAsNewEnabled
        ? this.cancelSuccessorsOf(executionId, reason, recheck)
        : false;
    }
    if (state.status === "completed" || state.status === "failed") {
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
    await this.retireInbox(chainIdOf(state, executionId));
    if (this.continueAsNewEnabled) await this.cancelSuccessorsOf(executionId, reason, recheck);
    return true;
  }

  /**
   * The fold `cancel` acts on. A subject erased by key destruction leaves an owner whose sealed
   * fields (a principal identity, a sealed step output) cannot be opened, so the authoritative
   * {@link foldState} throws `PayloadShreddedError`: a PARKED owner shredded in place would then
   * be neither resumable nor cancellable and would sit suspended forever. A cancel needs no sealed
   * field (status, tip and workflow id are plaintext), so it folds the REDACTED view the error
   * carries (each sealed field replaced by `{ $shredded: true }`) and appends the terminal event
   * under the fence like any cancel. Used by `cancel` ONLY: `resume`, `loadState` and every other
   * fold stay strict (a resume off a redacted fold would diverge). A COMPACTED log (its prefix is
   * gone and its checkpoint is sealed too) cannot be reconstructed this way and keeps the error.
   */
  private async foldStateForCancel(executionId: string): Promise<ExecutionState | null> {
    try {
      return await this.foldState(executionId);
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name !== "PayloadShreddedError") throw err;
      // Always re-read the whole log: the error that reached us may come from a partial read (the
      // anchor of a snapshot-seeded fold), whose redacted view is only that slice.
      let redacted: readonly EventEnvelope[] | undefined;
      try {
        redacted = await this.eventStore.read(executionId);
      } catch (err2) {
        redacted = (err2 as { redacted?: readonly EventEnvelope[] } | null)?.redacted;
      }
      if (redacted === undefined || redacted.length === 0 || redacted[0]!.sequence !== 0) throw err;
      const workflowId = redacted[0]!.workflowId;
      return new ReplayVM([...redacted], {
        executionId,
        workflowId,
        workflowVersion: this.flows.get(workflowId)?.definition.version ?? "",
      }).getState();
    }
  }

  /**
   * ADR 0109 D2 (i) — cancel the successor of `executionId` if one STARTED (probe
   * `<chainId>~<generation+1>`, accepted only when it continued from `executionId`), and every
   * generation after it. `true` only when something was cancelled.
   */
  private async cancelSuccessorsOf(
    executionId: string,
    reason: unknown,
    recheck?: (id: string) => Promise<void>
  ): Promise<boolean> {
    try {
      const state =
        this.liveHandles.get(executionId)?.getState() ?? (await this.foldState(executionId));
      if (state === null) return false;
      const next = await this.probeSuccessor(executionId, chainOfState(state, executionId));
      if (next === undefined) return false;
      return await this.cancelForward(next, reason, recheck);
    } catch (err) {
      if (err instanceof ExecutionDeniedError) throw err; // the head's owner refused: say so
      this.onStorageError?.(executionId, err);
      return false;
    }
  }

  async restoreFromState(
    preloadedState: ExecutionState,
    resumeEvent?: ResumeEvent,
    options?: RunOptions
  ): Promise<ExecutionHandle> {
    return this.sealedOp(
      "resume",
      preloadedState.executionId,
      options?.principal,
      options?.system,
      () => this.restoreFromStateCore(preloadedState, resumeEvent, options)
    );
  }

  private async restoreFromStateCore(
    preloadedState: ExecutionState,
    resumeEvent?: ResumeEvent,
    options?: RunOptions
  ): Promise<ExecutionHandle> {
    // ADR 0107 — the same ids `start` refuses: a blank identity (the journal refuses it too)
    // and the control streams.
    assertNotReserved(preloadedState.executionId);
    assertNotTransientFold(preloadedState, "restoreFromState");
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
      await this.ownerAtAnchor(
        "resume",
        preloadedState.executionId,
        options?.principal,
        options?.system
      )
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
    // ADR 0109 — the reserved IDENTITY keys of a caller-supplied state are never trusted: the
    // principal, lineage and chain identity (and `_continuedTo`) are overwritten with what the
    // execution's own sequence 0 / the durable log say (dropped when the log says nothing), so a
    // doctored state cannot forge who owns a successor, which chain it joins, or where it points.
    const restoredFirst = (await readRangeOf(this.eventStore, preloadedState.executionId, 0, 0))[0];
    // ADR 0109 D2 (a) — restoring a state onto an id with NO log would CREATE that log: it may not
    // be a reserved successor id (a squat at `victim~1`, `victim~5` or `victim::g#0~1` would fail
    // or mis-route the victim's rotation). Refused for every caller, after the authorization above
    // and without reading any parent (no existence oracle).
    if (restoredFirst === undefined && successorShapeOf(preloadedState.executionId) !== "none") {
      throw new ReservedSuccessorIdError(preloadedState.executionId);
    }
    if (restoredFirst === undefined) this.assertNotInboxStreamShaped(preloadedState.executionId);
    // ADR 0130 D11 (S7c) - restoring a state IS driving the execution on: lease before anything is
    // appended. A stand-down (another live owner) appends nothing.
    const lease = await this.takeDriverLease(preloadedState.executionId);
    try {
      // The durable fold as it exists BEFORE this restore (snapshot + tail of the existing log): it
      // predates the caller's state, so it is what the log says about the running totals, the inbox
      // cursors and the start time (which feeds the chain deadline).
      const restoredDurable =
        restoredFirst === undefined ? null : await this.foldState(preloadedState.executionId);
      const vm = new ReplayVM(
        [],
        this.withLogIdentity(normalizeSnapshotState(preloadedState), restoredFirst, restoredDurable)
      );
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
        await this.actingPrincipal(preloadedState.executionId, options?.principal, {
          first: restoredFirst,
        }),
        false,
        lease
      );
    } catch (err) {
      await lease.release();
      throw err;
    }
  }

  /**
   * `state` with its reserved identity keys (`_principal`, `_chain`, `_parent`, `_continuedTo`) taken
   * from the execution's own sequence 0 (`first`) instead of from the (caller-supplied) state: the
   * fold of the log's first event IS the identity the log records, by the fold's own rules.
   */
  private withLogIdentity(
    state: ExecutionState,
    first: EventEnvelope | undefined,
    durable: ExecutionState | null
  ): ExecutionState {
    const logged = new ReplayVM(first !== undefined ? [first] : [], {
      executionId: state.executionId,
      workflowId: state.workflowId,
      workflowVersion: state.workflowVersion,
    }).getState().variables;
    const variables: Record<string, unknown> = { ...state.variables };
    for (const key of ["_principal", "_chain", "_parent", "_continuedTo"] as const) {
      delete variables[key];
      if (key !== "_continuedTo" && logged[key] !== undefined) variables[key] = logged[key];
    }
    // The running totals, the inbox cursors / dedupe window and the start time are the LOG's too:
    // a snapshot saved from this run would otherwise persist the caller's values, and a rotation's
    // carry (and chain deadline) reads the durable fold. No log: fresh defaults.
    for (const key of ["_resources", "_inbox"] as const) {
      delete variables[key];
      if (durable?.variables[key] !== undefined) variables[key] = durable.variables[key];
    }
    return { ...state, startedAt: durable?.startedAt ?? 0, variables };
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
    // A minted ulid cannot name an existing (sealed) stream; a caller-chosen id can.
    if (options?.executionId === undefined) return this.startCore(flow, input, options);
    return this.sealedOp("start", options.executionId, options.principal, options.system, () =>
      this.startCore(flow, input, options)
    );
  }

  private async startCore<TIn = unknown, TOut = unknown>(
    flow: RegisteredFlow<TIn, TOut> | FlowDefinition<TIn, TOut> | string,
    input: TIn,
    options?: RunOptions
  ): Promise<ExecutionHandle> {
    // Validate the per-call budget BEFORE anything is appended: a caller-chosen id is
    // bootstrapped durably below (ADR 0103), so a late rejection would burn the id and leave
    // an abandoned EXECUTION_STARTED behind.
    assertValidBudget("deadlineMs", options?.deadlineMs, "start options");
    const executionId = options?.executionId ?? ulid();
    // ADR 0109 D2 (a) — a caller-chosen id may not have the reserved successor shape (a minted ulid
    // cannot), unless it is a `::`-derived child of an existing log (a supervised child of a
    // continued generation).
    if (options?.executionId !== undefined) {
      await this.assertCreatable(executionId, this.lineageTrusted(options));
    } else assertNotReserved(executionId);
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
    const flowHash = this.recordedHashOf(definition.id);
    const bootstrap: BootstrapEvent = {
      eventType: "EXECUTION_STARTED",
      payload: {
        input: effectiveInput,
        ...(flowHash !== undefined && { flowHash }),
        // ADR 0113 D2 — the body fingerprint the toolchain supplied, when it supplied one.
        ...(definition.codeFingerprint !== undefined && { codeHash: definition.codeFingerprint }),
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

    // ADR 0130 D11 (S7c) - the heartbeat lease is taken BEFORE the first append (the caller-chosen
    // id's durable sequence 0 included): a stream that exists was created by a driver that held one.
    // Another live owner = stand down (a caller-chosen id reads as "already started elsewhere").
    let lease: DriverLease = NO_LEASE;
    if (this.driverLeases !== undefined) {
      // S7g (user ruling 2026-10-15): lazy applies ONLY to a fresh start, and EVERY `start` is one.
      // A minted id cannot have a stream or a row; a caller-chosen id that already has a stream is
      // refused by `writeBootstrap` below (sequence 0's uniqueness, ADR 0103) before the body, any
      // effect or any lease-store call, so a start never DRIVES an existing stream. No extra durable
      // read classifies the id. (resume-like entries are eager and never come through here.)
      const got = await this.driverLeases.acquireFresh(executionId);
      if (got === null) {
        const held = new LeaseHeldError(executionId);
        if (options?.executionId === undefined) throw held;
        // A caller-chosen id: the lease holder may be a GHOST (leased, died before its sequence 0).
        // Sequence 0 present = a real stream, "already started elsewhere"; absent = nothing is there
        // to have been won, so the start is RETRYABLE (the ghost lease expires on its own).
        if (await this.hasSequenceZero(executionId))
          throw new ExecutionAlreadyExistsError(executionId, held);
        throw new StartLeaseHeldError(executionId);
      }
      lease = got;
    }
    try {
      // ADR 0103 — a CALLER-CHOSEN id can already exist (a redelivered trigger, a second node
      // firing the same schedule occurrence), so its sequence 0 is made durable BEFORE the body
      // runs: the store's uniqueness refuses a duplicate here, before any effect, fold or
      // onEvent. A minted ulid cannot collide, so the default path pays no barrier and stays
      // byte-identical (the journal writes sequence 0 behind the fold, as before).
      if (options?.executionId !== undefined) {
        // ADR 0130 D11: the bootstrap bypasses the journal (and its write gate): check the lease here.
        if (!lease.valid()) throw lease.lossError();
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
          actingAs,
          false,
          lease
        );
      } catch (err) {
        if (this.startRecords.get(executionId) === startRecord)
          this.startRecords.delete(executionId);
        throw err;
      }
    } catch (err) {
      await lease.release();
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
          // A conflict at sequence 0 whose stream this node cannot open: it EXISTS. It gets the same
          // error a plaintext existing id gets (ExecutionAlreadyExistsError), not a storage error
          // that would reveal the stream is sealed (ADR 0130 residuals D7).
          if (!isSealedUnreadable(readErr)) return refuse(readErr);
          exists = true;
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
    return this.sealedOp("resume", executionId, options?.principal, options?.system, () =>
      this.resumeCore(executionId, resumeEvent, options)
    );
  }

  /**
   * `resume`, plus the kernel's own inbox delivery (ADR 0110 D5): `inboxWake` carries the
   * `MESSAGE_CONSUMED` facts to journal ahead of the wait-addressed `EXECUTION_RESUMED`. Private:
   * a public `resume` can never reach an inbox wait or write a consumption.
   */
  private async resumeCore(
    executionId: string,
    resumeEvent: ResumeEvent,
    options?: RunOptions,
    inboxWake?: { pre: Array<{ eventType: string; payload: unknown }> }
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
    // C.1 — the verdict comes FIRST, from sequence 0 alone: the checkpoint load and the fold below
    // raise status-revealing errors (a shredded or unreadable execution) that a caller the
    // authorizer refuses must never see. The denial's audit fact goes at the folded tip, found only
    // after the verdict (an unreadable fold skips the fact).
    const gated = await this.authzVerdictAtAnchor(
      "resume",
      executionId,
      options?.principal,
      options?.system
    );
    if (gated?.denial !== undefined) {
      await this.denyOp(
        "resume",
        executionId,
        gated.workflowId,
        options?.principal,
        gated.denial.reason,
        await this.denialTipOf(executionId)
      );
    }
    // The id has no sequence 0 (the authorizer judged it missing): whatever the checkpoint load or
    // the read raises for it (an ORPHAN checkpoint) reads as not found, never as a status-revealing
    // error. A caller the authorizer is not consulted for (`gated` undefined) keeps the real error.
    const asNotFound = async <T>(read: () => Promise<T>): Promise<T> => {
      if (gated?.missing !== true) return read();
      try {
        return await read();
      } catch {
        await this.denyMissing("resume", executionId, options?.principal, options?.system);
        throw new Error(`No execution found for id: ${executionId}`);
      }
    };
    const snapshot = await asNotFound(() => this.snapshotStore.loadLatest(executionId));
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
        // The authorizer's anchor IS sequence 0 (read moments ago): no second point read.
        firstEvent = gated?.first ?? (await readRangeOf(this.eventStore, executionId, 0, 0))[0];
        if (firstEvent !== undefined) {
          scanTail = fresh;
          tailEvents = tail.filter((e) => e.sequence > snapshot.sequence);
        }
      }
      if (firstEvent === undefined) this.strayScans.delete(executionId);
    }
    if (firstEvent === undefined) {
      allEvents = await asNotFound(() => this.eventStore.read(executionId));
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

    // (The verdict was reached above, from sequence 0; this repeats it only for a start that raced
    // that read: no sequence 0 then, one now.) The denial's audit fact is recorded after the
    // FOLDED tip, not the log's last event: a log compacted at its tip is `[0]` with the
    // checkpoint above it, and a denial appended at `lastEvent + 1` landed in the checkpoint's
    // freed slot — the log then looked never-compacted and the next fold started from scratch,
    // losing the suspension (ADR 0106).
    if (gated?.missing === true) {
      const resumeDenial = this.authzDenial(
        "resume",
        executionId,
        workflowId,
        options?.principal,
        options?.system,
        await this.ownerForAuthz("resume", executionId, options?.principal, options?.system, {
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
    }

    // K8.2 — cancelled is TERMINAL: a cancel-by-id of a suspended/detached
    // execution must not be undone by a later resume.
    if (vm.getState().status === "cancelled") {
      throw new Error(`Execution ${executionId} was cancelled; resume refused (terminal status)`);
    }

    // ADR 0109 D4 — a resume addressed to a CONTINUED id resolves forward to the head of its chain
    // (at most `maxChainHops` links, then a typed refusal naming the head), so a caller holding an
    // old id is not stranded. Authorized above against this id's recorded owner, which every
    // generation inherits; the head's own resume authorizes again against the same owner.
    if (vm.getState().status === "continued") {
      const head = await this.walkToHead(executionId);
      if (head !== null && head.id !== executionId) {
        return this.resumeCore(head.id, resumeEvent, options, inboxWake);
      }
      // A continued id whose successor cannot be read: nothing to resume (assertResumable refuses).
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
    const approval =
      inboxWake !== undefined
        ? undefined // the kernel's own delivery: no approver
        : this.verifyApproval(executionId, resumeEvent, {
            parkedAtSequence: parkedAt,
            principal: options?.principal,
            parkNotLocated: parkedAt === undefined && vm.getState().status === "suspended",
            ...(resumeEvent.waitId !== undefined && {
              waitId: resumeEvent.waitId,
              // The park that LISTS the wait (conservative: a later re-park of the same wait needs
              // a fresh signature — see ADR 0110 acceptance notes).
              waitRegisteredAtSequence: parkedAt,
            }),
          });
    assertAuthorizedOverride(executionId, resumeEvent, approval);

    // #304/#305 — the ingress gate: WHICH event, to an execution in WHICH state. Placed
    // after the authenticator for the same reason the shape check is (below): the
    // gate-mismatch message names the gate the execution is parked on, which an
    // unauthenticated caller has no business learning.
    const resolvedWait = this.assertResumable(
      executionId,
      vm.getState(),
      resumeEvent,
      "all",
      options?.system,
      inboxWake !== undefined
    ).wait;

    // TR (ADR 0077) — shape AFTER identity: the authenticator must see the exact event the
    // caller signed (a Zod transform could reshape it out from under a signature), and an
    // unauthenticated caller learns nothing about the gate's contract. Both refuse before
    // `execute`, so neither appends.
    const resumePayload =
      resolvedWait !== undefined
        ? this.waitAnswerPayload(executionId, resolved.definition, resumeEvent, resolvedWait)
        : this.recordedPayload(
            resumeEvent,
            vm.getState(),
            this.parseResumePayload(executionId, resolved.definition, resumeEvent)
          );
    if (resolvedWait === undefined) {
      assertInDoubtVerdict(executionId, vm.getState(), resumePayload);
      assertNullAnswerTakes(executionId, resumeEvent.eventType, vm.getState(), resumePayload);
    }

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

    // ADR 0130 D11 (S7c) - the heartbeat lease comes BEFORE the fence and the first append (lease,
    // then fence). Another live owner = stand down: nothing appended and, above all, no fence taken
    // (a fence acquired and abandoned would supersede that live driver). The send/notify winner
    // reaches here too (`inboxWake`). Taken after every refusal that appends nothing.
    // S7g: a resume is ALWAYS eager (a predecessor's leftover row is stood down on or overwritten).
    const lease = await this.takeDriverLease(executionId);
    try {
      // ADR 0110 D1 — only a resume that PASSED every refusal re-opens a terminal owner's inbox: a
      // refused one (not-suspended, authz, replay-check, migration) must not leave a stream behind
      // for an execution that stays terminal.
      await this.reopenInbox(executionId, vm.getState());
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
          { vm, events: allEvents ?? tailEvents },
          inboxWake !== undefined
        );
        fence = got.fence;
        runVm = got.vm;
      }
      // ADR 0110 D8 — the batch was built from an earlier fold. Whatever was appended since (a
      // journaled operator discard is an ignorable kind, so the fence still holds) may have moved a
      // cursor past a message in it; the fold would accept that consumption as an answer. Judge the
      // batch against the cursors of the VM it will run from, and refold instead of writing it.
      if (inboxWake !== undefined && staleInboxBatch(runVm.getState(), inboxWake.pre)) {
        throw new StaleInboxBatch(executionId);
      }

      const bootstrap: BootstrapEvent[] = [
        ...(approval !== undefined ? [approval] : []),
        ...discardEvents,
        ...(resolvedWait !== undefined
          ? [
              ...(inboxWake !== undefined
                ? inboxWake.pre.map((e) => ({ ...e, atomic: true as const }))
                : [{ eventType: resumeEvent.eventType, payload: resumePayload }]),
              // ADR 0110 D3 — a wait-addressed resume: kernel-stamped, `{ waitId, payload }`.
              {
                eventType: "EXECUTION_RESUMED",
                payload: { waitId: resolvedWait.waitId, payload: resumePayload },
                metadata: { kernel: true },
                ...(inboxWake !== undefined && { atomic: true as const }),
              },
            ]
          : [
              // ADR 0130 D11 (S7d): a conditional takeover already made its recovery marker durable.
              ...(options?.recoveryClaimed === this.recoveryClaimToken &&
              resumeEvent.eventType === EXECUTION_RECOVERED
                ? []
                : [{ eventType: resumeEvent.eventType, payload: resumePayload }]),
              ...answerEvents(runVm.getState(), resumePayload),
            ]),
      ];
      return this.execute(
        executionId,
        workflowId,
        runVm,
        resolved.runner as FlowRunner<unknown, unknown>,
        effectiveInput,
        inboxWake === undefined && this.isReopen(runVm)
          ? await this.landReopenBootstrap(executionId, workflowId, runVm, bootstrap, fence, lease)
          : bootstrap,
        fence,
        options?.deadlineMs ?? resolved.definition.deadlineMs,
        acting,
        inboxWake !== undefined,
        lease
      );
    } catch (err) {
      await lease.release();
      throw err;
    }
  }

  /**
   * Is this resume a REOPEN of a finished execution? Synchronous on purpose: every resume of a
   * parked execution reaches `execute` in the same turn it always did (an extra `await` here
   * reorders interleavings the orchestration supervisor is sensitive to).
   */
  private isReopen(vm: ReplayVM): boolean {
    const status = vm.peekState().status;
    return status === "completed" || status === "failed";
  }

  /**
   * ADR 0116 (round 3) — the REOPEN's side of the late-outcome race. A late outcome
   * (`recordOutcome`) may take the slot a reopening `resume`/`resumeAs` was about to write,
   * because it observed the log before the reopener acquired its fence and appended just after.
   * The reopener must never be the loser: it is the execution's real writer, and a late reward is
   * status-neutral evidence that changes nothing it folded.
   *
   * So a reopen onto a COMPLETED / FAILED execution makes its bootstrap batch durable BEFORE the
   * run starts (all-or-nothing, `appendBatch`), and when the store answers with a slot conflict
   * it re-reads the tail: if every event above the head it folded is a kernel-stamped late
   * `OUTCOME_RECORDED`, it folds them and rewrites the batch at the new slots, at most
   * {@link REOPEN_ATTEMPTS} times. Anything else (a real writer, a stale fence, a store without
   * `appendBatch`, no conflict at all) returns the events UNTOUCHED for the ordinary path, which
   * fails or succeeds exactly as it always did. The batch is handed on as `durable` events
   * (`ExecutionJournal.adopt`), so `onEvent` fires once, after they are stored.
   */
  private async landReopenBootstrap(
    executionId: string,
    workflowId: string,
    vm: ReplayVM,
    events: BootstrapEvent[],
    fence: number | undefined,
    lease: DriverLease = NO_LEASE
  ): Promise<BootstrapEvent[]> {
    const store = this.eventStore;
    if (
      !this.isReopen(vm) ||
      store.appendBatch === undefined ||
      events.length === 0 ||
      events.some((e) => e.atomic === true || e.durable !== undefined)
    ) {
      return events;
    }
    for (let attempt = 0; attempt < REOPEN_ATTEMPTS; attempt++) {
      // ADR 0130 D11: this append bypasses the journal (and so its write gate): check the lease here.
      if (!lease.valid()) throw lease.lossError();
      const at = vm.peekState().sequence;
      const envelopes = events.map((e, i) =>
        ExecutionJournal.envelopeAt(
          { executionId, workflowId },
          at + 1 + i,
          e.eventType,
          e.payload,
          {
            ...(e.metadata !== undefined && { metadata: e.metadata }),
            ...(fence !== undefined && { fence }),
            now: this.now,
          }
        )
      );
      try {
        await store.appendBatch(envelopes);
        return events.map((e, i) => ({ ...e, durable: envelopes[i] as EventEnvelope }));
      } catch (err) {
        if (!isWriteConflict(err)) return events;
        const between = await store.readFrom(executionId, at + 1);
        const lateOnly =
          between.length > 0 &&
          between.every(
            (e, i) =>
              e.sequence === at + 1 + i &&
              e.eventType === "OUTCOME_RECORDED" &&
              e.metadata?.kernel === true &&
              (e.payload as { late?: unknown } | undefined)?.late === true
          );
        if (!lateOnly) return events;
        for (const e of between) vm.applyEvent(e);
      }
    }
    return events;
  }

  // ── ADR 0110 — the durable inbox: send, notify, trim ─────────────────────────────────────────

  private assertInboxEnabled(what: string): void {
    if (!this.inboxEnabled) {
      throw new Error(
        `${what} needs the durable inbox: turn on \`kernel.features.inbox\` (WorkflowRuntimeDeps.inboxEnabled) once every node folds MESSAGE_CONSUMED and multi-wait parks (ADR 0110)`
      );
    }
  }

  private warnNoTimerStore(workflowId: string, what: string): void {
    if (this.warnedNoInboxTimers) return;
    this.warnedNoInboxTimers = true;
    this.onWarn(
      `flow "${workflowId}" parked on ${what}, but no TimerStore is wired — nothing can fire it or wake it from another process. Wire \`timers: { store }\` on every runtime that can park (ADR 0110).`
    );
  }

  /**
   * What `send` needs to know about the chain head, read WITHOUT folding the owner's log: sequence 0
   * (identity, chain, workflow), the newest few events (their kinds say running / parked /
   * terminal) and — only when they could mean "parked" — the folded state. A RUNNING owner in a
   * message loop appends thousands of events and may hold no recent snapshot, so a fold per `send`
   * would be O(its log) per message; a bounded tail read is O(1). Follows a continuation
   * (`EXECUTION_CONTINUED`, kernel-stamped, names its successor) to the head, bounded.
   */
  private async sendTarget(
    executionId: string,
    opts: { first?: EventEnvelope; logFoldFor?: QuarantineVerb } = {}
  ): Promise<{
    id: string;
    first: EventEnvelope;
    workflowId: string;
    chainId: string;
    /**
     * `terminal` names the status; `parkedCandidate` carries the fold; `ambiguous` is a tail that
     * could not say (maybe parked, see {@link classifyTip}); otherwise it is running.
     */
    status: "running" | "ambiguous" | "parkedCandidate" | "hop-limit" | string;
    state?: ExecutionState;
    /**
     * `status: "hop-limit"`: names the furthest head the bounded walk can reach (ADR 0109 D4). Lazy:
     * the galloping probe costs ~O(log n) reads and is run only AFTER the caller authorized.
     */
    hopLimitOf?: () => Promise<string>;
  } | null> {
    const maxHops = this.maxChainHops; // bounds only the RESIDUAL stepping after a routed jump
    let id = executionId;
    for (let hop = 0; ; hop++) {
      const first =
        hop === 0 && opts.first !== undefined
          ? opts.first
          : (await readRangeOf(this.eventStore, id, 0, 0))[0];
      if (first === undefined) return null; // hop 0: not found; later: the successor is not durable yet
      const base = { id, first, workflowId: first.workflowId, chainId: chainIdOfFirst(first, id) };
      const tip = await this.classifyTip(id, opts.logFoldFor);
      if (tip.kind === "continued") {
        const next = tip.successorId;
        if (next !== undefined) {
          // ROUTE to the newest verified generation (O(log n) probe); the verified single step
          // below is the fallback when the deepest log cannot be verified.
          const routed = await this.routeToDeepest(id, first);
          if (routed !== undefined && routed.id !== id) {
            id = routed.id;
            continue;
          }
          if (hop >= maxHops) {
            // Reported, not thrown, and named lazily: `send` has authorized against the chain's
            // owner already, and an unauthorized caller learns nothing about its depth or head.
            return {
              ...base,
              status: "hop-limit",
              hopLimitOf: async () => id, // the furthest VERIFIED id reached, never an unverified deepest log
            };
          }
          const successor = (await readRangeOf(this.eventStore, next, 0, 0))[0];
          // Only a VERIFIED link is followed; a pointer at a foreign id is a dead end.
          if (successor !== undefined && isVerifiedSuccessor(first, id, successor, next)) {
            id = next;
            continue;
          }
        }
        return { ...base, status: "continued" };
      }
      if (tip.kind === "terminal") return { ...base, status: tip.status };
      if (tip.kind === "parkedCandidate") {
        const state = await this.foldState(id, opts.logFoldFor);
        return { ...base, status: "parkedCandidate", ...(state !== null && { state }) };
      }
      // ADR 0109 D4 — the start-to-commit window: the predecessor still reads `running` (its
      // `EXECUTION_CONTINUED` has not committed) but its successor already started. A message
      // addressed to the predecessor would reach a body that is about to stop, so resolve forward
      // by probing `<chainId>~<generation+1>`. One point read, and only with the feature on.
      if (this.continueAsNewEnabled) {
        const next = await this.probeSuccessor(id, chainOfFirstEnvelope(first, id), first);
        if (next !== undefined) {
          const routed = await this.routeToDeepest(id, first);
          if (routed !== undefined && routed.id !== id) {
            id = routed.id;
            continue;
          }
          if (hop >= maxHops) {
            return {
              ...base,
              status: "hop-limit",
              hopLimitOf: async () => id, // the furthest VERIFIED id reached, never an unverified deepest log
            };
          }
          id = next;
          continue;
        }
      }
      if (tip.kind === "ambiguous") return { ...base, status: "ambiguous" };
      return { ...base, status: "running" };
    }
  }

  /**
   * Read the newest {@link SEND_TIP_WALK} events of `id` and say what they mean: walk back past the
   * kinds that never answer a park (`EVENT_KIND_CLASS`: a `TIMER_FIRED` or a discard
   * `DECISION_RECORDED` whose resume never landed, an `APPROVAL_GRANTED` / `OUTCOME_RECORDED` /
   * `EXECUTION_DENIED` audit row, a half-written pair) to the newest ANSWERING one. A park means
   * "might be parked": the caller folds. A resume newest among the answering kinds means a running
   * owner. A window with NO answering kind at all (eight app emits, parallel `STEP_*`, timer
   * fires...) is AMBIGUOUS, never "running": the park may lie further back, and calling it running
   * would skip the wake of a parked owner (a lost wakeup). The sender treats it as "maybe parked".
   */
  private async classifyTip(
    id: string,
    logFoldFor?: QuarantineVerb
  ): Promise<
    | { kind: "running" }
    | { kind: "ambiguous" }
    | { kind: "parkedCandidate" }
    | { kind: "terminal"; status: "completed" | "failed" | "cancelled" }
    | { kind: "continued"; successorId: string | undefined }
  > {
    const reads = this.quarantineReadsFor(logFoldFor);
    const tipSeq = await headOf(reads, id);
    if (tipSeq === null) return { kind: "ambiguous" };
    const window = await readRangeOf(reads, id, Math.max(0, tipSeq - SEND_TIP_WALK + 1), tipSeq);
    for (let i = window.length - 1; i >= 0; i--) {
      const e = window[i] as EventEnvelope;
      if (e.eventType === "EXECUTION_CONTINUED" && e.metadata?.kernel === true) {
        const next = (e.payload as { successorId?: unknown } | null)?.successorId;
        return {
          kind: "continued",
          successorId: typeof next === "string" && next.length > 0 ? next : undefined,
        };
      }
      if (e.eventType === "EXECUTION_COMPLETED") return { kind: "terminal", status: "completed" };
      if (e.eventType === "EXECUTION_FAILED") return { kind: "terminal", status: "failed" };
      if (e.eventType === "EXECUTION_CANCELLED") return { kind: "terminal", status: "cancelled" };
      if (!isAnsweringKind(e)) continue;
      return e.eventType === "EXECUTION_RESUMED"
        ? { kind: "running" }
        : { kind: "parkedCandidate" }; // a park, or a kind this node cannot classify (fail closed)
    }
    // Nothing in the window answers a park. If the window starts at sequence 0 the whole log was
    // read and there is no park: running. Otherwise we cannot tell.
    return window.length > 0 && (window[0] as EventEnvelope).sequence === 0
      ? { kind: "running" }
      : { kind: "ambiguous" };
  }

  /**
   * ADR 0110 D1 — send a message to an execution's durable inbox: the ONLY writer of the inbox
   * stream. Authorized as `ExecutionOp` `"send"` against the OWNER of the chain's head (read from
   * the log, ADR 0111 D5) before "not found" is revealed; under `security.strict` a call with no
   * principal is refused and nothing is appended. A message to an execution that can never consume
   * it (completed, failed, cancelled) is refused with {@link InboxClosedError}; one beyond
   * `inboxMaxBacklog` unconsumed messages with {@link InboxFullError}. Stored at `head + 1`
   * (an O(1) allocation), recorded with the sender's identity subset, and followed by a coalesced
   * durable wake (one due-now `TimerStore` row per head) when the owner is parked on an inbox
   * wait. At-least-once: a retry with the same `messageId` is consumed once (D6).
   */
  async send(
    executionId: string,
    message: SendMessage,
    options?: SendOptions
  ): Promise<SendResult> {
    return this.sealedOp("send", executionId, options?.principal, options?.system, () =>
      this.sendCore(executionId, message, options)
    );
  }

  /** `send` without the sealed-stream translation (see `sealedOp`). */
  private async sendCore(
    executionId: string,
    message: SendMessage,
    options?: SendOptions
  ): Promise<SendResult> {
    this.assertInboxEnabled("runtime.send");
    assertNotReserved(executionId);
    // Authorize FIRST, against the addressed id's recorded owner (which every generation of the
    // chain inherits): an unauthorized or unknown caller costs one point read and learns nothing
    // of the chain's depth, its head, or whether a successor exists.
    // No durable EXECUTION_DENIED on a denial: a sender must never write into the owner's log (that
    // is the very race the separate stream avoids). The audit callback still fires.
    const addressed = await this.authorizeAtAnchor(
      "send",
      executionId,
      options?.principal,
      options?.system
    );
    if (addressed === undefined) {
      await this.denyMissing("send", executionId, options?.principal, options?.system);
      throw new Error(`No execution found for id: ${executionId}`);
    }
    const head = await this.sendTarget(executionId, { first: addressed });
    if (head === null) throw new Error(`No execution found for id: ${executionId}`);
    // ...and again against the RESOLVED head's recorded owner before acting on it (D4).
    if (head.id !== executionId && head.status !== "hop-limit") {
      const headDenial = this.authzDenial(
        "send",
        head.id,
        head.workflowId,
        options?.principal,
        options?.system,
        await this.ownerForAuthz("send", head.id, options?.principal, options?.system, {
          first: head.first,
        })
      );
      if (headDenial !== undefined) {
        await this.denyOp(
          "send",
          head.id,
          head.workflowId,
          options?.principal,
          headDenial.reason,
          undefined
        );
      }
    }
    if (head.status === "hop-limit") {
      throw new ChainHopLimitError(
        executionId,
        this.maxChainHops,
        (await head.hopLimitOf?.()) ?? head.id
      );
    }
    const status =
      head.state !== undefined && head.status === "parkedCandidate"
        ? head.state.status
        : head.status;
    if (status === "completed" || status === "failed" || status === "cancelled") {
      throw new InboxClosedError(head.id, status);
    }
    if (status === "continued") {
      throw new InboxClosedError(head.id, "continued with no successor yet");
    }
    const problem = topicProblem(message.topic);
    if (problem !== undefined) throw new InboxMessageRefusedError(head.id, problem);
    let json: string | undefined;
    try {
      json = JSON.stringify(message.payload ?? null);
    } catch {
      throw new InboxMessageRefusedError(head.id, "the payload has no JSON form");
    }
    // ADR 0110 D9 — a payload that is the erasure marker `{ $shredded: true }` is how the runtime
    // tells a flow "this message was erased" (an inbox read whose key is gone yields it). A sender
    // must not be able to forge it, and a marker-shaped payload has no other use, so it is refused
    // (the marker carries no EVENT_SCHEMA field a flow could check instead).
    if (json?.includes('"$shredded"')) {
      const sent = JSON.parse(json) as unknown;
      if (
        typeof sent === "object" &&
        sent !== null &&
        !Array.isArray(sent) &&
        (sent as { $shredded?: unknown }).$shredded === true
      ) {
        throw new InboxMessageRefusedError(
          head.id,
          'the payload is shaped like the erasure marker ({ "$shredded": true }), which only the runtime may deliver'
        );
      }
    }
    // Bytes, not UTF-16 code units: the limit protects the store and the owner's log.
    const size = json === undefined ? 0 : Buffer.byteLength(json, "utf8");
    if (size > this.inboxMaxPayloadBytes) {
      throw new InboxMessageRefusedError(
        head.id,
        `the payload is ${size} bytes, over inboxMaxPayloadBytes (${this.inboxMaxPayloadBytes})`
      );
    }
    // ADR 0130 — send runs BEFORE the store seals (sealing happens inside the event-store wrapper at
    // append), so a raw payload carrying `__loomEnc` here is ALWAYS forged or relayed ciphertext:
    // never a genuine seal. Refused, or a forged envelope would be indistinguishable from a real
    // one at delivery. A payload too large/deep to check is refused too (fail closed).
    // Walk the JSON the store will persist (a `toJSON` can mint an envelope the live object does
    // not show), AFTER the byte-size check so the parse is bounded by `inboxMaxPayloadBytes`.
    const envelope = sealedEnvelopeIn(json === undefined ? undefined : JSON.parse(json));
    if (envelope !== "clean") {
      throw new InboxMessageRefusedError(
        head.id,
        envelope === "sealed"
          ? 'the payload carries a "__loomEnc" envelope, which only the configured crypto store may produce'
          : "the payload is too large or too deeply nested to be checked for a sealed envelope"
      );
    }
    if (typeof message.messageId === "string" && message.messageId.length > MAX_MESSAGE_ID_LENGTH) {
      throw new InboxMessageRefusedError(
        head.id,
        `the messageId is longer than ${MAX_MESSAGE_ID_LENGTH} characters`
      );
    }
    const messageId =
      typeof message.messageId === "string" && message.messageId.length > 0
        ? message.messageId
        : ulid();
    const chainId = head.chainId;
    // ADR 0110 D10b — once the FLEET switched, every send writes the topic's own stream. A node whose
    // flag is off refuses (typed) instead of writing the legacy stream below the owner's cursor,
    // where the message would be skipped forever.
    const switched = await this.fleetSwitched();
    if (switched && !this.inboxTopicStreamsFlag) throw new InboxTopicStreamsRequiredError(head.id);
    const perTopic = switched;
    await this.assertInboxHasRoom(head.id, chainId, perTopic ? message.topic : undefined);
    if (perTopic) await this.ensureTopicRegistered(head.id, chainId, message.topic);
    // With a TTL on, the envelope is stamped on the STORE's clock when it has one (every node of a
    // fleet then ages a message on one clock); off, or on a single-process store, the runtime clock.
    const stampClock = this.inboxTtlOn ? () => this.ttlClock() : this.now;
    const stored = {
      topic: message.topic,
      messageId,
      payload: message.payload ?? null,
      sender: ownerOfChain(options?.principal) ?? {},
    };
    // The sequence of each copy this send wrote (the cursor spaces differ: legacy < 2^40 <= topic).
    let legacySeq: number | undefined;
    let topicSeq: number | undefined;
    if (perTopic) {
      topicSeq = await appendInboxMessage(this.eventStore, chainId, stored, stampClock, true);
      await this.verifyTopicRegistered(chainId, message.topic);
    } else {
      legacySeq = await appendInboxMessage(this.eventStore, chainId, stored, stampClock, false);
      if (await this.fleetSwitched()) {
        // The fleet switched while this send was in flight: the legacy copy may sit BELOW a cursor
        // that already moved into the topic's own stream, and be skipped.
        if (!this.inboxTopicStreamsFlag) throw new InboxTopicStreamsRequiredError(head.id, true);
        // Write the topic-stream copy too; the owner's dedupe window delivers whichever it reaches
        // first once (within the window, see the ADR). An UNREGISTERED topic that cannot register
        // (the cap) has no topic-stream message, so no cursor of it can be in the topic range yet: the
        // legacy copy is read first and suffices, and the delivered message is not refused.
        if (await this.ensureTopicRegistered(head.id, chainId, message.topic, true)) {
          topicSeq = await appendInboxMessage(this.eventStore, chainId, stored, stampClock, true);
          await this.verifyTopicRegistered(chainId, message.topic);
        }
      }
    }
    const inboxSeq = (topicSeq ?? legacySeq) as number;
    // The wake decision is made from a read taken AFTER the append (ADR 0110 D5, the lost-wakeup
    // protocol). The owner parks durably and THEN re-reads the stream; this sender appends and THEN
    // reads the owner. Whichever order they interleave in, one of them sees the other: if the
    // sender's read finds no park, the park had not landed before the append, so the owner's
    // post-park re-read finds the message; if it finds the park, it wakes it. Deciding from the
    // pre-append read (the authorization one) could miss a park that landed in between.
    const after = await this.sendTarget(head.id);
    if (
      after !== null &&
      (after.status === "completed" || after.status === "failed" || after.status === "cancelled")
    ) {
      // The owner turned terminal around the append: its own stream delete may have run BEFORE the
      // append landed, which would leave this message in an orphan stream. Delete it again (the
      // terminal is durable, so nothing will ever read it). But was it DELIVERED first? The owner
      // may have consumed it (cursor at or past its sequence, or its key already in the dedupe
      // window) and then finished: that is a normal send, not a refusal.
      const final = await this.foldState(after.id);
      await this.retireInbox(chainId);
      // The stream THIS send wrote, deleted by name: the registry may not (or no longer) name it.
      if (topicSeq !== undefined) {
        try {
          await this.eventStore.deleteExecution?.(inboxTopicStreamId(chainId, message.topic));
        } catch (err) {
          this.onStorageError?.(chainId, err);
        }
      }
      const inbox = final?.variables._inbox as { dedupe?: string[] } | undefined;
      // Compare within the cursor's OWN space: a cursor in the topic range is "past" every legacy
      // sequence, which says nothing about a message that was written only to the legacy stream.
      const cursor = final === null ? -1 : cursorFor(cursorsOf(final.variables), message.topic);
      const cursorPast =
        cursor >= INBOX_TOPIC_SEQ_BASE
          ? topicSeq !== undefined && cursor >= topicSeq
          : legacySeq !== undefined && cursor >= legacySeq;
      const delivered =
        final !== null &&
        (cursorPast ||
          (inbox?.dedupe ?? []).includes(
            dedupeKeyOf({ messageId, sender: ownerOfChain(options?.principal) ?? {} })
          ));
      if (delivered) return { messageId, inboxSeq, executionId: after.id };
      throw new InboxClosedError(after.id, after.status, true);
    }
    const live = after ?? head;
    const state = after !== null && after.status === "parkedCandidate" ? after.state : undefined;
    // An AMBIGUOUS tail (no answering kind in the window, see `classifyTip`) is "maybe parked": the
    // coalesced due-now row is written and the notify path judges the real state (a no-op for a
    // running owner). Only a tail that provably is not a park skips the wake.
    const maybeParked =
      after !== null && after.status === "ambiguous"
        ? true
        : state !== undefined && this.parkedOnInbox(state, message.topic);
    if (maybeParked) {
      if (this.timerStore !== undefined) {
        try {
          await this.timerStore.schedule({ executionId: live.id, wakeAt: INBOX_WAKE_AT });
        } catch (err) {
          this.onStorageError?.(live.id, err);
        }
      } else {
        this.warnNoTimerStore(live.workflowId, "an inbox wait");
      }
      void this.notifyInbox(live.id).catch((err: unknown) => this.onStorageError?.(live.id, err));
    }
    // ADR 0110 D10a — a topic with a TTL gets an expiry row (coalesced per chain), whether or not the
    // owner is parked: the pass that fires it decides, and a running owner is simply retried.
    const ttl = this.inboxTtlOn ? ttlOfTopic(this.inboxTtl, message.topic) : undefined;
    if (ttl !== undefined) {
      await this.scheduleInboxExpiry(live.id, chainId, this.now() + ttl, live.workflowId);
    }
    return { messageId, inboxSeq, executionId: live.id };
  }

  /**
   * ADR 0110 amendment (D8) — an OPERATOR discards unconsumed inbox messages: advance one topic's
   * cursor up to `throughSeq`, journaled as a `MESSAGE_CONSUMED` fact in the owner's log so the skip
   * replays, releases a stream that one unconsumed message pins (`InboxFullError` for the whole
   * chain), and survives a restart. The message is dropped, not delivered: its payload is never
   * copied into the log.
   *
   * - Authorized as `ExecutionOp` `"discard"` (closed by default in `executionAccessPolicy`) against
   *   the chain head's recorded owner, before "not found" is revealed. A denial appends nothing; the
   *   operator's identity subset is recorded on the fact as its `sender`.
   * - The owner must be PARKED. The fact lands in the owner's own log, which only a parked owner
   *   accepts without racing its own appends (the very race the separate stream exists to avoid); it
   *   is written under the park's conditional fence as an ignorable kind, exactly like the
   *   duplicate-only advance, so the park stays unanswered. A running owner is refused
   *   (`not-parked`, retryable): it is consuming, and a hot topic is not what pins the stream.
   * - Bounded to what exists: `throughSeq` may not exceed the stream's head, or a later message would
   *   take a skipped sequence.
   * - Idempotent: a cursor already at or past `throughSeq` appends nothing (`skipped: 0`).
   * - A finished owner is `InboxClosedError` (its stream is already gone).
   */
  async discardInbox(
    executionId: string,
    input: DiscardInboxInput,
    options?: DiscardInboxOptions
  ): Promise<DiscardInboxResult> {
    return this.sealedOp("discard", executionId, options?.principal, options?.system, () =>
      this.discardInboxCore(executionId, input, options)
    );
  }

  /** `discardInbox` without the sealed-stream translation (see `sealedOp`). */
  private async discardInboxCore(
    executionId: string,
    input: DiscardInboxInput,
    options?: DiscardInboxOptions
  ): Promise<DiscardInboxResult> {
    this.assertInboxEnabled("runtime.discardInbox");
    assertNotReserved(executionId);
    // A discard is an OPERATOR action that destroys a message: it names who did it, whether or not
    // an authorizer is wired or `strict` is on (`authzApplies` lets a principal-less, non-strict
    // call through, which would make an anonymous discard succeed with an empty `sender` in the
    // audit fact). Refused before anything is read, so it is no existence oracle either.
    // Not even the kernel's system grant stands in for the operator.
    if (options?.principal === undefined) {
      throw new ExecutionDeniedError(
        "discard",
        executionId,
        "a discard is an operator action and needs an authenticated principal"
      );
    }
    // No durable EXECUTION_DENIED, as for `send`: the audit callback fires, the log is untouched.
    const addressed = await this.authorizeAtAnchor(
      "discard",
      executionId,
      options?.principal,
      options?.system
    );
    if (addressed === undefined) {
      await this.denyMissing("discard", executionId, options?.principal, options?.system);
      throw new Error(`No execution found for id: ${executionId}`);
    }
    const head = await this.sendTarget(executionId, { first: addressed });
    if (head === null) throw new Error(`No execution found for id: ${executionId}`);
    // ...and again against the RESOLVED head's recorded owner before acting on it.
    if (head.id !== executionId && head.status !== "hop-limit") {
      const headDenial = this.authzDenial(
        "discard",
        head.id,
        head.workflowId,
        options?.principal,
        options?.system,
        await this.ownerForAuthz("discard", head.id, options?.principal, options?.system, {
          first: head.first,
        })
      );
      if (headDenial !== undefined) {
        await this.denyOp(
          "discard",
          head.id,
          head.workflowId,
          options?.principal,
          headDenial.reason,
          undefined
        );
      }
    }
    if (head.status === "hop-limit") {
      throw new ChainHopLimitError(
        executionId,
        this.maxChainHops,
        (await head.hopLimitOf?.()) ?? head.id
      );
    }
    const refuse = (reason: "not-parked" | "contended" | "invalid", detail: string): never => {
      throw new InboxDiscardRefusedError(head.id, reason, detail);
    };
    const topic = input.topic;
    const problem = topicProblem(topic);
    if (problem !== undefined) refuse("invalid", `${problem}.`);
    const through = input.throughSeq;
    if (!Number.isSafeInteger(through) || through < 0) {
      refuse("invalid", "throughSeq must be a non-negative integer.");
    }
    if (
      input.reason !== undefined &&
      (typeof input.reason !== "string" || input.reason.length > 256)
    ) {
      refuse("invalid", "reason must be a string of at most 256 characters.");
    }
    const state = await this.foldState(head.id);
    if (state === null) throw new Error(`No execution found for id: ${executionId}`);
    if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
      throw new InboxClosedError(head.id, state.status);
    }
    if (state.status === "continued") {
      throw new InboxClosedError(head.id, "continued with no successor yet");
    }
    const chainId = chainIdOf(state, head.id);
    const cursor = cursorFor(cursorsOf(state.variables), topic);
    if (through <= cursor) return { executionId: head.id, topic, skipped: 0, cursor };
    // ADR 0110 D10b: a sequence in the topic range names the topic's OWN stream, below it the legacy one.
    const streamHead = await headOf(
      this.eventStore,
      through >= INBOX_TOPIC_SEQ_BASE ? inboxTopicStreamId(chainId, topic) : inboxStreamId(chainId)
    );
    if (streamHead === null || through > streamHead) {
      refuse(
        "invalid",
        `throughSeq ${through} is beyond the stream's head (${streamHead ?? "empty"}): only messages that exist can be discarded.`
      );
    }
    if (state.status !== "suspended") {
      refuse(
        "not-parked",
        `the owner is ${state.status}; a discard is journaled in its log, which only a parked owner accepts. Retry once it parks.`
      );
    }
    // Count what the advance skips (bounded by the backlog cap), for the audit fact and the result,
    // and keep the dedupe key of each (only the newest window's worth can matter, see below).
    let skipped = 0;
    const skippedKeys: Array<{ key: string; seq: number }> = [];
    for (let after = cursor; ; ) {
      const page = await this.inboxSource(chainId, topic, after, NOTIFY_PAGE);
      for (const m of page) {
        if (m.inboxSeq > through) continue;
        skipped++;
        skippedKeys.push({ key: dedupeKeyOf(m), seq: m.inboxSeq });
      }
      const last = page[page.length - 1];
      if (page.length < NOTIFY_PAGE || last === undefined || last.inboxSeq >= through) break;
      after = last.inboxSeq;
    }
    if (skippedKeys.length > INBOX_DEDUPE_CAP)
      skippedKeys.splice(0, skippedKeys.length - INBOX_DEDUPE_CAP);
    const parkSeq = await this.locatePark(head.id, state, { events: undefined, complete: false });
    if (parkSeq === undefined) {
      refuse("not-parked", "the owner has no unanswered park to journal under.");
    }
    const operator = ownerOfChain(options?.principal) ?? {};
    // Each skipped message enters the fold's dedupe window (P3-4: a sender that resends a discarded
    // `messageId` is a duplicate, delivered to nothing, not a fresh message). Only the newest
    // INBOX_DEDUPE_CAP ids can still be in a window, so a larger discard journals that many: past
    // the window the oldest ids are forgotten, as they are for any consumed message. The LAST fact
    // carries the whole discard (`inboxSeq: through`, the count, the reason); with nothing of this
    // topic to skip, one fact under a fixed key still advances the cursor.
    const facts = discardFacts(topic, skippedKeys, through, operator, {
      skipped,
      ...(input.reason !== undefined && { reason: input.reason }),
    });
    const outcome = await this.advanceInbox(head.id, state, parkSeq as number, undefined, facts);
    if (outcome === "gone") {
      refuse("not-parked", "the owner resumed while the discard was in flight.");
    }
    if (outcome === "contended") {
      refuse("contended", "the owner's fence kept moving.");
    }
    // The pin may be gone: forget the cached verdicts and force the trim past its old floor.
    const after = (await this.foldState(head.id)) ?? state;
    this.inboxFull.delete(chainId);
    this.inboxCounted.delete(chainId);
    this.inboxTrimmed.delete(chainId);
    await this.maybeTrimInbox(chainId, after);
    return {
      executionId: head.id,
      topic,
      skipped,
      cursor: cursorFor(cursorsOf(after.variables), topic),
    };
  }

  // ── ADR 0130 residuals D9 — quarantineInbox / releaseInbox ─────────────────────────────────

  /**
   * The shared prelude of the two operator verbs (modelled on `discardInboxCore`): the inbox is on,
   * a PRINCIPAL is present (refused before anything is read, so it is no existence oracle, and the
   * system grant does not stand in), the caller is authorized as `op` against the id addressed AND
   * the resolved chain head's recorded owner. Returns the head.
   */
  private async operatorInboxHead(
    verb: "quarantineInbox" | "releaseInbox",
    op: ExecutionOp,
    executionId: string,
    options: { principal?: PrincipalChain; system?: SystemGrant } | undefined
  ): Promise<NonNullable<Awaited<ReturnType<WorkflowRuntime["sendTarget"]>>>> {
    this.assertInboxEnabled(`runtime.${verb}`);
    assertNotReserved(executionId);
    if (options?.principal === undefined) {
      throw new ExecutionDeniedError(
        op,
        executionId,
        `${verb} is an operator action and needs an authenticated principal`
      );
    }
    const addressed = await this.authorizeAtAnchor(
      op,
      executionId,
      options.principal,
      options.system
    );
    if (addressed === undefined) {
      await this.denyMissing(op, executionId, options.principal, options.system);
      throw new Error(`No execution found for id: ${executionId}`);
    }
    const head = await this.sendTarget(executionId, { first: addressed, logFoldFor: verb });
    if (head === null) throw new Error(`No execution found for id: ${executionId}`);
    if (head.id !== executionId && head.status !== "hop-limit") {
      const headDenial = this.authzDenial(
        op,
        head.id,
        head.workflowId,
        options.principal,
        options.system,
        await this.ownerForAuthz(op, head.id, options.principal, options.system, {
          first: head.first,
        })
      );
      if (headDenial !== undefined) {
        await this.denyOp(
          op,
          head.id,
          head.workflowId,
          options.principal,
          headDenial.reason,
          undefined
        );
      }
    }
    if (head.status === "hop-limit") {
      throw new ChainHopLimitError(
        executionId,
        this.maxChainHops,
        (await head.hopLimitOf?.()) ?? head.id
      );
    }
    return head;
  }

  /** The owner's folded state, or the typed `InboxClosedError` for a finished owner. */
  private async openOwnerState(
    executionId: string,
    headId: string,
    verb: QuarantineVerb
  ): Promise<ExecutionState> {
    const state = await this.foldState(headId, verb);
    if (state === null) throw new Error(`No execution found for id: ${executionId}`);
    if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
      throw new InboxClosedError(headId, state.status);
    }
    if (state.status === "continued") {
      throw new InboxClosedError(headId, "continued with no successor yet");
    }
    return state;
  }

  /**
   * ADR 0130 residuals D9 — an OPERATOR holds a topic whose head message is sealed and not openable
   * on THIS node. The message is copied still-sealed into `__loom_quarantine__:<chainId>` FIRST (a
   * deterministic envelope id, so a retry reuses an orphan copy), then `INBOX_QUARANTINED` is
   * journaled under the park's conditional fence (an ignorable kind, so the park stays unanswered):
   * the cursor moves past the head, the topic is HELD for every node (later messages wait behind it,
   * in their original order), and the owner's OTHER topics deliver again. A capable node lifts the
   * hold by itself (auto-release) at its next delivery point; `releaseInbox` does it on demand.
   * Nothing is quarantined automatically, and a message this node CAN open is refused (`not-sealed`).
   * Authorized as `"quarantine"`; a principal is required. See `InboxQuarantineRefusedError`.
   */
  async quarantineInbox(
    executionId: string,
    input: QuarantineInboxInput,
    options?: QuarantineInboxOptions
  ): Promise<QuarantineInboxResult> {
    return this.sealedOp("quarantine", executionId, options?.principal, options?.system, () =>
      this.quarantineInboxCore(executionId, input, options)
    );
  }

  private async quarantineInboxCore(
    executionId: string,
    input: QuarantineInboxInput,
    options?: QuarantineInboxOptions
  ): Promise<QuarantineInboxResult> {
    const head = await this.operatorInboxHead(
      "quarantineInbox",
      "quarantine",
      executionId,
      options
    );
    const refuse = (
      reason: "not-parked" | "contended" | "invalid" | "not-sealed",
      detail: string
    ): never => {
      throw new InboxQuarantineRefusedError(head.id, reason, detail, "quarantineInbox");
    };
    const topic = input.topic;
    const problem = topicProblem(topic);
    if (problem !== undefined) refuse("invalid", `${problem}.`);
    if (
      input.reason !== undefined &&
      (typeof input.reason !== "string" || input.reason.length > 256)
    ) {
      refuse("invalid", "reason must be a string of at most 256 characters.");
    }
    const state = await this.openOwnerState(executionId, head.id, "quarantineInbox");
    if (state.status !== "suspended") {
      refuse(
        "not-parked",
        `the owner is ${state.status}; a hold is journaled in its log, which only a parked owner accepts. Retry once it parks.`
      );
    }
    const chainId = chainIdOf(state, head.id);
    // The topic's HEAD message: the first non-duplicate past the cursor (duplicates ahead of it are
    // journaled in the same batch, as the notify scan does).
    const cursors = { ...cursorsOf(state.variables) };
    const recent = new Set(
      (state.variables._inbox as { dedupe?: string[] } | undefined)?.dedupe ?? []
    );
    // A key already HELD (any topic, any state) is not held a second time: the hold does not add it to the
    // dedupe window, so a second hold of the same id would be a second copy whose release delivers the
    // message twice. It cannot be skipped as a duplicate either (a duplicate fact would put the key in the
    // window and turn the held delivery itself into a duplicate). It is refused; the retry is a
    // duplicate once the held one is delivered, and the ordinary delivery path then drops it.
    const heldKeys = new Set<string>();
    for (const queue of Object.values(quarantineQueues(state.variables))) {
      for (const x of queue) heldKeys.add(x.key);
    }
    const skipped: Array<{ eventType: string; payload: unknown }> = [];
    let headMsg: InboxMessage | undefined;
    for (;;) {
      const page = await this.inboxSource(chainId, topic, cursorFor(cursors, topic), NOTIFY_PAGE);
      for (const m of page) {
        const key = dedupeKeyOf(m);
        if (!recent.has(key) && heldKeys.has(key)) {
          refuse(
            "invalid",
            `a message with the same id as "${m.messageId}" is already held; it becomes a duplicate once the held one is delivered. Release the held message first.`
          );
        }
        if (recent.has(key)) {
          skipped.push(skippedDuplicateFact(topic, key, m.inboxSeq, m.sender, DISCARD_WAIT_ID));
          cursors[topic] = m.inboxSeq;
          continue;
        }
        headMsg = m;
        break;
      }
      if (headMsg !== undefined || page.length < NOTIFY_PAGE) break;
      if (skipped.length >= NOTIFY_BATCH_CAP) {
        refuse(
          "invalid",
          "too many duplicates ahead of the topic's head to journal in one batch; retry."
        );
      }
    }
    if (headMsg === undefined) refuse("invalid", `topic "${topic}" has no message to hold.`);
    const msg = headMsg as InboxMessage;
    // A REDACTED read is not evidence that the message is plain: this node holds no key for it. That
    // is key-unavailable, never `not-sealed`, and there is nothing byte-exact to copy.
    if (readsAsRedacted(msg.payload)) {
      throw new SealedPayloadUnreadableError(head.id, msg.messageId, topic);
    }
    if (sealedEnvelopeIn(msg.payload) === "clean") {
      refuse(
        "not-sealed",
        `message "${msg.messageId}" on topic "${topic}" is not sealed, or this node can open it: a quarantine is only for a message this node cannot open (use discardInbox to drop a message).`
      );
    }
    const key = dedupeKeyOf(msg);
    const original = await readInboxEnvelope(this.eventStore, chainId, topic, msg.inboxSeq);
    if (original === undefined)
      refuse("invalid", "the message left the inbox while it was being held.");
    const live = Object.values(quarantineQueues(state.variables)).flat();
    // Free what is positively disposed of (never an in-flight copy: see `trimQuarantine`), then bound
    // the span that is left. A copy of THIS message already in the stream (a crashed attempt) is reused.
    const trimmed = await trimQuarantine(
      this.eventStore,
      chainId,
      live,
      cursorsOf(state.variables)
    ).catch((e: unknown) => {
      this.onStorageError?.(head.id, e);
      return undefined;
    });
    if ((await findQuarantineCopy(this.eventStore, chainId, key, msg.inboxSeq)) === undefined) {
      const span =
        trimmed === undefined
          ? retainedSpan(
              await headOf(this.eventStore, quarantineStreamId(chainId)),
              live.length === 0 ? null : Math.min(...live.map((x) => x.heldAt))
            )
          : retainedSpan(trimmed.head, trimmed.oldestPinned);
      if (span >= this.inboxQuarantineMax || live.length + 1 > QUARANTINE_FOLD_CAP) {
        refuse(
          "invalid",
          `the chain's quarantine holds ${span} retained copies (inbox quarantineMax ${this.inboxQuarantineMax}); release or discard a held message first.`
        );
      }
    }
    const parkSeq = await this.locatePark(
      head.id,
      state,
      { events: undefined, complete: false },
      "quarantineInbox"
    );
    if (parkSeq === undefined)
      refuse("not-parked", "the owner has no unanswered park to journal under.");
    // Copy FIRST (verbatim, still sealed), THEN the fact: a crash between leaves an orphan copy a
    // retry reuses, never a cleared head without a retained payload.
    const heldAt = await appendQuarantineCopy(
      this.eventStore,
      chainId,
      original as EventEnvelope,
      key,
      topic,
      msg.inboxSeq
    );
    const operator = ownerOfChain(options?.principal) ?? {};
    const facts = [
      ...skipped,
      {
        eventType: "INBOX_QUARANTINED",
        payload: {
          topic,
          inboxSeq: msg.inboxSeq,
          key,
          messageId: msg.messageId,
          heldAt,
          operator,
          ...(input.reason !== undefined && { reason: input.reason }),
        },
      },
    ];
    const outcome = await this.advanceInbox(
      head.id,
      state,
      parkSeq as number,
      undefined,
      facts,
      true
    );
    if (outcome === "gone") refuse("not-parked", "the owner resumed while the hold was in flight.");
    if (outcome === "contended") refuse("contended", "the owner's fence kept moving.");
    if (outcome === "stale") {
      refuse(
        "invalid",
        "the topic moved while the hold was in flight (a delivery, a discard or another hold won); the copy stays for a retry."
      );
    }
    await this.afterHoldChange(head.id, chainId, "quarantineInbox");
    return {
      executionId: head.id,
      topic,
      messageId: msg.messageId,
      inboxSeq: msg.inboxSeq,
      heldAt,
    };
  }

  /**
   * After a hold or release landed: leave the durable wake row (a capable node's poll reaches a
   * parked owner nobody else would wake), forget the cached backlog verdicts, trim what the cursor
   * freed, and run the notify path so THIS node delivers whatever the change made deliverable (the
   * other topics after a hold, the topic's own backlog after a discard). A sealed refusal from that
   * pass is the expected "held, awaiting a capable node": not an error of the verb.
   */
  private async afterHoldChange(
    executionId: string,
    chainId: string,
    verb: QuarantineVerb
  ): Promise<void> {
    if (this.timerStore !== undefined) {
      await this.timerStore
        .schedule({ executionId, wakeAt: INBOX_WAKE_AT })
        .catch((e: unknown) => this.onStorageError?.(executionId, e));
    }
    this.inboxFull.delete(chainId);
    this.inboxCounted.delete(chainId);
    this.inboxTrimmed.delete(chainId);
    const after = await this.foldState(executionId, verb);
    if (after !== null) {
      await this.maybeTrimInbox(chainId, after);
    }
    try {
      await this.notifyInbox(executionId);
    } catch (err) {
      if (!isSealedUnreadable(err)) this.onStorageError?.(executionId, err);
    }
  }

  /** The release/discard fact for `key` journaled after `fromSeq`, if any (the idempotence check). */
  private async findReleaseFact(
    executionId: string,
    fromSeq: number,
    match: (p: { topic?: unknown; key?: unknown; messageId?: unknown }) => boolean,
    verb: QuarantineVerb
  ): Promise<{ disposition: "deliver" | "discard" } | undefined> {
    for (const e of await this.quarantineReadsFor(verb).readFrom(executionId, fromSeq)) {
      if (e.eventType !== "INBOX_RELEASED") continue;
      const p = e.payload as {
        disposition?: unknown;
        topic?: unknown;
        key?: unknown;
        messageId?: unknown;
      };
      if (match(p) && (p.disposition === "deliver" || p.disposition === "discard")) {
        return { disposition: p.disposition };
      }
    }
    return undefined;
  }

  /**
   * The most recent release/discard fact matching `match`, searched BACKWARDS from the owner's tail in
   * bounded chunks (the idempotent repeat of a release follows the release closely; the log is never
   * read from sequence 0), then in the continued predecessors (a release journaled before a
   * continue-as-new). `budget` events are examined in all. `ambiguous` is true when facts for more than
   * one distinct key matched within the chunk that holds the newest match (several senders reused the message id).
   */
  private async findReleaseFactBack(
    state: ExecutionState,
    headId: string,
    match: (p: { topic?: unknown; key?: unknown; messageId?: unknown }) => boolean,
    budgetEvents = RELEASE_SEARCH_BUDGET,
    logFoldFor?: QuarantineVerb
  ): Promise<{ disposition: "deliver" | "discard"; ambiguous: boolean } | undefined> {
    let budget = budgetEvents;
    const reads = this.quarantineReadsFor(logFoldFor);
    let found: { disposition: "deliver" | "discard" } | undefined;
    const keys = new Set<string>();
    let executionId: string | undefined = headId;
    let current: ExecutionState | undefined = state;
    for (let hop = 0; executionId !== undefined && hop <= this.maxChainHops; hop++) {
      let to = await headOf(reads, executionId);
      while (to !== null && to >= 0 && budget > 0) {
        const from = Math.max(0, to - RELEASE_SEARCH_CHUNK + 1);
        const events = await readRangeOf(reads, executionId, from, to);
        budget -= to - from + 1;
        for (let i = events.length - 1; i >= 0; i--) {
          const e = events[i] as EventEnvelope;
          if (e.eventType !== "INBOX_RELEASED") continue;
          const p = e.payload as {
            disposition?: unknown;
            topic?: unknown;
            key?: unknown;
            messageId?: unknown;
          };
          if (!match(p) || (p.disposition !== "deliver" && p.disposition !== "discard")) continue;
          found ??= { disposition: p.disposition };
          keys.add(String(p.key));
        }
        if (found !== undefined) break; // the chunk that holds the newest match is the whole answer
        to = from - 1;
      }
      if (budget <= 0 || found !== undefined) break;
      // The predecessor: the state of this link names it (the successor's EXECUTION_STARTED).
      const prior: string | undefined = (
        current !== undefined ? chainOfState(current, executionId) : undefined
      )?.continuedFrom?.executionId;
      if (prior === undefined) break;
      executionId = prior;
      current = (await this.foldState(prior, logFoldFor)) ?? undefined;
    }
    return found === undefined ? undefined : { ...found, ambiguous: keys.size > 1 };
  }

  /**
   * ADR 0130 residuals D9 - free the quarantine copies a disposal left behind (a release consumed, a
   * discard, a delivery that won the race). Runs wherever the inbox trim runs (every park and every verb),
   * for a chain that holds entries now, or whose held copies this node read or wrote earlier
   * (`_quarantined` is deleted when it empties, so the chain is remembered until its stream is clear). Never frees a copy that is live or
   * in flight: see `trimQuarantine`. A node that restarted after the last disposal and never sees another
   * hold keeps the freed-by-nobody copies until the next hold or release on the chain, or until the
   * chain's terminal cleanup.
   */
  /** Read a held copy, and remember the chain: whichever node delivers a held message frees its copy later. */
  private readHeldCopy(chainId: string, entry: QuarantineEntry): Promise<CopyRead> {
    rememberBounded(this.quarantineChains, chainId, true);
    return readQuarantineCopy(this.eventStore, chainId, entry);
  }

  private async trimQuarantineOf(chainId: string, state: ExecutionState): Promise<void> {
    const live = Object.values(quarantineQueues(state.variables)).flat();
    if (live.length === 0 && !this.quarantineChains.has(chainId)) return;
    try {
      const r = await trimQuarantine(this.eventStore, chainId, live, cursorsOf(state.variables));
      if (live.length > 0 || r.oldestPinned !== null)
        rememberBounded(this.quarantineChains, chainId, true);
      else this.quarantineChains.delete(chainId);
    } catch (err) {
      this.onStorageError?.(chainId, err);
    }
  }

  /**
   * ADR 0130 residuals D9 — an OPERATOR releases the topic's OLDEST held message. `"deliver"` (the
   * default, authorized as `"release"`) journals `INBOX_RELEASED{operator}` and runs the notify path,
   * which delivers the message FIRST, from the quarantine copy, at its ORIGINAL `inboxSeq`, ahead of
   * everything that arrived behind it: this node must be able to open the copy (a node that cannot,
   * and a copy that reads as REDACTED, get a typed `SealedPayloadUnreadableError` and nothing is
   * appended). `"discard"` (authorized as `"discard"`: it destroys the message) drops the entry and
   * unblocks the topic and needs no ability to open it, the only exit when no node can. Anything
   * but the topic's oldest held entry is `invalid`; a release that already happened is an idempotent
   * no-op (`changed: false`). A principal is required.
   */
  async releaseInbox(
    executionId: string,
    input: ReleaseInboxInput,
    options?: ReleaseInboxOptions
  ): Promise<ReleaseInboxResult> {
    const op: ExecutionOp = input?.disposition === "discard" ? "discard" : "release";
    return this.sealedOp(op, executionId, options?.principal, options?.system, () =>
      this.releaseInboxCore(op, executionId, input, options)
    );
  }

  private async releaseInboxCore(
    op: ExecutionOp,
    executionId: string,
    input: ReleaseInboxInput,
    options?: ReleaseInboxOptions
  ): Promise<ReleaseInboxResult> {
    const head = await this.operatorInboxHead("releaseInbox", op, executionId, options);
    const refuse = (reason: "not-parked" | "contended" | "invalid", detail: string): never => {
      throw new InboxQuarantineRefusedError(head.id, reason, detail, "releaseInbox");
    };
    const disposition = input.disposition ?? "deliver";
    if (disposition !== "deliver" && disposition !== "discard") {
      refuse("invalid", 'disposition must be "deliver" or "discard".');
    }
    const topic = input.topic;
    const problem = topicProblem(topic);
    if (problem !== undefined) refuse("invalid", `${problem}.`);
    const wanted = input.messageId;
    if (
      typeof wanted !== "string" ||
      wanted.length === 0 ||
      wanted.length > MAX_MESSAGE_ID_LENGTH
    ) {
      refuse("invalid", `messageId must be a string of 1 to ${MAX_MESSAGE_ID_LENGTH} characters.`);
    }
    if (
      input.reason !== undefined &&
      (typeof input.reason !== "string" || input.reason.length > 256)
    ) {
      refuse("invalid", "reason must be a string of at most 256 characters.");
    }
    const result = (changed: boolean): ReleaseInboxResult => ({
      executionId: head.id,
      topic,
      messageId: wanted,
      disposition,
      changed,
    });
    // With a `sender` the message is exactly one dedupe key; without, the message id alone names it and
    // an id several senders reused is ambiguous (never silently the wrong sender's message).
    const wantedKey =
      input.sender === undefined
        ? undefined
        : dedupeKeyOf({ messageId: wanted, sender: input.sender });
    const sameMessage = (p: { topic?: unknown; key?: unknown; messageId?: unknown }): boolean =>
      p.topic === topic &&
      (wantedKey !== undefined ? p.key === wantedKey : p.messageId === wanted || p.key === wanted);
    // An earlier release of this message (the idempotent repeat), judged from the owner's log: searched
    // backwards from the tail (bounded) and through the continued predecessors, never from sequence 0.
    const earlier = async (): Promise<ReleaseInboxResult | undefined> => {
      const at = await this.foldState(head.id, "releaseInbox");
      if (at === null) return undefined;
      const done = await this.findReleaseFactBack(
        at,
        head.id,
        sameMessage,
        RELEASE_SEARCH_BUDGET,
        "releaseInbox"
      );
      if (done === undefined) return undefined;
      if (done.ambiguous) {
        return refuse(
          "invalid",
          `several senders released a message with id "${wanted}" on topic "${topic}"; name the sender to tell them apart.`
        );
      }
      if (done.disposition === disposition) return result(false);
      return refuse(
        "invalid",
        `message "${wanted}" was already ${done.disposition === "discard" ? "discarded" : "released for delivery"}.`
      );
    };
    const terminal = (s: ExecutionState): boolean =>
      s.status === "completed" ||
      s.status === "failed" ||
      s.status === "cancelled" ||
      s.status === "continued";
    const state0 = await this.foldState(head.id, "releaseInbox");
    if (state0 === null) throw new Error(`No execution found for id: ${executionId}`);
    if (terminal(state0)) {
      const repeat = await earlier();
      if (repeat !== undefined) return repeat;
    }
    const state = await this.openOwnerState(executionId, head.id, "releaseInbox");
    const chainId = chainIdOf(state, head.id);
    const queue = quarantineQueue(state.variables, topic);
    if (queue === undefined) {
      const repeat = await earlier();
      if (repeat !== undefined) return repeat;
      return refuse("invalid", `topic "${topic}" has no held message.`);
    }
    const first = queue[0] as (typeof queue)[number];
    const copy = await this.readHeldCopy(chainId, first);
    const copyId = copy.ok ? copy.message.messageId : copy.message?.messageId;
    const isWanted = (entry: { key: string }, id: string | undefined): boolean =>
      wantedKey !== undefined ? entry.key === wantedKey : wanted === id || wanted === entry.key;
    if (!isWanted(first, copyId)) {
      // Not the oldest. Is it a younger held entry (releasing it first would deliver out of order)?
      for (const younger of queue.slice(1)) {
        const c = await this.readHeldCopy(chainId, younger);
        const id = c.ok ? c.message.messageId : c.message?.messageId;
        if (isWanted(younger, id)) {
          return refuse(
            "invalid",
            `message "${wanted}" is not the oldest held message of topic "${topic}": releasing it first would deliver it out of order.`
          );
        }
      }
      const repeat = await earlier();
      if (repeat !== undefined) return repeat;
      return refuse("invalid", `message "${wanted}" is not held on topic "${topic}".`);
    }
    const messageId = copyId ?? wanted;
    if (first.state === "released") {
      if (disposition === "discard") {
        return refuse(
          "invalid",
          `message "${wanted}" is already released and awaits its delivery; it can no longer be discarded.`
        );
      }
      // The release is durable but its delivery has not landed (a crash window): heal it now.
      await this.afterHoldChange(head.id, chainId, "releaseInbox");
      return result(false);
    }
    if (disposition === "deliver" && !copy.ok) throw this.copyRefusal(head.id, topic, first, copy);
    if (state.status !== "suspended") {
      refuse(
        "not-parked",
        `the owner is ${state.status}; a release is journaled in its log, which only a parked owner accepts. Retry once it parks.`
      );
    }
    const parkSeq = await this.locatePark(
      head.id,
      state,
      { events: undefined, complete: false },
      "releaseInbox"
    );
    if (parkSeq === undefined)
      refuse("not-parked", "the owner has no unanswered park to journal under.");
    const operator = ownerOfChain(options?.principal) ?? {};
    const facts = [
      {
        eventType: "INBOX_RELEASED",
        payload: {
          topic,
          key: first.key,
          messageId,
          disposition,
          operator,
          ...(input.reason !== undefined && { reason: input.reason }),
        },
      },
    ];
    const outcome = await this.advanceInbox(
      head.id,
      state,
      parkSeq as number,
      undefined,
      facts,
      true
    );
    if (outcome === "contended") refuse("contended", "the owner's fence kept moving.");
    if (outcome === "gone" || outcome === "stale") {
      // Someone else moved the topic first: an auto-release, another release, a discard. Judge by
      // what landed since this call's fold: the same disposition is an idempotent no-op.
      const landed = await this.findReleaseFact(
        head.id,
        state.sequence + 1,
        (p) => p.key === first.key,
        "releaseInbox"
      );
      if (landed === undefined) {
        if (outcome === "gone")
          refuse("not-parked", "the owner resumed while the release was in flight.");
        return refuse("invalid", "the topic moved while the release was in flight.");
      }
      if (landed.disposition === disposition) return result(false);
      return refuse(
        "invalid",
        `message "${wanted}" was ${landed.disposition === "discard" ? "discarded" : "released"} concurrently.`
      );
    }
    await this.afterHoldChange(head.id, chainId, "releaseInbox");
    return result(true);
  }

  /**
   * Copy the quarantine copies a fork's folded holds refer to into the fork's own chain (see `forkCore`).
   * Every referenced `heldAt` is verified against the parent's quarantine stream FIRST (it exists, and is
   * the entry's message: same key, same original position), and a hold that does not resolve refuses the
   * fork typed before anything is written, so a fork never carries a dangling hold.
   */
  private async copyQuarantineForFork(
    parentExecutionId: string,
    childChain: string,
    held: readonly QuarantineEntry[]
  ): Promise<boolean> {
    const first = (await readRangeOf(this.eventStore, parentExecutionId, 0, 0))[0];
    const parentChain =
      first === undefined ? parentExecutionId : chainIdOfFirst(first, parentExecutionId);
    if (parentChain === childChain) return false;
    const refuse = (detail: string): never => {
      throw new InboxQuarantineRefusedError(parentExecutionId, "invalid", detail, "fork");
    };
    if (this.eventStore.copyPrefix === undefined) {
      refuse(
        "this execution HOLDS quarantined messages and the event store cannot copy the quarantine stream (no copyPrefix); a fork would carry holds whose copies it does not have."
      );
    }
    const stream = quarantineStreamId(parentChain);
    const through = Math.max(...held.map((h) => h.heldAt));
    const present = new Map<number, EventEnvelope>();
    for (const c of await readRangeOf(this.eventStore, stream, 0, through)) {
      present.set(c.sequence, c);
    }
    for (const h of held) {
      const env = present.get(h.heldAt);
      const message = env === undefined ? undefined : asMessage(env);
      if (
        env === undefined ||
        message === undefined ||
        dedupeKeyOf(message) !== h.key ||
        stampOf(env)?.inboxSeq !== h.inboxSeq
      ) {
        refuse(
          `the quarantine stream has no matching copy at heldAt ${h.heldAt} for a held message of this execution; a fork would carry a hold whose copy does not exist. Discard the held message first.`
        );
      }
    }
    await (this.eventStore.copyPrefix as NonNullable<EventStore["copyPrefix"]>)(
      stream,
      quarantineStreamId(childChain),
      through,
      { forkedFrom: stream }
    );
    return true;
  }

  /** The refusal for a held copy this node cannot deliver (sealed, REDACTED, missing or mismatched). */
  private copyRefusal(
    executionId: string,
    topic: string,
    entry: { key: string },
    copy: Extract<CopyRead, { ok: false }>
  ): SealedPayloadUnreadableError {
    return new SealedPayloadUnreadableError(
      executionId,
      copy.message?.messageId ?? entry.key,
      topic,
      copy.why === "missing" || copy.why === "mismatch"
    );
  }

  /**
   * ADR 0130 residuals D9, "Delivery rule" - what a waited topic with a quarantine queue offers THIS
   * node, from the folded state plus the copy. `deliver`: the message to consume FIRST (a released
   * head, or a held head this node auto-releases in the same batch: `release` is then the fact to
   * put in front of the consumption). `skip`: a held head this node will not lift (it cannot open
   * the copy, or auto-release is off): the topic is passed over, no read, no refusal. `open`: no
   * hold. A RELEASED head this node cannot deliver is the execution-wide refusal of D4.
   */
  private async heldDelivery(
    executionId: string,
    chainId: string,
    state: ExecutionState,
    topic: string
  ): Promise<
    | { kind: "open" }
    | { kind: "skip"; err: QuarantineHeldError }
    | {
        kind: "deliver";
        message: InboxMessage;
        key: string;
        release?: { eventType: string; payload: unknown };
      }
    | {
        /** The held key was delivered meanwhile (the dedupe window has it): drop the entry, deliver nothing. */
        kind: "duplicate";
        key: string;
        inboxSeq: number;
        sender: InboxMessage["sender"];
        release?: { eventType: string; payload: unknown };
      }
  > {
    const first = quarantineQueue(state.variables, topic)?.[0];
    if (first === undefined) return { kind: "open" };
    const copy = await this.readHeldCopy(chainId, first);
    // A held key is not in the window when it was held; a same-key message on another topic (or a
    // release that raced one) can put it there since. Delivering it again would break at-most-once, so
    // the entry is dropped by a duplicate consumption: it needs no ability to open the copy.
    const dedupe = (state.variables._inbox as { dedupe?: string[] } | undefined)?.dedupe;
    if (
      dedupe?.includes(first.key) === true &&
      (first.state === "released" || this.inboxAutoRelease)
    ) {
      const sender = copy.ok ? copy.message.sender : (copy.message?.sender ?? {});
      return {
        kind: "duplicate",
        key: first.key,
        inboxSeq: first.inboxSeq,
        sender,
        ...(first.state === "held" && {
          release: {
            eventType: "INBOX_RELEASED",
            payload: {
              topic,
              key: first.key,
              messageId: copy.ok ? copy.message.messageId : (copy.message?.messageId ?? first.key),
              disposition: "deliver",
              auto: true,
            },
          },
        }),
      };
    }
    if (first.state === "released") {
      if (!copy.ok) throw this.copyRefusal(executionId, topic, first, copy);
      return { kind: "deliver", message: copy.message, key: first.key };
    }
    const rule = inboxDeliverable(state.variables, topic, copy.ok && this.inboxAutoRelease);
    if (rule === "blocked" || !copy.ok) {
      return {
        kind: "skip",
        err: new QuarantineHeldError(
          executionId,
          copy.ok ? copy.message.messageId : (copy.message?.messageId ?? first.key),
          topic,
          copy.ok ? "operator" : "capable-node"
        ),
      };
    }
    return {
      kind: "deliver",
      message: copy.message,
      key: first.key,
      release: {
        eventType: "INBOX_RELEASED",
        payload: {
          topic,
          key: first.key,
          messageId: copy.message.messageId,
          disposition: "deliver",
          auto: true,
        },
      },
    };
  }

  /** ADR 0130 residuals D9 - whether THIS node lifts a hold by itself (`kernel.inbox.autoRelease`). */
  get inboxAutoReleaseOn(): boolean {
    return this.inboxEnabled && this.inboxAutoRelease;
  }

  /** ADR 0130 residuals D9 - held messages per chain this node allows (`kernel.inbox.quarantineMax`). */
  get inboxQuarantineLimit(): number {
    return this.inboxQuarantineMax;
  }

  /** Whether a message TTL is configured on a runtime with the inbox on (D10a; the `TimerService` then runs expiry passes). */
  get inboxTtlOn(): boolean {
    return this.inboxEnabled && this.inboxTtl !== undefined;
  }

  /**
   * ADR 0110 amendment, D10a - the clock a message is stamped and aged on: the event store's own
   * (`storeNow`, EventStore SPI 2.4.0; Postgres = database time) when it has one, else the injected
   * runtime clock (a single-process store has only one clock anyway). Sender and judge both read it.
   */
  private async ttlClock(): Promise<number> {
    const storeNow = this.eventStore.storeNow;
    return storeNow === undefined ? this.now() : storeNow.call(this.eventStore);
  }

  /**
   * ADR 0110 amendment, D10a — write the durable row that wakes an expiry pass at `at`. Rounded UP to
   * a whole second so a stream of messages expiring within it shares one pass, and not re-written
   * while this process knows a pending row for the chain. Best effort; never throws.
   */
  private async scheduleInboxExpiry(
    executionId: string,
    chainId: string,
    at: number,
    workflowId?: string
  ): Promise<void> {
    if (this.timerStore === undefined) {
      if (workflowId !== undefined) this.warnNoTimerStore(workflowId, "an inbox message TTL");
      return;
    }
    const wakeAt = Math.max(
      0,
      Math.ceil(at / INBOX_EXPIRY_GRANULARITY_MS) * INBOX_EXPIRY_GRANULARITY_MS
    );
    const pending = this.inboxExpiryRows.get(chainId);
    if (pending !== undefined && pending > this.now() && pending <= wakeAt) return;
    try {
      await this.timerStore.schedule({ executionId, wakeAt });
      rememberBounded(this.inboxExpiryRows, chainId, wakeAt);
    } catch (err) {
      this.onStorageError?.(executionId, err);
    }
  }

  /**
   * ADR 0110 amendment, D10a — one EXPIRY PASS for the chain `executionId` belongs to: journal a
   * discard of every unconsumed message whose topic TTL has run out (`MESSAGE_CONSUMED`, the reserved
   * discard wait, `reason: "expired"`, `sender` = the runtime, so it replays and the fold is
   * unchanged), then arm the next pass. Driven by `TimerService` rows; also callable by a sweep.
   *
   * - The age is read from the store's clock (else the injected one, see `ttlClock`) against the
   *   message's envelope timestamp, here, never in the fold. Per topic only a prefix of the unconsumed messages is expired (see `scanExpired`).
   * - It takes the SAME fenced path as an operator discard (`advanceInbox` under the park's
   *   conditional fence), so it cannot race a delivery: a notifier's batch built from the old cursors
   *   is refused by `staleInboxBatch`, and a delivery that won leaves nothing to expire. A message
   *   delivered before its expiry pass ran was simply delivered in time.
   * - Authorized as the RUNTIME (it is the kernel acting on its own configuration), not as an operator:
   *   no principal, no `ExecutionOp`; the fact's `sender` is {@link INBOX_TTL_ACTOR}.
   * - Bounded per wake: at most {@link INBOX_EXPIRY_BATCH} messages, and when more are due the next
   *   pass is armed for now. Only a PARKED owner accepts the fact: a running one answers
   *   `not-parked` (the caller keeps the row and retries).
   * - Off (`"off"`) unless a TTL is configured with the inbox on.
   */
  async expireInbox(executionId: string): Promise<InboxExpiryResult> {
    return this.sealedOp(
      "discard",
      executionId,
      undefined,
      undefined,
      () => this.expireInboxCore(executionId),
      true
    );
  }

  private async expireInboxCore(executionId: string): Promise<InboxExpiryResult> {
    if (!this.inboxTtlOn) return { status: "off", expired: 0 };
    const head = await this.sendTarget(executionId);
    if (head === null || head.status === "hop-limit") return { status: "closed", expired: 0 };
    const state = await this.foldState(head.id);
    if (
      state === null ||
      state.status === "completed" ||
      state.status === "failed" ||
      state.status === "cancelled"
    ) {
      return { status: "closed", expired: 0 };
    }
    const chainId = chainIdOf(state, head.id);
    const now = await this.ttlClock();
    const scan = await scanExpired(this.eventStore, chainId, cursorsOf(state.variables), {
      from: (this.inboxFloors.get(chainId) ?? -1) + 1,
      now,
      ttlOf: (topic) => ttlOfTopic(this.inboxTtl, topic),
      maxExpired: INBOX_EXPIRY_BATCH,
      topics: await readRegisteredTopics(this.eventStore, chainId),
    });
    // Something this chain's TTL still has to do: a message to expire now, or one to expire later.
    const pending = scan.expired.length > 0 || scan.nextAt !== undefined || scan.more;
    // A running owner cannot take the discard yet (only a PARKED one accepts the fact). The caller
    // keeps the row only when there IS something pending; otherwise there is nothing to wait for.
    if (state.status !== "suspended") return { status: "not-parked", expired: 0, pending };
    // The judge's clock (`now`) is the store's; a row is scheduled on the runtime's, so the delay is
    // carried over (never the absolute instant) and a skewed host cannot make a row due too soon.
    const rearm = async (): Promise<void> => {
      if (scan.more) await this.scheduleInboxExpiry(head.id, chainId, this.now() + 1);
      else if (scan.nextAt !== undefined) {
        await this.scheduleInboxExpiry(
          head.id,
          chainId,
          this.now() + Math.max(1, scan.nextAt - now)
        );
      }
    };
    if (scan.expired.length === 0) {
      await rearm();
      return { status: "done", expired: 0, executionId: head.id, pending };
    }
    const parkSeq = await this.locatePark(head.id, state, { events: undefined, complete: false });
    if (parkSeq === undefined) return { status: "not-parked", expired: 0, pending: true };
    const byTopic = new Map<string, Array<{ key: string; seq: number }>>();
    for (const m of scan.expired) {
      const list = byTopic.get(m.topic) ?? [];
      list.push({ key: m.key, seq: m.seq });
      byTopic.set(m.topic, list);
    }
    const sender = { actor: INBOX_TTL_ACTOR };
    const facts: Array<{ eventType: string; payload: unknown }> = [];
    for (const [topic, list] of byTopic) {
      const through = (list[list.length - 1] as { seq: number }).seq;
      facts.push(
        ...discardFacts(topic, list, through, sender, {
          skipped: list.length,
          reason: "expired",
          expired: true,
        })
      );
    }
    const outcome = await this.advanceInbox(head.id, state, parkSeq, undefined, facts);
    if (outcome === "gone") return { status: "not-parked", expired: 0, pending: true };
    if (outcome === "contended") return { status: "contended", expired: 0, pending: true };
    const after = (await this.foldState(head.id)) ?? state;
    this.inboxFull.delete(chainId);
    this.inboxCounted.delete(chainId);
    this.inboxTrimmed.delete(chainId);
    await this.maybeTrimInbox(chainId, after);
    await rearm();
    return { status: "done", expired: scan.expired.length, executionId: head.id, pending };
  }

  /**
   * ADR 0116 — attach a LATE reward to a decision of a FINISHED execution. A runtime method, not a
   * syscall: it appends the existing `OUTCOME_RECORDED` (with the kernel-stamped `recordedBy` and
   * `late: true`) and changes no state.
   *
   * - Authorized as `ExecutionOp` `"annotate"` against the RECORDED owner, before "not found" or
   *   the execution's state is revealed; under `security.strict` a call with no principal is
   *   refused. A denial appends NOTHING (a caller must not write into someone else's log).
   * - Terminal only (`completed` / `failed` / `cancelled`): a running or parked execution is
   *   refused with {@link ExecutionNotTerminalError}. There is NO fence: `acquireFence`
   *   supersedes the holder, which would kill a live run, and a terminal execution has none.
   *   A `continued` execution is accepted (ADR 0109, 0116 D1): the decision lives in that generation's own log.
   * - Sequence compare-and-set: read the head, fold, validate, append at exactly `head + 1`. A
   *   collision (a concurrent `recordOutcome`, an audit append) re-reads and retries a bounded
   *   number of times, so two identical concurrent calls resolve to one append and one
   *   `{ appended: false }`.
   * - The `decisionId` must be in the fold's `_decisions`. `(decisionId, key)` is idempotent; a
   *   different `success`/`score` for the same pair is refused ({@link OutcomeRefusedError}).
   */
  async recordOutcome(
    executionId: string,
    outcome: RecordOutcomeInput,
    options?: RecordOutcomeOptions
  ): Promise<RecordOutcomeResult> {
    return this.sealedOp("annotate", executionId, options?.principal, options?.system, () =>
      this.recordOutcomeCore(executionId, outcome, options)
    );
  }

  /** `recordOutcome` without the sealed-stream translation (see `sealedOp`). */
  private async recordOutcomeCore(
    executionId: string,
    outcome: RecordOutcomeInput,
    options?: RecordOutcomeOptions
  ): Promise<RecordOutcomeResult> {
    assertNotReserved(executionId);
    // No durable EXECUTION_DENIED on a denial: the log is a finished execution's evidence, and a
    // denied writer must leave it untouched. The audit callback still fires.
    const first = await this.authorizeAtAnchor(
      "annotate",
      executionId,
      options?.principal,
      options?.system
    );
    if (first === undefined) {
      await this.denyMissing("annotate", executionId, options?.principal, options?.system);
      throw new Error(`No execution found for id: ${executionId}`);
    }
    const problem = outcomeShapeProblem(outcome);
    if (problem !== undefined) throw new OutcomeRefusedError(executionId, problem);
    const recordedBy = this.outcomeRecordedBy(options?.principal, options?.system);
    // ADR 0116 amendment — the write is a CONDITIONAL append at the store (SPI 2.2.0): there is
    // no fallback to a plain `append`, because without it a retention delete between the fold and
    // the write leaves an orphan log, and a fence acquired in that window is displaced.
    const store = this.eventStore;
    if (store.appendIfUnchanged === undefined) {
      throw new OutcomeRefusedError(
        executionId,
        "the event store does not implement appendIfUnchanged (EventStore SPI 2.2.0), the atomic conditional append a late outcome needs; upgrade the store or its decorator"
      );
    }
    const missing = () => new Error(`No execution found for id: ${executionId}`);
    for (let attempt = 0; attempt < RECORD_OUTCOME_ATTEMPTS; attempt++) {
      // Observe the tip (head, fence token, creation marker) BEFORE folding: the append below
      // proves none of them moved. No fence rule beyond that: a token acquired after the execution
      // ended is routine (redispatch, timers, recovery), and the one writer a late outcome must
      // not displace, a reopen, retries over it instead (`landReopenBootstrap`).
      const seen = await store.appendIfUnchanged(executionId, null);
      if (seen.appended || seen.head === null) throw missing();
      const state = await this.foldState(executionId);
      if (state === null) throw missing();
      if (
        state.status !== "completed" &&
        state.status !== "failed" &&
        state.status !== "cancelled" &&
        // ADR 0109 / 0116 D1 — a `continued` generation is terminal too: the decision lives in THAT
        // generation's log, so the outcome is attached to the id the caller named, not the head.
        state.status !== "continued"
      ) {
        throw new ExecutionNotTerminalError(executionId, state.status);
      }
      const decisions = state.variables._decisions as Record<string, unknown> | undefined;
      if (decisions === undefined || !Object.hasOwn(decisions, outcome.decisionId)) {
        throw new OutcomeRefusedError(
          executionId,
          `decision "${outcome.decisionId}" was never recorded by this execution`
        );
      }
      const recorded = (state.variables._outcomes as RecordedOutcome[] | undefined) ?? [];
      let prior: RecordedOutcome | undefined;
      let lateCount = 0;
      for (const o of recorded) {
        if (o.late === true) lateCount++;
        if (prior === undefined && o.decisionId === outcome.decisionId && o.key === outcome.key) {
          prior = o;
        }
      }
      if (prior !== undefined) {
        if (prior.success === outcome.success && prior.score === outcome.score) {
          return { appended: false };
        }
        throw new OutcomeRefusedError(
          executionId,
          `(${outcome.decisionId}, ${outcome.key}) already has a different outcome; the log is append-only, record a correction under a new key`
        );
      }
      if (lateCount >= LATE_OUTCOMES_MAX) {
        throw new OutcomeRefusedError(
          executionId,
          `the execution already holds ${LATE_OUTCOMES_MAX} late outcomes (the per-execution cap)`
        );
      }
      // The slot is exactly the next one (SPI 2.2.0: the store refuses any other). A folded
      // sequence ABOVE the stored head means a compaction by a kernel older than ADR 0116 took the
      // tail (terminal event included) off the log: an append there would land under the
      // checkpoint and be invisible to every fold, so it is refused rather than written.
      if (state.sequence > seen.head) {
        // ... unless a writer simply landed between the observation and the fold: re-judge.
        const now = await store.appendIfUnchanged(executionId, null);
        if (now.appended || now.head !== seen.head) continue;
        throw new OutcomeRefusedError(
          executionId,
          `its log was compacted down to sequence ${seen.head} below its checkpoint (${state.sequence}) by a kernel older than ADR 0116, so a late outcome has no valid slot`
        );
      }
      if (typeof seen.anchor !== "string") {
        throw new OutcomeRefusedError(
          executionId,
          "the event store or a decorator dropped the creation anchor appendIfUnchanged must return"
        );
      }
      const sequence = seen.head + 1;
      const envelope: EventEnvelope = {
        id: `${executionId}-${sequence}-outcome`,
        workflowId: first.workflowId,
        executionId,
        eventType: "OUTCOME_RECORDED",
        sequence,
        timestamp: this.now(),
        payload: {
          key: outcome.key,
          ...(outcome.success !== undefined && { success: outcome.success }),
          ...(outcome.score !== undefined && { score: outcome.score }),
          decisionId: outcome.decisionId,
          recordedBy,
          late: true,
        },
        // The stamp the fold requires before it trusts `recordedBy` / `late` (W2-0): only the
        // kernel writes it, and `guardUserspaceEmit` refuses those fields from a flow. No fence
        // token: the store compares the one observed above, it is never presented or adopted.
        metadata: { kernel: true },
      };
      let result: Awaited<ReturnType<NonNullable<typeof store.appendIfUnchanged>>>;
      try {
        result = await store.appendIfUnchanged(executionId, envelope, {
          head: seen.head,
          fence: seen.fence,
          anchor: seen.anchor,
        });
      } catch (err) {
        if (isWriteConflict(err)) continue; // a slot / id race: re-read, re-judge
        throw err;
      }
      if (result.appended) {
        this.onEvent?.(envelope);
        return { appended: true, sequence };
      }
      // `moved` (a writer, a delete-and-recreate or a fence acquire since the observation):
      // re-observe and re-judge. `gone`: the log was deleted under us; nothing was written.
      if (result.reason === "gone") throw missing();
    }
    throw new OutcomeContendedError(executionId);
  }

  /**
   * ADR 0116 — the `recordedBy` of a late outcome: `"system"` for the runtime's own grant, else the
   * caller's identity as the principal record would write it (a codec `ref` when one handles the
   * chain; the verbatim actor otherwise; refused in `ref` mode with no codec, exactly as a start
   * is). Never the delegation token.
   */
  private outcomeRecordedBy(
    principal: PrincipalChain | undefined,
    system: SystemGrant | undefined
  ): string {
    if (system !== undefined && system === this.systemGrantToken) return "system";
    if (principal === undefined) return "anonymous";
    const { delegation: _delegation, ...identityOnly } = principal;
    const record = this.principalRecordFor(identityOnly);
    return record.ref ?? record.identity?.actor ?? "anonymous";
  }

  /**
   * The LIVE handle of an execution this runtime is driving right now, or `undefined`. A read-only
   * lookup (no authorization, no log read): the in-process worker uses it to follow a continued
   * execution to its successor's handle (ADR 0109 D6).
   */
  liveHandle(executionId: string): ExecutionHandle | undefined {
    return this.liveHandles.get(executionId);
  }

  /**
   * {@link liveHandle}, plus the in-flight start of a continuation successor: its sequence 0 is
   * durable BEFORE its handle is registered (`execute` runs after the bootstrap append), and a
   * reader that finds it in that window (`followToHead`) must be able to wait for the handle
   * instead of guessing how many ticks it takes. The pending entry is registered before the
   * successor's sequence 0 can be observed, so a head the log shows always resolves here: to its
   * handle when this runtime drives it, to `undefined` when it does not (driven elsewhere, or
   * already settled).
   *
   * @internal Used only by the in-process worker (`LocalWorkerRuntime`); not part of the public
   * runtime API, not documented in the API reference, and free to change.
   */
  awaitLiveHandle(executionId: string): Promise<ExecutionHandle | undefined> {
    const live = this.liveHandles.get(executionId);
    if (live !== undefined) return Promise.resolve(live);
    return this.startingSuccessors.get(executionId) ?? Promise.resolve(undefined);
  }

  /** Successors whose start is in flight (sequence 0 maybe durable, live handle not yet registered). */
  private readonly startingSuccessors = new Map<string, Promise<ExecutionHandle | undefined>>();

  /** Whether `kernel.features.inbox` is on for this runtime (the `TimerService` leaves inbox rows alone when it is not). */
  get inboxOn(): boolean {
    return this.inboxEnabled;
  }

  /**
   * Does a parked execution have inbox work a notify pass could do: an unanswered inbox wait (a
   * message may be waiting) or an ANSWERED one still parked (a consumption whose resume was lost)?
   * Used by the `TimerService` to decide whether to keep an inbox wake row.
   */
  hasInboxWake(state: ExecutionState): boolean {
    if (state.status !== "suspended") return false;
    const waits = state.suspendedOn?.waits;
    return Array.isArray(waits) && waits.some((w) => w.kind === "inbox");
  }

  /** Is the execution parked on an UNANSWERED inbox wait for `topic` (a message elsewhere wakes nothing)? */
  private parkedOnInbox(state: ExecutionState, topic: string): boolean {
    if (state.status !== "suspended") return false;
    const waits = state.suspendedOn?.waits;
    if (!Array.isArray(waits)) return false;
    const answers = state.variables._waitAnswers as Record<string, unknown> | undefined;
    return waits.some(
      (w) =>
        w.kind === "inbox" &&
        w.topic === topic &&
        !(answers !== undefined && Object.hasOwn(answers, w.waitId))
    );
  }

  /** Has the fleet switched to per-topic writing? Sticky once seen (the switch is one-way). */
  private async fleetSwitched(): Promise<boolean> {
    if (this.inboxLayoutSeen) return true;
    if (await inboxLayoutActive(this.eventStore)) this.inboxLayoutSeen = true;
    return this.inboxLayoutSeen;
  }

  /**
   * Register `topic` as a live topic of the chain before its first message (refusing past
   * `inboxMaxTopics` LIVE topics). The cache only skips the registry append: it can be stale (another
   * node retired the chain, or the topic), which {@link verifyTopicRegistered} repairs after the
   * append. `lenient` returns false on "full" instead of throwing (the dual-write copy).
   */
  private async ensureTopicRegistered(
    executionId: string,
    chainId: string,
    topic: string,
    lenient = false
  ): Promise<boolean> {
    const known = this.inboxKnownTopics.get(chainId);
    if (known?.has(topic) === true) return true;
    const r = await registerInboxTopic(
      this.eventStore,
      chainId,
      topic,
      this.inboxMaxTopics,
      this.now
    );
    if (r === "full") {
      if (lenient) return false;
      throw new InboxMessageRefusedError(
        executionId,
        `the chain already has ${this.inboxMaxTopics} live topics with a stream (inbox.maxTopics); "${topic}" would be one more`
      );
    }
    this.rememberTopic(chainId, topic);
    return true;
  }

  private rememberTopic(chainId: string, topic: string): void {
    const known = this.inboxKnownTopics.get(chainId);
    if (known !== undefined) known.add(topic);
    else rememberBounded(this.inboxKnownTopics, chainId, new Set([topic]));
  }

  /**
   * After a topic-stream append: is the topic still a LIVE registered topic? The registry is the only
   * way the owner (and retirement, and erasure) find the stream, and it can change under a send that
   * trusted a cache or a read: another node retired the chain and deleted it (the chain was then
   * re-opened), or a drained-topic retirement tombstoned the topic. If it is gone, register again (the
   * message is already written, so the cap is not applied: never strand it). Together with the
   * retirer's re-check of the stream this is complete in either interleaving (see `retireInboxTopic`).
   */
  private async verifyTopicRegistered(chainId: string, topic: string): Promise<void> {
    if ((await readRegisteredTopics(this.eventStore, chainId)).includes(topic)) {
      this.rememberTopic(chainId, topic);
      return;
    }
    this.inboxKnownTopics.get(chainId)?.delete(topic);
    await registerInboxTopic(this.eventStore, chainId, topic, Number.MAX_SAFE_INTEGER, this.now);
    this.rememberTopic(chainId, topic);
  }

  /**
   * A topic whose cursor reached its stream's head is drained: stop counting it against
   * `inboxMaxTopics` (a tombstone in the registry; the stream keeps its head entry so the sequence
   * space stays monotone). A later send re-registers it. Best effort.
   */
  private async pruneDrainedTopic(chainId: string, topic: string, cursor: number): Promise<void> {
    const stream = inboxTopicStreamId(chainId, topic);
    const head = await headOf(this.eventStore, stream);
    if (head === null || head > cursor) return;
    const retired = await retireInboxTopic(this.eventStore, chainId, topic, this.now, async () => {
      const now = await headOf(this.eventStore, stream);
      return now !== null && now > cursor;
    });
    if (retired) this.inboxKnownTopics.get(chainId)?.delete(topic);
  }

  /**
   * ADR 0110 amendment, D10b — the FLEET opt-in to per-topic inbox streams. Writes the durable switch
   * once (idempotent; returns whether this call wrote it); from then on every node with
   * `inboxTopicStreams` writes the topic's own stream. Run it ONLY after every node runs a build that
   * reads topic streams and has `inboxTopicStreams` on (see the ADR's operator procedure): a node
   * that still writes the legacy stream after consumers moved on would have its message skipped, and
   * a build older than D10 cannot read a topic stream at all. The switch is one-way and a no-op
   * unless `kernel.features.inboxTopicStreams` is on for this node. Needs a principal (an operator
   * action; recorded in the entry).
   */
  async enableInboxTopicStreams(options: {
    principal: PrincipalChain;
  }): Promise<{ enabled: true; newlyEnabled: boolean }> {
    if (!this.inboxTopicStreamsFlag) {
      throw new Error(
        "runtime.enableInboxTopicStreams needs kernel.features.inboxTopicStreams (and the inbox) on this node: enable it on every node first (ADR 0110 D10b)"
      );
    }
    if (options.principal === undefined) {
      throw new Error(
        "runtime.enableInboxTopicStreams is an operator action and needs an authenticated principal"
      );
    }
    const newlyEnabled = await activateInboxLayout(
      this.eventStore,
      this.now,
      ownerOfChain(options.principal) ?? {}
    );
    this.inboxLayoutSeen = true;
    return { enabled: true, newlyEnabled };
  }

  /**
   * ADR 0110 D1 — backpressure, O(1) on the hot path. The stream's head minus the highest sequence
   * known consumed-and-trimmed (`inboxFloors`) bounds the backlog from above; only when that bound
   * is over `inboxMaxBacklog` does a bounded scan above the floor count the real unconsumed
   * messages. A chain that really IS full is remembered for {@link INBOX_FULL_TTL_MS} (keyed by the
   * head it was full at; a refused send never moves the head), so a flood of refused sends costs
   * one scan per interval, not a fold of the owner and a scan of the backlog per send. The price is
   * that a send right after the owner drains may be refused for up to that interval.
   */
  private async assertInboxHasRoom(
    executionId: string,
    chainId: string,
    /** ADR 0110 D10b: judge THIS topic's own stream (per-topic bounds), not the legacy one. */
    topic?: string
  ): Promise<void> {
    const stream =
      topic === undefined ? inboxStreamId(chainId) : inboxTopicStreamId(chainId, topic);
    // Every per-stream hint is keyed by the stream id; the legacy stream keeps its chain id.
    const key = topic === undefined ? chainId : stream;
    const head = await headOf(this.eventStore, stream);
    if (head === null) return;
    const floor =
      this.inboxFloors.get(key) ?? (topic === undefined ? -1 : INBOX_TOPIC_SEQ_BASE - 1);
    if (head - floor < this.inboxMaxBacklog) return;
    const full = this.inboxFull.get(key);
    if (full !== undefined && full.head === head && this.now() < full.until) {
      throw this.inboxFullError(executionId, full);
    }
    // An exact count is the expensive part (a scan of the retained stream). The last one bounds
    // every later count from above (each send adds one, a consume only subtracts), so a chain whose
    // backlog is far below the cap rescans once per (cap - backlog) sends, not once per send. The
    // retained-entries cap is judged against the same floor, which a scan has just advanced.
    const counted = this.inboxCounted.get(key);
    if (
      counted !== undefined &&
      head >= counted.head &&
      counted.unconsumed + (head - counted.head) < this.inboxMaxBacklog &&
      head - floor < this.inboxMaxRetained &&
      // Past half the retained cap, a chain that has not yet been warned about its pin takes the
      // scan (below), which names the pinning message; once warned it is cheap again.
      (head - floor < this.inboxMaxRetained / 2 || this.inboxWarned.has(key))
    ) {
      return;
    }
    const state = await this.foldState(executionId);
    const exact = await scanInbox(this.eventStore, chainId, cursorsOf(state?.variables ?? {}), {
      from: floor + 1,
      limit: this.inboxMaxBacklog,
      ...(topic !== undefined && { stream }),
    });
    const refuse = (hint: { unconsumed: number; pinnedAt?: number }): never => {
      const entry = { head, until: this.now() + INBOX_FULL_TTL_MS, ...hint };
      rememberBounded(this.inboxFull, key, entry);
      throw this.inboxFullError(executionId, entry);
    };
    if (exact.unconsumed >= this.inboxMaxBacklog) refuse({ unconsumed: exact.unconsumed });
    this.inboxFull.delete(key);
    const newFloor = (exact.oldest ?? head + 1) - 1;
    rememberBounded(this.inboxFloors, key, newFloor);
    rememberBounded(this.inboxCounted, key, { head, unconsumed: exact.unconsumed });
    // A stream retaining half its cap above one unconsumed message is being pinned (a cold topic
    // beside a hot one): say so ONCE, naming it, long before `send` starts refusing (ADR 0110 D1).
    if (head - newFloor >= this.inboxMaxRetained / 2 && exact.oldest !== undefined) {
      if (this.inboxWarned.get(key) !== exact.oldest) {
        rememberBounded(this.inboxWarned, key, exact.oldest);
        this.onWarn(
          `inbox of execution "${executionId}" retains ${head - newFloor} entries (${Math.round(((head - newFloor) / this.inboxMaxRetained) * 100)}% of inboxMaxRetained=${this.inboxMaxRetained}) above its oldest unconsumed message: topic "${exact.oldestTopic ?? "?"}" at inbox sequence ${exact.oldest}, which nothing consumes and which pins every later entry. Once the cap is reached \`send\` refuses. Consume that topic (a flow that never receives it needs a receive for it), or have an operator release it with runtime.discardInbox (ADR 0110).`
        );
      }
    } else {
      this.inboxWarned.delete(key);
    }
    if (head - newFloor >= this.inboxMaxRetained) {
      refuse({
        unconsumed: exact.unconsumed,
        ...(exact.oldest !== undefined && { pinnedAt: exact.oldest }),
      });
    }
  }

  private inboxFullError(
    executionId: string,
    full: { unconsumed: number; pinnedAt?: number }
  ): InboxFullError {
    return new InboxFullError(
      executionId,
      full.unconsumed,
      full.pinnedAt !== undefined
        ? `the inbox retains ${this.inboxMaxRetained}+ entries above its oldest unconsumed message (inbox sequence ${full.pinnedAt}), which nothing consumes and which pins every entry above it (inboxMaxRetained); nothing was appended. Consume that message, or have an operator release it with runtime.discardInbox; then retry.`
        : undefined
    );
  }

  /**
   * ADR 0110 D1 — delete the consumed prefix of the stream, below the oldest UNCONSUMED message
   * (never the head). Best effort and cheap when there is nothing to do: skipped unless a cursor
   * moved past what this process last trimmed, and bounded when it runs (the scan starts at the
   * known floor and stops at the first unconsumed message). Conservative across a continuation: it
   * uses the cursors of the execution in hand, which can only be lower than a successor's carried
   * ones.
   */
  private async maybeTrimInbox(chainId: string, state: ExecutionState): Promise<void> {
    if (!this.inboxEnabled || state.variables._inbox === undefined) return;
    await this.trimQuarantineOf(chainId, state);
    const cursors = cursorsOf(state.variables);
    const max = maxCursor(cursors);
    if (max > (this.inboxTrimmed.get(chainId) ?? -1) + 1) {
      try {
        const floor = this.inboxFloors.get(chainId) ?? -1;
        const through = await trimInbox(this.eventStore, chainId, cursors, floor);
        rememberBounded(this.inboxTrimmed, chainId, through ?? max);
        if (through !== undefined) {
          const next = Math.max(floor, through);
          rememberBounded(this.inboxFloors, chainId, next);
          // The floor passed the message a pin warning named: that pin is gone, re-arm for the next.
          const warnedAt = this.inboxWarned.get(chainId);
          if (warnedAt !== undefined && next >= warnedAt) this.inboxWarned.delete(chainId);
        }
      } catch (err) {
        this.onStorageError?.(chainId, err);
      }
    }
    // ADR 0110 D10b — a topic whose cursor is in the topic range consumes from its OWN stream: trim
    // it up to the cursor (a single-topic stream has no cold neighbour pinning it).
    for (const [topic, cursor] of Object.entries(cursors)) {
      if (typeof cursor !== "number" || cursor < INBOX_TOPIC_SEQ_BASE) continue;
      const stream = inboxTopicStreamId(chainId, topic);
      // A drained topic stops counting against the topic cap (once per cursor value). A HELD topic
      // is not drained (ADR 0130 residuals D9): its registry entry stays live while it holds entries.
      if (
        this.inboxPruned.get(stream) !== cursor &&
        quarantineQueue(state.variables, topic) === undefined
      ) {
        try {
          await this.pruneDrainedTopic(chainId, topic, cursor);
          rememberBounded(this.inboxPruned, stream, cursor);
        } catch (err) {
          this.onStorageError?.(chainId, err);
        }
      }
      if (cursor <= (this.inboxTrimmed.get(stream) ?? INBOX_TOPIC_SEQ_BASE - 1) + 1) continue;
      try {
        const floor = this.inboxFloors.get(stream) ?? INBOX_TOPIC_SEQ_BASE - 1;
        const through = await trimTopicStream(this.eventStore, stream, cursor, floor);
        rememberBounded(this.inboxTrimmed, stream, through ?? cursor);
        if (through !== undefined) {
          const next = Math.max(floor, through);
          rememberBounded(this.inboxFloors, stream, next);
          const warnedAt = this.inboxWarned.get(stream);
          if (warnedAt !== undefined && next >= warnedAt) this.inboxWarned.delete(stream);
        }
      } catch (err) {
        this.onStorageError?.(chainId, err);
      }
    }
  }

  /**
   * ADR 0110 D1 — the chain's head reached a terminal state: nothing can ever consume its inbox, so
   * the stream is deleted with it (the same fact `send` reports as `InboxClosedError`). Runs AFTER
   * the terminal event is durable. A `send` that raced it cannot leave an orphan: `send` re-reads
   * the owner after its append and, seeing a terminal, deletes the stream again and reports the
   * close (see `send`). Best effort; never throws.
   */
  private async retireInbox(chainId: string): Promise<void> {
    if (!this.inboxEnabled) return;
    let topics: string[] = [];
    try {
      // The registry names the topic streams (live or drained): read it before it is deleted, to
      // forget their hints.
      topics = (await inboxStreamsOfChain(this.eventStore, chainId)).topics.map((stream) => stream);
      await deleteInbox(this.eventStore, chainId);
    } catch (err) {
      this.onStorageError?.(chainId, err);
    }
    for (const key of [chainId, ...topics]) {
      this.inboxPruned.delete(key);
      this.inboxFloors.delete(key);
      this.inboxTrimmed.delete(key);
      this.inboxFull.delete(key);
      this.inboxCounted.delete(key);
      this.inboxWarned.delete(key);
    }
    this.inboxKnownTopics.delete(chainId);
  }

  /**
   * ADR 0110 D1 — a terminal execution (completed, failed) is being RE-OPENED (`resume` / `resumeAs`,
   * ADR 0104). Its inbox stream was deleted when it finished, so a message not consumed by then is
   * gone (a `send` after the terminal was refused; one that raced it was reported discarded). A
   * fresh stream would restart at sequence 0 under the cursors the owner's log still holds, and
   * every new message would be skipped as already consumed. So the allocation floor is seeded at the
   * highest cursor, exactly as for a fork: new sends land above it. Best effort and idempotent.
   */
  private async reopenInbox(executionId: string, state: ExecutionState): Promise<void> {
    if (!this.inboxEnabled) return;
    if (state.status !== "completed" && state.status !== "failed") return;
    const cursors = cursorsOf(state.variables);
    if (Object.keys(cursors).length === 0) return;
    try {
      await seedInboxFloors(this.eventStore, chainIdOf(state, executionId), cursors, this.now);
    } catch (err) {
      this.onStorageError?.(executionId, err);
    }
  }

  /**
   * ADR 0110 D1 — reclaim an inbox stream whose owner is terminal: the sweep for the orphan a crash
   * left (a sender appended after the owner's own delete, then died before its re-read). Only a
   * chain whose id IS an execution id can be mapped back to an owner (not a fork's fresh chain).
   * Returns whether it deleted the stream. Never throws.
   */
  async reclaimInbox(streamId: string): Promise<boolean> {
    if (
      !this.inboxEnabled ||
      // ADR 0130 residuals D9: a quarantine stream is one of the chain's reserved streams too
      // (an orphan copy of a terminal owner is reclaimed with the rest of the chain).
      !(streamId.startsWith(INBOX_STREAM_PREFIX) || streamId.startsWith(QUARANTINE_STREAM_PREFIX))
    ) {
      return false;
    }
    // Any of the chain's streams (legacy, a topic's, the registry) names the chain (ADR 0110 D10b).
    const chainId = inboxChainOf(streamId);
    if (chainId === undefined) return false;
    try {
      const head = await this.sendTarget(chainId);

      if (
        head === null ||
        head.chainId !== chainId ||
        (head.status !== "completed" && head.status !== "failed" && head.status !== "cancelled")
      ) {
        return false;
      }
      // The stream the sweep was HANDED is deleted by name: a topic stream the registry does not name
      // (a sender died before registering, the registry was deleted under it) is only findable this
      // way, and reporting `true` for a chain-level delete that never touched it left it behind and
      // was reported again on every pass.
      if (this.eventStore.deleteExecution === undefined) return false;
      const existed = (await headOf(this.eventStore, streamId)) !== null;
      if (existed) await this.eventStore.deleteExecution(streamId);
      // Then the rest of the chain, including any unregistered topic stream (a prefix scan).
      await deleteInbox(this.eventStore, chainId, true);
      return existed;
    } catch (err) {
      this.onStorageError?.(chainId, err);
      return false;
    }
  }

  /** Closure 2 (ADR 0110 D5): the park is durable; read once more and self-resume on a gap arrival. */
  private async afterInboxPark(executionId: string, state: ExecutionState): Promise<void> {
    try {
      const handle = await this.notifyInbox(executionId, { parked: state });
      void handle;
    } catch (err) {
      this.onStorageError?.(executionId, err);
    }
  }

  /** Per inbox-delivery handle: resolves when its atomic batch is durable, rejects when it was lost. */
  private readonly inboxLanded = new WeakMap<ExecutionHandle, Promise<void>>();

  /**
   * The notify pass in flight (or queued) per execution. A follow-up is installed here
   * SYNCHRONOUSLY when it is queued (`started` false until its predecessor settles), so there is
   * never a window with no entry: exactly one pass per execution is in flight, and a caller that
   * arrives before the follow-up starts shares it.
   */
  private readonly notifying = new Map<
    string,
    { pass: Promise<{ handle?: ExecutionHandle; contended: boolean }>; started: boolean }
  >();

  /**
   * ADR 0110 D5 — the notify path: if `executionId` is parked on an inbox wait and a message is
   * waiting past its cursor, journal its consumption and resume it, as ONE fenced answer under
   * `acquireFenceIf` on that park (ADR 0118): a rival notifier cannot also resume it, and a crash
   * between `MESSAGE_CONSUMED` and the resume is healed by the next notify (a park with an
   * already-ANSWERED wait is resumed without a second consumption). Delivers at most ONE message
   * per resume — the resumed run's quiescence commit drains the rest live and knows which waits
   * belong to one `select`. Returns the resumed handle, or `undefined` when there was nothing to
   * do, the park was answered meanwhile, or the fence was contended (the due-now row stays, and
   * `TimerService` retries with backoff). Concurrent calls for one execution in this process
   * share a single pass.
   */
  async notifyInbox(
    executionId: string,
    hint?: { parked?: ExecutionState }
  ): Promise<ExecutionHandle | undefined> {
    return (await this.notifyInboxDetailed(executionId, hint)).handle;
  }

  /** {@link WorkflowRuntime.notifyInbox}, telling "nothing to do" from "contended" (the `TimerService`'s need). */
  async notifyInboxDetailed(
    executionId: string,
    hint?: { parked?: ExecutionState }
  ): Promise<{ handle?: ExecutionHandle; contended: boolean }> {
    return this.sealedOp(
      "resume",
      executionId,
      undefined,
      undefined,
      () => this.notifyInboxDetailedCore(executionId, hint),
      true
    );
  }

  private async notifyInboxDetailedCore(
    executionId: string,
    hint?: { parked?: ExecutionState }
  ): Promise<{ handle?: ExecutionHandle; contended: boolean }> {
    if (!this.inboxEnabled) return { contended: false };
    const running = this.notifying.get(executionId);
    if (running !== undefined) {
      // A follow-up that has not started reads the stream after this caller's append: share it.
      if (!running.started) return running.pass;
      // The pass in flight may have read the stream BEFORE this caller's append (a `send` that
      // lands just after the owner's own post-park read), so its "nothing to do" says nothing
      // about this caller's message. Queue ONE follow-up pass, which starts after this call.
      return this.startNotify(executionId, undefined, running.pass);
    }
    return this.startNotify(executionId, hint);
  }

  private startNotify(
    executionId: string,
    hint: { parked?: ExecutionState } | undefined,
    after?: Promise<unknown>
  ): Promise<{ handle?: ExecutionHandle; contended: boolean }> {
    const entry = {
      pass: undefined as unknown as Promise<{ handle?: ExecutionHandle; contended: boolean }>,
      started: after === undefined,
    };
    const body =
      after === undefined
        ? this.notifyPass(executionId, hint)
        : after
            .then(
              () => undefined,
              () => undefined
            )
            .then(() => {
              entry.started = true;
              return this.notifyPass(executionId, undefined);
            });
    entry.pass = body.finally(() => {
      if (this.notifying.get(executionId) === entry) this.notifying.delete(executionId);
    });
    this.notifying.set(executionId, entry);
    return entry.pass;
  }

  /**
   * One notify pass: up to {@link NOTIFY_ATTEMPTS} attempts. An attempt is retried (from a fresh
   * fold and scan) when its batch lost to something that did NOT answer the park: an ignorable
   * event landing between its fold and its batch (a `TIMER_FIRED`, an app emit, an
   * `EXECUTION_DENIED`), or a fence acquired without an append since the park was written (the
   * documented re-dispatch path), which switches the attempt to the conditional fence. A loss to a
   * rival that DID answer the park is a quiet "lost the race". Out of attempts, the pass reports
   * `contended` so the due-now row stays.
   */
  private async notifyPass(
    executionId: string,
    hint?: { parked?: ExecutionState }
  ): Promise<{ handle?: ExecutionHandle; contended: boolean }> {
    let forceFence = false;
    try {
      for (let attempt = 1; attempt <= NOTIFY_ATTEMPTS; attempt++) {
        const r = await this.notifyAttempt(
          executionId,
          attempt === 1 ? hint : undefined,
          forceFence
        );
        if (r !== RETRY && r !== RETRY_FENCED) return r;
        if (r === RETRY_FENCED) forceFence = true;
      }
    } catch (err) {
      // ADR 0130: a sealed message this node cannot open leaves a durable due-now row (whichever
      // caller got here: the post-park read, a send's wake, a timer poll), so a node that CAN open
      // it picks the message up on its next poll without waiting for a new send. Then it reports.
      if (isSealedUnreadable(err)) {
        try {
          await this.markContended(executionId);
        } catch {
          // a failure writing the row must not mask the typed error
        }
      }
      throw err;
    }
    return this.markContended(executionId);
  }

  /**
   * ADR 0130 D10 - a replay refusal leaves a REFUSAL row stamped with the log head (see
   * `TimerRecord.refused`, an ordinary `wakeAt` of now). A timer-store row only; best effort (a failure to write it must not mask the
   * typed refusal, and the sweep still recovers the execution).
   *
   * `lastRefusalAt` is per process and resets on restart: harmless unless the wall clock goes
   * backwards across the restart (two stamps could then share a `(executionId, wakeAt)` key, and
   * the upsert keeps the max head).
   */
  private lastRefusalAt = 0;

  private async markRefused(executionId: string): Promise<void> {
    if (this.timerStore === undefined) return;
    try {
      const store = this.eventStore;
      let head: number | null | undefined;
      if (store.head !== undefined) head = await store.head(executionId);
      else {
        const all = await store.readFrom(executionId, 0);
        head = all.length === 0 ? null : all[all.length - 1]?.sequence;
      }
      if (head === null || head === undefined) return;
      // Strictly increasing per runtime: two refusals in one millisecond must not share the row key
      // `(executionId, wakeAt)`, or the poll retiring the older row would retire the newer stamp.
      const wakeAt = Math.max(this.now(), this.lastRefusalAt + 1);
      this.lastRefusalAt = wakeAt;
      await this.timerStore.schedule({ executionId, wakeAt, refused: { head } });
    } catch (e) {
      this.onStorageError?.(executionId, e);
    }
  }

  /**
   * Is this node driving `executionId` right now, or starting it (a continuation successor whose
   * sequence 0 is durable but whose handle is not registered yet)? Synchronous, no log read.
   *
   * @internal Used by the `TimerService` wake-row re-drive; not part of the public runtime API.
   */
  drivesLocally(executionId: string): boolean {
    return this.liveHandles.has(executionId) || this.startingSuccessors.has(executionId);
  }

  /**
   * ADR 0130 D11 (S7c) - this runtime's heartbeat keeper, or `undefined` when heartbeat is
   * unwired. The poll and the sweep (`TimerService`, `recoverAbandoned`) claim through it.
   */
  get leaseKeeper(): LeaseKeeper | undefined {
    return this.driverLeases?.keeper;
  }

  /**
   * ADR 0130 D11 (S7c) - take a hold on `executionId`'s heartbeat lease: the claim a driver makes
   * BEFORE it takes the fence. `null` = another live owner holds an unexpired lease (stand down: drive
   * nothing, take no fence). Unwired, always a no-op hold. Holds are reference-counted: the keeper's
   * lease is released when the last hold on the id is, and every run this runtime starts takes its own
   * hold on top of a claimant's. Release the hold in a `finally`.
   */
  async acquireDriverLease(executionId: string): Promise<DriverLease | null> {
    if (this.driverLeases === undefined) return NO_LEASE;
    return this.driverLeases.acquire(executionId);
  }

  /**
   * ADR 0130 D11 - does `executionId` have a sequence 0 (a real stream, as opposed to a ghost lease)?
   * Public so a worker runtime's `allocate` applies the same stand-down rule as `start`.
   *
   * @internal System-only: a kernel-internal helper shared with `@loom/worker-runtime`, NOT public
   * API (ADR 0083) and deliberately absent from the api-reference. Do not build on it.
   */
  async hasSequenceZero(executionId: string): Promise<boolean> {
    return (await readRangeOf(this.eventStore, executionId, 0, 0)).length > 0;
  }

  /**
   * ADR 0130 D11 section 4 step 4 (S7d) - the CONDITIONAL TAKEOVER of a `running` execution: append
   * its `EXECUTION_RECOVERED` marker with `appendIfUnchanged(head, fence, anchor)` BEFORE any fence is
   * acquired, so exactly one contender wins and a driver that appended since `expectHead` (a "dead"
   * one that was alive) makes this lose with nothing written and no token taken. `true` = the marker
   * is durable (resume with `recoveryClaimed`); `false` = lost / gone / the head is not `expectHead`.
   * A store without `appendIfUnchanged` cannot claim: `undefined` (the caller falls back to today's
   * unconditional path).
   *
   * @internal Used by `redriveAbandoned`; not part of the public runtime API.
   */
  async claimRecovery(
    executionId: string,
    workflowId: string,
    expectHead: number
  ): Promise<boolean | undefined> {
    const store = this.eventStore;
    if (store.appendIfUnchanged === undefined) return undefined;
    const seen = await store.appendIfUnchanged(executionId, null);
    if (seen.appended || seen.head === null || seen.head !== expectHead) return false;
    if (typeof seen.anchor !== "string") return undefined; // a decorator dropped the anchor: cannot prove
    const envelope = ExecutionJournal.envelopeAt(
      { executionId, workflowId },
      seen.head + 1,
      EXECUTION_RECOVERED,
      {},
      { now: this.now }
    );
    let result: Awaited<ReturnType<NonNullable<typeof store.appendIfUnchanged>>>;
    try {
      result = await store.appendIfUnchanged(executionId, envelope, {
        head: seen.head,
        fence: seen.fence,
        anchor: seen.anchor,
      });
    } catch (err) {
      if (isWriteConflict(err)) return false; // a slot / id race: someone else appended
      throw err;
    }
    if (!result.appended) return false;
    this.onEvent?.(envelope);
    return true;
  }

  /**
   * The driver's own hold: a stand-down is a {@link LeaseHeldError}, nothing appended, no fence taken.
   * Always EAGER (ADR 0130 D11, S7g): only a fresh `start` and nothing else may lease lazily.
   */
  private async takeDriverLease(executionId: string): Promise<DriverLease> {
    const lease = await this.acquireDriverLease(executionId);
    if (lease === null) throw new LeaseHeldError(executionId);
    return lease;
  }

  /** Stop the heartbeat keeper and release every lease still held (awaited). No-op when unwired. */
  async closeHeartbeat(): Promise<void> {
    await this.driverLeases?.close();
  }

  /** The park is unanswered but could not be answered now: keep (or write) the durable due-now row. */
  private async markContended(executionId: string): Promise<{ contended: true }> {
    if (this.timerStore !== undefined) {
      await this.timerStore
        .schedule({ executionId, wakeAt: INBOX_WAKE_AT })
        .catch((e: unknown) => this.onStorageError?.(executionId, e));
    }
    return { contended: true };
  }

  /** Is `parkSeq` still the execution's UNANSWERED park (a refold, never a hint)? */
  private async parkStillOpen(executionId: string, parkSeq: number): Promise<boolean> {
    const state = await this.foldState(executionId);
    if (state === null || state.status !== "suspended") return false;
    return (
      (await this.locatePark(executionId, state, { events: undefined, complete: false })) ===
      parkSeq
    );
  }

  private async notifyAttempt(
    executionId: string,
    hint: { parked?: ExecutionState } | undefined,
    forceFence: boolean
  ): Promise<
    { handle?: ExecutionHandle; contended: boolean } | typeof RETRY | typeof RETRY_FENCED
  > {
    const none = { contended: false } as const;
    const state = hint?.parked ?? (await this.foldState(executionId));
    if (state === null || state.status !== "suspended") return none;
    const waits = state.suspendedOn?.waits;
    if (!Array.isArray(waits) || waits.length === 0) return none;
    const answers = state.variables._waitAnswers as Record<string, unknown> | undefined;
    const answered = (w: SuspendWait): boolean =>
      answers !== undefined && Object.hasOwn(answers, w.waitId);
    const parkSeq = await this.locatePark(executionId, state, {
      events: undefined,
      complete: false,
    });
    if (parkSeq === undefined) return none;

    let target: SuspendWait | undefined;
    let pre: Array<{ eventType: string; payload: unknown }> = [];
    // The park is still unanswered but the fence is contended: leave the durable row so the
    // TimerService retries with backoff (writing one if this notify had none).
    const contended = (): Promise<{ contended: true }> => this.markContended(executionId);
    // Heal: a wait of THIS park is already answered (the owner or a notifier journaled the
    // consumption and died before the resume): resume it, consuming nothing again.
    target = waits.find((w) => w.kind === "inbox" && answered(w));
    if (target === undefined) {
      const chainId = chainIdOf(state, executionId);
      // Local copies: the scan advances them as it passes duplicates, so a second wait on the same
      // topic starts past what the first already skipped.
      const cursors = { ...cursorsOf(state.variables) };
      const dedupe = (state.variables._inbox as { dedupe?: string[] } | undefined)?.dedupe ?? [];
      // Exactly the fold's window: whatever it still holds is a duplicate (ADR 0110 D6).
      const recent = new Set(dedupe);
      let firstWait: SuspendWait | undefined;
      // ADR 0130 residuals D9: a held topic this node will not lift is passed over (other topics are
      // still scanned); when nothing else is deliverable it is reported as a sealed refusal.
      let heldBlock: QuarantineHeldError | undefined;
      scan: for (const w of waits) {
        if (w.kind !== "inbox" || w.topic === undefined || answered(w)) continue;
        firstWait ??= w;
        if (quarantineQueue(state.variables, w.topic) !== undefined) {
          const d = await this.heldDelivery(executionId, chainId, state, w.topic);
          if (d.kind === "skip") {
            heldBlock ??= d.err;
            continue;
          }
          if (d.kind === "duplicate") {
            // Drop the entry (release, if still held, then a consumption that delivers nothing) in one
            // atomic batch with whatever duplicates the scan already collected, then refold: the topic
            // is open (or holds its next entry) on the next pass.
            if (d.release !== undefined) pre.push(d.release);
            pre.push({
              eventType: "MESSAGE_CONSUMED",
              payload: {
                waitId: w.waitId,
                topic: w.topic,
                messageId: d.key,
                inboxSeq: d.inboxSeq,
                sender: d.sender,
                payload: null,
              },
            });
            const r = await this.advanceInbox(executionId, state, parkSeq, w, pre, true);
            if (r === "contended") return contended();
            if (r === "gone") return none;
            return RETRY;
          }
          if (d.kind === "deliver") {
            // The held message is delivered FIRST, from its copy, at its original `inboxSeq`; an
            // auto-release is the SAME atomic batch (release fact, consumption, then the park's answer).
            if (d.release !== undefined) pre.push(d.release);
            pre.push({
              eventType: "MESSAGE_CONSUMED",
              payload: {
                waitId: w.waitId,
                topic: w.topic,
                messageId: d.key,
                inboxSeq: d.message.inboxSeq,
                sender: d.message.sender,
                payload: d.message.payload,
              },
            });
            target = w;
            break;
          }
        }
        for (;;) {
          const msgs = await this.inboxSource(
            chainId,
            w.topic,
            cursorFor(cursors, w.topic),
            NOTIFY_PAGE
          );
          for (const m of msgs) {
            const key = dedupeKeyOf(m);
            const duplicate = recent.has(key);
            // ADR 0130: refuse a sealed payload this node cannot open BEFORE journaling anything.
            // Throws to the caller (afterInboxPark / TimerService / recoverAbandoned report it);
            // the message and the park are untouched, so a node configured to open it delivers it.
            if (!duplicate) assertDeliverable(executionId, m);
            pre.push({
              eventType: "MESSAGE_CONSUMED",
              payload: {
                waitId: w.waitId,
                topic: w.topic,
                messageId: key,
                inboxSeq: m.inboxSeq,
                sender: m.sender,
                // A duplicate delivers nothing; the fold reads only its cursor and id.
                payload: duplicate ? null : m.payload,
              },
            });
            cursors[w.topic] = Math.max(cursorFor(cursors, w.topic), m.inboxSeq);
            if (!duplicate) {
              recent.add(key);
              target = w;
              break scan;
            }
            if (pre.length >= NOTIFY_BATCH_CAP) {
              // A very long run of duplicates: journal it in chunks (each atomic, fenced on the
              // park) rather than one unbounded batch. The cursors it advances are durable, so a
              // crash resumes the scan from there.
              const r = await this.advanceInbox(executionId, state, parkSeq, w, pre);
              if (r === "contended") return contended();
              if (r === "gone") return none;
              pre = [];
            }
          }
          if (msgs.length < NOTIFY_PAGE) break;
        }
      }
      if (target === undefined) {
        // Nothing deliverable. Duplicates alone are still journaled (under the fence) so their
        // cursor advance is durable and they do not count against the backlog forever.
        if (pre.length > 0 && firstWait !== undefined) {
          const r = await this.advanceInbox(executionId, state, parkSeq, firstWait, pre);
          if (r === "contended") return contended();
        }
        if (heldBlock !== undefined) throw heldBlock;
        return none;
      }
    }

    const useFence = forceFence || (await this.parkWasFenced(executionId, parkSeq));
    try {
      const handle = await this.resumeCore(
        executionId,
        { eventType: INBOX_DELIVERY, waitId: target.waitId, payload: null },
        {
          // Only a FENCED execution is answered under a conditional fence (see `parkWasFenced`).
          ...(useFence && { fenceIfParkedAt: parkSeq }),
          ...this.systemOptions(),
        },
        { pre }
      );
      // `resumeCore` returns its handle BEFORE the batch is written. Report a handle only once
      // the append LANDED; a lost batch throws here and is classified below.
      await this.inboxLanded.get(handle);
      return { handle, contended: false };
    } catch (err) {
      if (err instanceof ResumeRefusedError) return none; // answered meanwhile / settled
      if (err instanceof ResumeContendedError) return contended();
      // ADR 0130 D11: another live owner holds the lease - stand down, leave the durable row.
      if (err instanceof LeaseHeldError) return contended();
      if (err instanceof StaleInboxBatch) return RETRY; // a cursor moved under the scan: refold
      const cause = err instanceof StorageWriteError ? err.cause : err;
      // The park was written unfenced but a fence has been acquired since (without an append):
      // the unfenced batch carried no token. Answer under the conditional fence instead.
      if (isStaleFence(cause) && !useFence) return RETRY_FENCED;
      if (isWriteConflict(cause) || isStaleFence(cause)) {
        // Lost the slot or the fence. A rival that answered the park won (quiet, nothing to do:
        // its resume drains the rest); anything else only moved the tip: refold and retry.
        return (await this.parkStillOpen(executionId, parkSeq)) ? RETRY : none;
      }
      throw err;
    }
  }

  /**
   * Was the park at `parkSeq` written under a fencing token? A fencing store refuses an append with
   * NO token once ANY token has been acquired for the execution, so a deployment that never fences
   * (its parks carry no token) must not be pushed into fencing by the first inbox delivery: every
   * later plain `resume` / `resumeAs` / recovery of that execution would then be refused as a stale
   * fence. A fenced execution (its park carries a token) is answered under `acquireFenceIf`, as
   * ADR 0118 asks; an unfenced one is answered like any unfenced resume, and a rival notifier loses
   * at the store's `(executionId, sequence)` uniqueness (the atomic batch lands whole or not at all).
   */
  private async parkWasFenced(executionId: string, parkSeq: number): Promise<boolean> {
    const park = (await readRangeOf(this.eventStore, executionId, parkSeq, parkSeq))[0];
    return typeof park?.metadata?.fence === "number";
  }

  /**
   * Journal `MESSAGE_CONSUMED` facts for DUPLICATES ONLY, with no resume: under the conditional
   * fence on the park at `parkSeq`, as one atomic batch. The events are ignorable for the fence
   * (`EVENT_KIND_CLASS`), so the park stays unanswered and a later delivery still resumes it.
   */
  private async advanceInbox(
    executionId: string,
    state: ExecutionState,
    parkSeq: number,
    /** The wait whose resume this stands in for; `undefined` for an operator discard (no wait). */
    wait: SuspendWait | undefined,
    pre: ReadonlyArray<{ eventType: string; payload: unknown }>,
    /**
     * ADR 0130 residuals D9 - judge the batch against the state it will land on (`staleInboxBatch`)
     * and answer `"stale"` instead of writing it. The quarantine/release verbs pass `true`; the
     * discard and duplicate-advance callers leave it off and are byte-identical to before.
     */
    guard = false
  ): Promise<"ok" | "contended" | "gone" | "stale"> {
    let fenced = await this.parkWasFenced(executionId, parkSeq);
    for (let attempt = 1; attempt <= NOTIFY_ATTEMPTS; attempt++) {
      try {
        const got = fenced
          ? await this.acquireFenceIfParked(
              executionId,
              {
                eventType: INBOX_DELIVERY,
                ...(wait !== undefined && { waitId: wait.waitId }),
                payload: null,
              },
              parkSeq,
              this.systemOptions().system,
              { vm: new ReplayVM([], state), events: undefined },
              true,
              wait === undefined
            )
          : {
              fence: undefined,
              // Whatever was appended since `state` (an earlier chunk of this very scan, an app
              // emit, a timer fire): fold it in, or the batch lands at a stale sequence.
              vm: await (async () => {
                const tail = await this.eventStore.readFrom(executionId, state.sequence + 1);
                return tail.length === 0 ? new ReplayVM([], state) : new ReplayVM(tail, state);
              })(),
            };
        if (guard && staleInboxBatch(got.vm.getState(), pre)) return "stale";
        const journal = new ExecutionJournal(
          this.eventStore,
          { executionId, workflowId: state.workflowId },
          got.vm,
          this.onEvent,
          () => undefined,
          undefined,
          got.fence,
          this.now
        );
        journal.commitAtomic(
          pre.map((e) => ({ eventType: e.eventType, payload: e.payload })),
          { deferOnEvent: true }
        );
        await journal.drain();
        return "ok";
      } catch (err) {
        if (err instanceof ResumeRefusedError) return "gone";
        if (err instanceof ResumeContendedError) return "contended";
        const cause = err instanceof StorageWriteError ? err.cause : err;
        if (isStaleFence(cause) && !fenced) {
          fenced = true; // a fence was acquired since the park: answer under the conditional one
          continue;
        }
        if (isWriteConflict(cause) || isStaleFence(cause)) {
          if (!(await this.parkStillOpen(executionId, parkSeq))) return "gone";
          continue;
        }
        throw err;
      }
    }
    return "contended";
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
    return this.sealedOp("resume", executionId, options.principal, options.system, () =>
      this.resumeAsCore(executionId, newFlowId, resumeEvent, options)
    );
  }

  private async resumeAsCore(
    executionId: string,
    newFlowId: string,
    resumeEvent: ResumeEvent,
    options: Parameters<WorkflowRuntime["resumeAs"]>[3]
  ): Promise<ExecutionHandle> {
    // Before any read or append (see `start`): an invalid budget must leave the log untouched.
    assertValidBudget("deadlineMs", options.deadlineMs, "resumeAs options");
    assertNotReserved(executionId);
    // C.1 — the verdict comes FIRST, from sequence 0 alone: everything below (the full read, the
    // fold, the flow lookup, the caller's `transformState` run over the RECORDED INPUT, the status
    // and orphan checks) would otherwise answer, or hand execution data to, a caller the authorizer
    // refuses. A write op: the audit fact goes at the folded tip, found only after the verdict.
    const gated = await this.authzVerdictAtAnchor(
      "resume",
      executionId,
      options.principal,
      options.system
    );
    if (gated?.denial !== undefined) {
      await this.denyOp(
        "resume",
        executionId,
        gated.workflowId,
        options.principal,
        gated.denial.reason,
        await this.denialTipOf(executionId)
      );
    }
    // No sequence 0 at the gate: a read error for this "missing" id reads as not found (see `resume`).
    let allEvents: EventEnvelope[];
    try {
      allEvents = await this.eventStore.read(executionId);
    } catch (err) {
      if (gated?.missing !== true) throw err;
      allEvents = [];
    }
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
    const toHash = this.recordedHashOf(newFlowId);

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
      const orphaned = orphanedFrames(
        Object.keys(state.frames),
        target.definition.steps.map((s) => s.id),
        target.definition.stepFamilies
      );
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
    // (Reached above from sequence 0; repeated here only for a start that raced that read.)
    if (gated?.missing === true) {
      const resumeDenial = this.authzDenial(
        "resume",
        executionId,
        workflowId,
        options.principal,
        options.system,
        await this.ownerForAuthz("resume", executionId, options.principal, options.system, {
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

    // ADR 0130 D11 (S7c) - lease BEFORE the fence and the first append; a stand-down takes no fence.
    const lease = await this.takeDriverLease(executionId);
    try {
      await this.reopenInbox(executionId, state); // after every refusal (see `resume`)
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
      const bootstrap: BootstrapEvent[] = [
        ...(approval !== undefined ? [approval] : []),
        ...discardEvents,
        {
          eventType: "EXECUTION_MIGRATED",
          payload: {
            toFlowId: newFlowId,
            strategy: options.strategy,
            ...(toHash !== undefined && { toHash }),
            // ADR 0113 D2 — re-arm the body-fingerprint comparison against the code now run ("" = none).
            toCodeHash: target.definition.codeFingerprint ?? "",
            ...(typeof recorded === "string" && { fromHash: recorded }),
            ...(stateMigrated && { migratedInput }),
          },
        },
        { eventType: resumeEvent.eventType, payload: resumePayload },
        ...answerEvents(runVm.getState(), resumePayload),
      ];
      return this.execute(
        executionId,
        workflowId,
        runVm,
        target.runner as FlowRunner<unknown, unknown>,
        stateMigrated ? migratedInput : recordedInput,
        this.isReopen(runVm)
          ? await this.landReopenBootstrap(executionId, workflowId, runVm, bootstrap, fence, lease)
          : bootstrap,
        fence,
        options.deadlineMs ?? target.definition.deadlineMs,
        acting,
        false,
        lease
      );
    } catch (err) {
      await lease.release();
      throw err;
    }
  }

  /**
   * ADR 0113 (R7 fix round 1) — re-run an execution a `divergence: "fail"` refusal PARKED on the
   * reserved gate, after the code was fixed, pinned (`registerFlow` the original), listed in
   * `compatibleWith`, or migrated. It is `resume` addressed at that gate: the same authorization,
   * identity and fencing checks apply (`options` are `resume`'s), and the answer is status-only. A
   * re-run that still diverges parks again, once per call; an execution not parked there is
   * refused (`gate-mismatch` / `not-suspended`).
   */
  retryDiverged(executionId: string, options?: RunOptions): Promise<ExecutionHandle> {
    return this.resume(executionId, { eventType: FLOW_DIVERGED_GATE, payload: null }, options);
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
    return this.sealedOp(
      "query",
      executionId,
      options?.principal,
      options?.system,
      () => this.loadStateCore(executionId, options),
      true
    );
  }

  /** `loadState` without the sealed-stream translation (see `sealedOp`). */
  private async loadStateCore(
    executionId: string,
    options?: { principal?: PrincipalChain; system?: SystemGrant }
  ): Promise<ExecutionState | null> {
    // C.1 — gate the query FIRST, from sequence 0 alone. Folding has no side effects, but it CAN
    // THROW (PayloadShreddedError, a bad or foreign checkpoint, ...): authorizing after it told a
    // caller the authorizer refuses that the execution exists and what became of it. A denial
    // writes nothing (a read must never write). Kernel-internal callers use `foldState` and bypass
    // this.
    const verdict = await this.authzVerdictAtAnchor(
      "query",
      executionId,
      options?.principal,
      options?.system
    );
    if (verdict?.denial !== undefined) {
      throw new ExecutionDeniedError("query", executionId, verdict.denial.reason);
    }
    let state: ExecutionState | null;
    try {
      state = await this.foldState(executionId, undefined, verdict?.first);
    } catch (err) {
      // No sequence 0 at the gate: this id is "missing" to the authorizer, so whatever the fold
      // raises for it (an ORPHAN checkpoint a sweep left behind: a foreign identity, a key-unavailable
      // load) must not tell a caller the id once existed. It reads as not found. A caller the
      // authorizer is not consulted for (the kernel's system grant) keeps the real error.
      if (verdict?.missing !== true) throw err;
      state = null;
    }
    if (state === null) {
      await this.denyMissing("query", executionId, options?.principal, options?.system);
      return null;
    }
    // No sequence 0 at the gate but the fold found a state (a start racing the read): judge it
    // now, against the folded workflow id, as this path always did.
    if (verdict?.missing === true) {
      const denial = this.authzDenial(
        "query",
        executionId,
        state.workflowId,
        options?.principal,
        options?.system,
        await this.ownerForAuthz("query", executionId, options?.principal, options?.system)
      );
      if (denial !== undefined) {
        throw new ExecutionDeniedError("query", executionId, denial.reason);
      }
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
  private async foldState(
    executionId: string,
    /** ADR 0130 D9 / S5b: the quarantine verb folding for an operator; see {@link foldFromCompleteLog}. */
    logFoldFor?: QuarantineVerb,
    /**
     * Sequence 0, when the caller already read it (the authorizer's anchor): spares the existence
     * point read on the snapshot path. `undefined` = read it here, as always.
     */
    knownAnchor?: EventEnvelope
  ): Promise<ExecutionState | null> {
    // ADR 0107 — `""` is no execution, whatever a pre-0106 bug left in its stream.
    if (executionId === "") return null;
    let snapshot: Awaited<ReturnType<SnapshotStore["loadLatest"]>>;
    try {
      snapshot = await this.snapshotStore.loadLatest(executionId);
    } catch (err) {
      // S5b: ONLY the operator verbs (`logFoldFor`) and ONLY the sealed-refusal class fall back; the
      // general fold keeps refusing (D7). A shredded subject's erasure error is not this class.
      if (logFoldFor === undefined || !(err instanceof SealedStreamUnreadableError)) throw err;
      return this.foldFromCompleteLog(executionId, err, logFoldFor);
    }
    // S5b: the operator verbs read the log (tail or whole) through the quarantine view, so a seal the
    // view steps over (a `MESSAGE_CONSUMED.payload`) never refuses the plaintext-snapshot and
    // no-snapshot paths either. Every other caller keeps the strict guarded store.
    const reads: QuarantineEventReader = this.quarantineReadsFor(logFoldFor);
    if (snapshot !== null) {
      // Confirm the execution still exists before trusting the snapshot (orphan case
      // above). One row, not the log.
      const anchor =
        knownAnchor !== undefined
          ? [knownAnchor]
          : await readRangeOf(this.eventStore, executionId, 0, 0);
      if (anchor.length === 0) return null;
      const tail = await reads.readFrom(executionId, snapshot.sequence + 1);
      const folded = new ReplayVM(
        tail,
        this.seedOf(snapshot, executionId, anchor[0]!.workflowId)
      ).getState();
      return logFoldFor !== undefined && readLeftOpaque(tail)
        ? this.transientQuarantineFold(executionId, folded)
        : folded;
    }
    // No snapshot: the log IS the bounded read (it is shorter than `snapshotEvery`, or
    // snapshots are off), and it answers existence itself — no extra round-trip. Same
    // query count as before on this path.
    const allEvents = await reads.read(executionId);
    if (allEvents.length === 0) {
      return null;
    }
    const workflowId = allEvents[0]!.workflowId;
    const flow = this.flows.get(workflowId);
    const folded = new ReplayVM(allEvents, {
      executionId,
      workflowId,
      workflowVersion: flow?.definition.version ?? "",
    }).getState();
    return logFoldFor !== undefined && readLeftOpaque(allEvents)
      ? this.transientQuarantineFold(executionId, folded)
      : folded;
  }

  /**
   * Brand a state folded past sealed payloads (the only minting site). Erasure first: a log or
   * checkpoint that records a crypto-shred (`variables._shredded`, folded from `PAYLOAD_SHREDDED`) is
   * never folded for a verb, whatever node asks: the same erasure error the strict path raises.
   */
  private transientQuarantineFold(executionId: string, state: ExecutionState): ExecutionState {
    const shredded = (state.variables as { _shredded?: { subjectId?: unknown } })._shredded;
    if (shredded !== undefined) {
      const subjectId = typeof shredded.subjectId === "string" ? shredded.subjectId : undefined;
      throw Object.assign(
        new Error(
          `execution "${executionId}" was crypto-shredded (PAYLOAD_SHREDDED in its log${subjectId !== undefined ? ` for subject "${subjectId}"` : ""})`
        ),
        { name: "PayloadShreddedError", subjectId, executionId }
      );
    }
    // TRANSIENT: may hold ciphertext where a real fold holds values; it only decides the verb.
    return markTransientFold(state);
  }

  /**
   * ADR 0130 D9 / S5b - the quarantine verbs' owner fold on a node that cannot open the sealed
   * checkpoint: fold the owner from sequence 0 of the LOG. Used ONLY by `quarantineInbox` /
   * `releaseInbox` (never replay, resume, `loadState` or `send`, which keep refusing per D7), and
   * only after the caller was authorized against the plaintext recorded owner.
   *
   * The log fold is exact only when the log is COMPLETE: contiguous from sequence 0 AND reaching the
   * checkpoint's own sequence. Compaction (`truncatePrefix[Keeping]`) always deletes sequence 1, so a
   * compacted log has a gap after 0 - unless it was compacted to the tip, leaving `[0]` with the
   * checkpoint ABOVE it, which the checkpoint's sequence (read through `loadLatestSealed`, the
   * at-rest form: no plaintext, no key) exposes. A log this node cannot read either (its envelopes
   * carry a seal marker it cannot open) rethrows the log's own ordinary denial. An incomplete log is
   * the typed, operator-actionable `InboxQuarantineRefusedError` (`checkpoint-unreadable-log-compacted`).
   * Cost: ONE full-log read per call (the verb folds up to three times); operator verbs are rare,
   * and a log too long to fold is exactly the one that should run on a capable node.
   */
  private async foldFromCompleteLog(
    executionId: string,
    refusal: SealedStreamUnreadableError,
    verb: QuarantineVerb
  ): Promise<ExecutionState | null> {
    // User ruling 2026-10-14: read PAST a seal that covers only `MESSAGE_CONSUMED.payload` (kept as an
    // opaque ciphertext value, never decrypted); any other covered field is still the D7 refusal.
    const events = await this.quarantineReadsFor(verb).read(executionId);
    if (events.length === 0) return null;
    // The checkpoint's sequence from the at-rest form (no key, no plaintext). The refusal's own
    // `sequence` is trusted ONLY when it came from the checkpoint: a key-unavailable load's erasure
    // probe reads the LOG, and its refusal then names a LOG event's sequence, not the checkpoint's.
    let checkpointSeq = (await this.snapshotStore.loadLatestSealed?.(executionId))?.sequence;
    if (checkpointSeq === undefined) {
      const detail = sealedDetailOf(refusal);
      if (detail?.checkpoint === true) checkpointSeq = detail.sequence;
    }
    const tip = events.length - 1;
    let complete = events.every((e, i) => e.sequence === i);
    // A checkpoint above the log's tip means the log was compacted to the tip; with its sequence
    // unknowable, a log of just `[0]` is not provably complete either.
    if (checkpointSeq !== undefined ? tip < checkpointSeq : tip < 1) complete = false;
    if (!complete) {
      throw new InboxQuarantineRefusedError(
        executionId,
        "checkpoint-unreadable-log-compacted",
        "this node cannot open the sealed checkpoint and the log was compacted, so the owner cannot be folded from the log here. Run the verb on a capable node (one holding the owner's key).",
        verb
      );
    }
    const workflowId = events[0]!.workflowId;
    return this.transientQuarantineFold(
      executionId,
      new ReplayVM(events, {
        executionId,
        workflowId,
        workflowVersion: this.flows.get(workflowId)?.definition.version ?? "",
      }).getState()
    );
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
    return this.sealedOp("query", parentExecutionId, opts?.principal, opts?.system, () =>
      this.forkCore(parentExecutionId, atSequence, opts)
    );
  }

  private async forkCore(
    parentExecutionId: string,
    atSequence: number,
    opts?: ForkOptions
  ): Promise<ForkResult> {
    // The tip, without materializing the log to find it. `fork()` used to `read()` the whole
    // parent just to learn how long it was — on a long-lived parent that is the dominant cost
    // of a fork, and it was paid even when the store could copy the prefix natively.
    assertNotReserved(parentExecutionId);
    const childId = opts?.executionId ?? ulid();
    // R3 — a fork READS the parent (its whole prefix, input included) and CREATES an execution,
    // so it is gated as `query` on the parent and `start` on the child, before anything is read
    // beyond sequence 0 or written. Both used to be skipped. Sequence 0 only (see `readAnchor`): an
    // unreadable one still EXISTS and is judged with an unknown owner.
    if (this.authzApplies(opts?.principal, opts?.system)) {
      const anchor = await this.readAnchor("query", parentExecutionId);
      const parentWorkflowId = anchor.workflowId || undefined;
      if (parentWorkflowId === undefined && !anchor.unreadable) {
        await this.denyMissing("query", parentExecutionId, opts?.principal, opts?.system);
      } else {
        const parentOwner = anchor.unreadable
          ? await this.ownerForAuthz("query", parentExecutionId, opts?.principal, opts?.system)
          : await this.ownerForAuthz("query", parentExecutionId, opts?.principal, opts?.system, {
              first: anchor.first,
            });
        const queryDenial = this.authzDenial(
          "query",
          parentExecutionId,
          anchor.workflowId,
          opts?.principal,
          opts?.system,
          parentOwner
        );
        if (queryDenial !== undefined) {
          await this.denyOp(
            "query",
            parentExecutionId,
            anchor.workflowId,
            opts?.principal,
            queryDenial.reason,
            undefined
          );
        }
        const startDenial = this.authzDenial(
          "start",
          childId,
          anchor.workflowId,
          opts?.principal,
          opts?.system
        );
        if (startDenial !== undefined) {
          await this.denyOp(
            "start",
            childId,
            anchor.workflowId,
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
            anchor.workflowId,
            opts?.principal,
            opts?.system,
            parentOwner
          );
          if (ownerDenial !== undefined) {
            await this.denyOp(
              "actAsOwner",
              parentExecutionId,
              anchor.workflowId,
              opts?.principal,
              ownerDenial.reason,
              undefined
            );
          }
        }
        // An AUTHORIZED caller (every verdict above passed, e.g. `unknownOwner: "allow"`) whose
        // anchor was unreadable gets the very error it got before the authorizer moved first.
        if (anchor.unreadable) await readRangeOf(this.eventStore, parentExecutionId, 0, 0);
      }
    }
    if (opts?.executionId !== undefined) await this.assertCreatable(opts.executionId);
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
    let base = await this.snapshotStore.loadLatestBefore(parentExecutionId, atSequence);
    // ADR 0109 D7 — a fork of a CHAIN MEMBER (its folded `_chain` names a chain) leaves the chain: it
    // gets a fresh chain (`forkChain`: its own id, generation 0), ignores `continuedFrom`, and so is
    // never a second reader of the owner's inbox and inherits no carried cursors, dedupe window or
    // deadline. Its state is folded from the RESTAMPED prefix from sequence 0 (a snapshot of the
    // parent carries the seeded carry the fork must not have). Non-members pay nothing extra: the
    // snapshot's fold answers "is it a member" with no read, and with no snapshot the window starts
    // at sequence 0 anyway.
    let leavesChain = base !== null && base.state.variables._chain !== undefined;
    if (leavesChain) base = null;
    if (atSequence > tip && base?.sequence !== atSequence) {
      const latest = await this.snapshotStore.loadLatest(parentExecutionId);
      if (atSequence > Math.max(tip, latest?.sequence ?? tip)) throw await outOfRange();
    }

    // Only two things need the parent's events: folding the state at the fork point (which
    // starts from the nearest snapshot at/below it, so usually a short tail), and the copy
    // itself when the store cannot do it natively — or when live projections have to see the
    // copied prefix. Read the WIDER of those windows once, never the whole log, and never
    // anything above the fork point.
    const needsPrefix =
      leavesChain || this.eventStore.copyPrefix === undefined || this.onEvent !== undefined;
    const from = needsPrefix || base === null ? 0 : base.sequence + 1;
    const window = await readRangeOf(this.eventStore, parentExecutionId, from, atSequence);
    if (!leavesChain && from === 0 && window[0]?.sequence === 0) {
      const head = window[0];
      leavesChain =
        head.metadata?.forkChain !== undefined ||
        chainOfFirstEnvelope(head, parentExecutionId).chainId !== parentExecutionId ||
        (head.payload as { continuedFrom?: unknown } | null)?.continuedFrom !== undefined;
    }
    // ADR 0109 D7 — a fork point at or after the parent's EXECUTION_CONTINUED would fold the fork to
    // `continued` pointing at the REAL successor. Refused, naming it (fork the successor instead),
    // from what the fork already reads: the window, or the snapshot's fold. Nothing is written yet.
    const continuedEvent = window.find(
      (e) => e.eventType === "EXECUTION_CONTINUED" && e.metadata?.kernel === true
    );
    if (continuedEvent !== undefined || base?.state.status === "continued") {
      const to =
        continuedEvent !== undefined
          ? (continuedEvent.payload as { successorId?: unknown } | null)?.successorId
          : base?.state.variables._continuedTo;
      throw new ForkPastContinuationError(
        parentExecutionId,
        atSequence,
        continuedEvent?.sequence,
        typeof to === "string" && to.length > 0 ? to : undefined
      );
    }
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

    // The copy merges this into every copied envelope's metadata. An override therefore lands on
    // sequence 0 — the anchor `placementOf` reads — as well as on the rest of the prefix, which is
    // harmless: metadata is operational, and the one key the fold reads (`flowEmit`, ADR 0102) is
    // preserved by the merge — which is what lets a forked child serve its inherited emits instead
    // of re-appending them. Built before the state is materialized so a fork that leaves its chain
    // (ADR 0109 D7) folds its state from the RESTAMPED prefix.
    const forkMeta = {
      forkedFrom: parentExecutionId,
      forkSequence: atSequence,
      ...(leavesChain && { forkChain: { chainId: childId, generation: 0 } }),
      ...(opts?.computeTarget !== undefined && { [COMPUTE_TARGET_KEY]: opts.computeTarget }),
      ...(forkedBy !== undefined ? { forkedBy } : { forkActAs: "owner" }),
    };
    const restamp = (e: EventEnvelope): EventEnvelope => ({
      ...e,
      executionId: childId,
      id: `${childId}-${e.sequence}`,
      metadata: { ...e.metadata, ...forkMeta },
    });

    // 1. Materialize state at the fork point (reusing the nearest prior snapshot).
    const materialized = this.materializeStateAt(
      base,
      atSequence,
      leavesChain ? window.map(restamp) : window,
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
    // ADR 0110 — the fork inherits the parent's per-topic cursors through the copied
    // `MESSAGE_CONSUMED` prefix, but its inbox stream (keyed by the fork's own chain) is empty. Seed
    // the stream's allocation above every inherited cursor BEFORE the child exists, so a `send` to
    // it can never land at a sequence the cursors already passed (it would be skipped forever and
    // trimmed). Replay of the copied prefix is untouched: the cursors stay what the fold computed.
    // The child's quarantine stream, once written: removed again if the fork fails before it exists.
    let childQuarantine: string | undefined;
    try {
      if (this.inboxEnabled) {
        // ADR 0130 residuals D9 - the fork's folded `_quarantined` names copies in the PARENT chain's
        // quarantine stream; the fork is a fresh chain, so the referenced prefix is copied (same
        // sequence numbers, so `heldAt` stays valid) or the fork is refused BEFORE anything is
        // written, never left with dangling holds.
        const held = Object.values(quarantineQueues(forkState.variables)).flat();
        if (held.length > 0) {
          const childChainId = chainIdOf(forkState, childId);
          if (await this.copyQuarantineForFork(parentExecutionId, childChainId, held)) {
            childQuarantine = quarantineStreamId(childChainId);
          }
        }
        // (ADR 0110 D10b: the legacy stream at the highest legacy cursor, each topic stream at its own.)
        const inherited = cursorsOf(forkState.variables);
        if (Object.keys(inherited).length > 0) {
          await seedInboxFloors(
            this.eventStore,
            chainIdOf(forkState, childId),
            inherited,
            this.now
          );
        }
      }

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
    } catch (err) {
      // A failed fork must not strand the child's quarantine copies: nothing references that stream
      // (the child never existed, so the reclaim sweep cannot find it either).
      if (childQuarantine !== undefined) {
        await this.eventStore.deleteExecution?.(childQuarantine).catch(() => undefined);
      }
      throw err;
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
    try {
      await this.snapshotStore.save(seed);
    } catch (err: unknown) {
      // ADR 0130 D8: the seed is an optimisation (resume folds the copied prefix without it), so a
      // refused plaintext checkpoint skips it instead of failing a fork whose child already exists.
      if (!(err instanceof PlaintextCheckpointError)) throw err;
      this.reportCheckpointError(childId, err);
    }

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

  // ── ADR 0109 — continue-as-new: chain identity, head resolution, the successor start ────────

  /** ADR 0109 D3 — the carry is the successor's `input`: `validateInput` applies (K11.5 contract). */
  private validateCarry(workflowId: string, executionId: string, carry: unknown): unknown {
    const definition = this.flows.get(workflowId)?.definition;
    if (!this.validateInput || definition?.inputSchema === undefined) return carry;
    const parsed = definition.inputSchema.safeParse(carry);
    if (!parsed.success) {
      throw new InputValidationError(
        definition.id,
        executionId,
        `the continueAsNew carry: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ")}`
      );
    }
    return parsed.data;
  }

  /**
   * ADR 0110 D10b — a caller-chosen id ending `#<16 hex digits>` or `#reg` would, as a chain id, alias
   * a topic or registry stream of ANOTHER chain (`__loom_inbox__:<x>#<hash>`): refused once the inbox
   * is on, as the `<x>~<digits>` successor shape is. A minted ulid cannot have it.
   */
  private assertNotInboxStreamShaped(executionId: string): void {
    if (this.inboxEnabled && hasInboxStreamShape(executionId)) {
      throw new Error(
        `executionId "${executionId}" is reserved: with the inbox on, an id ending in "#" plus 16 hex digits (or "#reg") would alias a per-topic inbox stream of another chain (ADR 0110 D10b)`
      );
    }
  }

  /**
   * Creation-time id check (ADR 0109 D2 (a)): everything `assertNotReserved` refuses, plus the
   * SUCCESSOR SHAPE (`<x>~<digits>`):
   *  - on the LAST `::` segment (`a~1`, `parent::g#0~1`: the next generation of a chain, derived or
   *    not) it is refused for every caller, trusted or not, existing log or not;
   *  - only on the ROOT segment (`chain~1::g#0`, a supervised child of a generation) it is accepted
   *    solely for a TRUSTED caller (the supervisor's lineage grant, or the system grant) and only
   *    when the derived parent's log exists.
   * An untrusted caller never causes a read, so the refusal is the same whether or not the parent
   * exists (no existence oracle). The kernel's own continuation start never comes through here.
   */
  private async assertCreatable(executionId: string, trusted = false): Promise<void> {
    assertNotReserved(executionId);
    this.assertNotInboxStreamShaped(executionId);
    const shape = successorShapeOf(executionId);
    if (shape === "none") return;
    if (shape === "derived" && trusted) {
      const parent = derivedParentOf(executionId);
      if (parent !== undefined && parent.length > 0) {
        const first = (await readRangeOf(this.eventStore, parent, 0, 0))[0];
        if (first !== undefined) return;
      }
    }
    throw new ReservedSuccessorIdError(executionId);
  }

  /**
   * The id of `id`'s started successor, if one exists: `<chainId>~<generation+1>`, accepted only when
   * its sequence 0 says it continued from `id` (ADR 0109 D2/D4). One point read. This is how the
   * START-TO-COMMIT window is bridged: until `EXECUTION_CONTINUED` commits, `_continuedTo` is unset.
   */
  private async probeSuccessor(
    id: string,
    chain: ChainIdentity,
    knownFirst?: EventEnvelope
  ): Promise<string | undefined> {
    const candidate = successorIdOf(chain.chainId, chain.generation);
    if (candidate === id) return undefined;
    const first = (await readRangeOf(this.eventStore, candidate, 0, 0))[0];
    if (first === undefined) return undefined;
    // Accepted only as a VERIFIED link (see `isVerifiedSuccessor`): a squatter at the deterministic
    // id, or a log that merely names `id`, captures nothing.
    const prev = knownFirst ?? (await readRangeOf(this.eventStore, id, 0, 0))[0];
    return prev !== undefined && isVerifiedSuccessor(prev, id, first, candidate)
      ? candidate
      : undefined;
  }

  /** Is `nextId` the verified successor of `prevId` (both sequence 0s read here unless known)? */
  private async verifiedHop(
    prevId: string,
    nextId: string,
    prevFirst?: EventEnvelope
  ): Promise<boolean> {
    const prev = prevFirst ?? (await readRangeOf(this.eventStore, prevId, 0, 0))[0];
    if (prev === undefined) return false;
    const next = (await readRangeOf(this.eventStore, nextId, 0, 0))[0];
    return isVerifiedSuccessor(prev, prevId, next, nextId);
  }

  /**
   * THE walk to the head of a chain (ADR 0109 D4), shared by every follower (`resume`, `followToHead`,
   * the supervisor, the local worker): the first id of a chain stays addressable forever. A
   * `continued` (or, in the start-to-commit window, `running`) member is ROUTED to the deepest
   * generation by {@link routeToDeepest} (O(log n) point reads, verified), then stepped forward over
   * VERIFIED links only (`_continuedTo`, or the successor probe) for the residual window, at most
   * `maxChainHops` steps. If the deepest log fails verification (a squatter written straight to the
   * store) the walk falls back to stepping verified links from the addressed id: it never routes to an
   * unverified log. Reads through `foldState`, so it is a kernel-internal read (callers authorize
   * first, and again against the head's owner before acting). `null` = no such execution.
   */
  private async walkToHead(
    executionId: string
  ): Promise<{ id: string; state: ExecutionState; hops: number } | null> {
    let id = executionId;
    let state = await this.foldState(id);
    if (state === null) return null;
    let hops = 0;
    if (state.status === "continued" || (state.status === "running" && this.continueAsNewEnabled)) {
      const first = (await readRangeOf(this.eventStore, id, 0, 0))[0];
      const routed = first === undefined ? undefined : await this.routeToDeepest(id, first);
      const at = routed === undefined ? null : await this.foldState(routed.id);
      if (routed !== undefined && at !== null) {
        id = routed.id;
        state = at;
        hops = routed.hops;
      }
    }
    for (let step = 0; ; step++) {
      let next: string | undefined;
      if (state.status === "continued") {
        const to = state.variables._continuedTo;
        if (typeof to === "string" && to.length > 0 && (await this.verifiedHop(id, to))) next = to;
      } else if (state.status === "running" && this.continueAsNewEnabled) {
        next = await this.probeSuccessor(id, chainOfState(state, id));
      }
      if (next === undefined) return { id, state, hops };
      if (step >= this.maxChainHops) {
        throw new ChainHopLimitError(executionId, this.maxChainHops, id);
      }
      const nextState = await this.foldState(next);
      if (nextState === null) return { id, state, hops }; // the successor is not readable yet
      id = next;
      state = nextState;
      hops++;
    }
  }

  /**
   * The highest generation of `chain` whose log exists, found by galloping + bisection over the
   * deterministic ids `<chainId>~<n>` (O(log n) point reads). Existence only: the caller verifies
   * (see {@link routeToDeepest}). Best effort (a retention-deleted prefix may stop it early).
   */
  private async deepestGenerationOf(chain: ChainIdentity): Promise<number> {
    const exists = async (g: number): Promise<boolean> =>
      (await readRangeOf(this.eventStore, `${chain.chainId}~${g}`, 0, 0)).length > 0;
    let lo = chain.generation;
    let step = 1;
    try {
      while (step < 2 ** 30 && (await exists(lo + step))) {
        lo += step;
        step *= 2;
      }
      let hi = lo + step;
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (await exists(mid)) lo = mid;
        else hi = mid;
      }
    } catch {
      /* routing is best effort: the verified walk is the fallback */
    }
    return lo;
  }

  /**
   * ADR 0109 D4 — route from `id` (whose sequence 0 is `first`) to the newest generation of its
   * chain, or `undefined` when there is none beyond it or it cannot be VERIFIED. The deepest id
   * found by {@link deepestGenerationOf} is accepted only if its sequence 0 is the verified
   * successor of generation n-1 (`isVerifiedSuccessor`: deterministic id, names its predecessor,
   * next generation, same parent and principal) AND records the same lineage and owner as `first`:
   * a squatted log at the deterministic id is never routed to (the caller falls back to stepping
   * verified links). `hops` is the generation distance.
   */
  private async routeToDeepest(
    id: string,
    first: EventEnvelope
  ): Promise<{ id: string; first: EventEnvelope; hops: number } | undefined> {
    const chain = chainOfFirstEnvelope(first, id);
    const deepest = await this.deepestGenerationOf(chain);
    if (deepest <= chain.generation) return undefined;
    const headId = `${chain.chainId}~${deepest}`;
    const headFirst = (await readRangeOf(this.eventStore, headId, 0, 0))[0];
    if (headFirst === undefined) return undefined;
    const prevGen = deepest - 1;
    const prevId = prevGen === chain.generation ? id : `${chain.chainId}~${prevGen}`;
    const prevFirst =
      prevGen === chain.generation ? first : (await readRangeOf(this.eventStore, prevId, 0, 0))[0];
    if (prevFirst === undefined || !isVerifiedSuccessor(prevFirst, prevId, headFirst, headId)) {
      return undefined;
    }
    if (!sameLineage(first, headFirst)) return undefined;
    return { id: headId, first: headFirst, hops: deepest - chain.generation };
  }

  /**
   * Follow a continued execution to the head of its chain (ADR 0109 D4/D6): the head's id and
   * folded state. Authorized as `query` against the addressed id first, then against the resolved
   * head's owner (every generation inherits the recorded principal). A head that is not continued
   * returns itself. The walk is routed (see {@link walkToHead}): any generation's id works however
   * long the chain.
   */
  async followToHead(
    executionId: string,
    options?: { principal?: PrincipalChain; system?: SystemGrant }
  ): Promise<{ executionId: string; state: ExecutionState; hops: number } | null> {
    return this.sealedOp(
      "query",
      executionId,
      options?.principal,
      options?.system,
      () => this.followToHeadCore(executionId, options),
      true
    );
  }

  private async followToHeadCore(
    executionId: string,
    options?: { principal?: PrincipalChain; system?: SystemGrant }
  ): Promise<{ executionId: string; state: ExecutionState; hops: number } | null> {
    assertNotReserved(executionId);
    const first = await this.loadState(executionId, options); // authorizes `query`, hides "not found"
    if (first === null) return null;
    const head = await this.walkToHead(executionId);
    if (head === null) return null;
    if (head.id !== executionId) await this.loadState(head.id, options); // authorizes against the head's owner
    return { executionId: head.id, state: head.state, hops: head.hops };
  }

  /**
   * ADR 0109 D2 — the kernel-private continuation start: a durable idempotent start of the
   * successor at its deterministic id, carrying everything it inherits in its own sequence 0. It is
   * not `start()`: no `RunOptions` field, wire field or dispatcher payload reaches it, so nothing a
   * caller sets can forge a successor. An existing sequence 0 is adopted only if its
   * `continuedFrom.executionId` is this predecessor; any other is {@link ContinuationConflictError}.
   */
  private async startSuccessor(args: {
    predecessorId: string;
    workflowId: string;
    workflowVersion: string;
    carry: unknown;
    /** The execution's effective deadline budget (ms), for the chain deadline fixed at generation 0. */
    deadlineMs: number | undefined;
    fallbackRunner: FlowRunner<unknown, unknown>;
  }): Promise<{
    successorId: string;
    chainId: string;
    generation: number;
    handle: ExecutionHandle | undefined;
  }> {
    const { predecessorId, workflowId } = args;
    const registered = this.flows.get(workflowId);
    const runner = (registered?.runner ?? args.fallbackRunner) as FlowRunner<unknown, unknown>;
    // EVERYTHING the successor inherits is read from the predecessor's DURABLE log, never from the
    // running execution's fold: under `restoreFromState` that fold began as a caller-supplied
    // `ExecutionState`, and the principal, lineage, chain identity and carried totals decide who
    // OWNS the successor (ADR 0109 D2/D3). Sequence 0 answers principal, parent, chain and the
    // chain deadline; the durable fold answers the running resources and the inbox cursors.
    const first0 = (await readRangeOf(this.eventStore, predecessorId, 0, 0))[0];
    const seed = new ReplayVM(first0 !== undefined ? [first0] : [], {
      executionId: predecessorId,
      workflowId,
      workflowVersion: args.workflowVersion,
    }).getState();
    const durable = (await this.foldState(predecessorId)) ?? seed;
    const chain = chainOfState(seed, predecessorId);
    const generation = chain.generation + 1;
    const successorId = successorIdOf(chain.chainId, chain.generation);
    // Registered BEFORE the successor's sequence 0 can be observed (see `awaitLiveHandle`) and
    // settled on every exit: with the handle once `execute` registered it, else `undefined`.
    let settleStarting!: (h: ExecutionHandle | undefined) => void;
    const starting = new Promise<ExecutionHandle | undefined>((resolve) => {
      settleStarting = resolve;
    });
    this.startingSuccessors.set(successorId, starting);
    let started: ExecutionHandle | undefined;
    try {
      return await this.startSuccessorBody(args, {
        first0,
        durable,
        seed,
        chain,
        generation,
        successorId,
        registered,
        runner,
        onHandle: (h) => {
          started = h;
        },
      });
    } finally {
      if (this.startingSuccessors.get(successorId) === starting) {
        this.startingSuccessors.delete(successorId);
      }
      settleStarting(started);
    }
  }

  private async startSuccessorBody(
    args: {
      predecessorId: string;
      workflowId: string;
      workflowVersion: string;
      carry: unknown;
      deadlineMs: number | undefined;
    },
    c: {
      first0: EventEnvelope | undefined;
      durable: ExecutionState;
      seed: ExecutionState;
      chain: ChainIdentity;
      generation: number;
      successorId: string;
      registered: RegisteredFlow | undefined;
      runner: FlowRunner<unknown, unknown>;
      onHandle: (h: ExecutionHandle) => void;
    }
  ): Promise<{
    successorId: string;
    chainId: string;
    generation: number;
    handle: ExecutionHandle | undefined;
  }> {
    const { predecessorId, workflowId } = args;
    const { first0, durable, seed, chain, generation, successorId, registered, runner } = c;
    // The chain's absolute deadline is fixed at generation 0 and carried unchanged afterwards.
    const chainDeadline =
      chainDeadlineOf(seed, predecessorId) ??
      (chain.continuedFrom === undefined && args.deadlineMs !== undefined && durable.startedAt > 0
        ? durable.startedAt + args.deadlineMs
        : undefined);
    const recorded = seed.variables._principal;
    const record: PrincipalRecord =
      typeof recorded === "object" && recorded !== null && !Array.isArray(recorded)
        ? (recorded as unknown as PrincipalRecord)
        : { v: 1 };
    const parent =
      typeof seed.variables._parent === "string" && seed.variables._parent.length > 0
        ? seed.variables._parent
        : undefined;
    const state = durable;
    const flowHash = this.recordedHashOf(workflowId);
    const computeTarget = first0?.metadata?.[COMPUTE_TARGET_KEY];
    const bootstrap: BootstrapEvent = {
      eventType: "EXECUTION_STARTED",
      payload: {
        input: args.carry,
        ...(flowHash !== undefined && { flowHash }),
        // ADR 0113 D2 (R1b) — a continuation is the clean re-version point: the successor runs the
        // code registered NOW, so it records THAT code's fingerprint, not the predecessor's.
        ...(registered?.definition.codeFingerprint !== undefined && {
          codeHash: registered.definition.codeFingerprint,
        }),
        principal: record,
        ...(parent !== undefined && { parent }),
        chainId: chain.chainId,
        generation,
        continuedFrom: {
          executionId: predecessorId,
          carried: carriedOf(state, chainDeadline),
        },
      },
      ...(computeTarget !== undefined && { metadata: { [COMPUTE_TARGET_KEY]: computeTarget } }),
    };
    // ADR 0130 D11 (S7c) - the successor is leased BEFORE its EXECUTION_STARTED while the predecessor
    // still holds its own (it releases at its CONTINUED commit): no instant exists at which a stream
    // is `running` and unleased. ALWAYS eager, even in lazy mode (S7g ruling 2026-10-15): it is a
    // handoff from a possibly leased predecessor. Another live owner already driving the successor reads exactly like
    // an existing sequence 0 of a re-driven predecessor: a no-op.
    let succLease: DriverLease = NO_LEASE;
    if (this.driverLeases !== undefined) {
      const got = await this.driverLeases.acquire(successorId);
      if (got === null) {
        // Another live owner. A real successor stream = already started elsewhere (a no-op); no
        // sequence 0 = a ghost lease, so this continuation must be retried, not dropped.
        if (!(await this.hasSequenceZero(successorId))) throw new StartLeaseHeldError(successorId);
        return { successorId, chainId: chain.chainId, generation, handle: undefined };
      }
      succLease = got;
    }
    try {
      try {
        // ADR 0130 D11: the successor's bootstrap bypasses the journal's write gate: check the lease.
        if (!succLease.valid()) throw succLease.lossError();
        bootstrap.durable = await this.writeBootstrap(
          successorId,
          workflowId,
          bootstrap,
          undefined
        );
      } catch (err) {
        if (!(err instanceof ExecutionAlreadyExistsError)) throw err;
        const existing = (await readRangeOf(this.eventStore, successorId, 0, 0))[0];
        const from = (existing?.payload as { continuedFrom?: { executionId?: unknown } } | null)
          ?.continuedFrom?.executionId;
        if (from === predecessorId) {
          // A re-drive of a predecessor whose successor already started (ADR 0109 D2): no-op.
          await succLease.release();
          return { successorId, chainId: chain.chainId, generation, handle: undefined };
        }
        throw new ContinuationConflictError(
          predecessorId,
          successorId,
          typeof from === "string" ? from : undefined
        );
      }
      // The owner is the predecessor's (lineage trusted: the kernel's own start, like a fork's).
      this.notifyStarted(successorId, workflowId, undefined, undefined, predecessorId, true);
      const startRecord = { record, parent };
      this.startRecords.set(successorId, startRecord);
      try {
        const actingAs = await this.actingPrincipal(successorId, undefined, {
          first: bootstrap.durable,
        });
        const vm = new ReplayVM([], {
          executionId: successorId,
          workflowId,
          workflowVersion: registered?.definition.version ?? args.workflowVersion,
        });
        const handle = this.execute(
          successorId,
          workflowId,
          vm,
          runner,
          args.carry,
          [bootstrap],
          undefined,
          registered?.definition.deadlineMs,
          actingAs,
          false,
          succLease
        );
        c.onHandle(handle);
        return { successorId, chainId: chain.chainId, generation, handle };
      } catch (err) {
        if (this.startRecords.get(successorId) === startRecord)
          this.startRecords.delete(successorId);
        throw err;
      }
    } catch (err) {
      await succLease.release();
      throw err;
    }
  }

  /**
   * ADR 0109 D2 — is the predecessor of this generation CANCELLED? Read once on a successor's first
   * run (and every recovery re-drive), before its first effect: a cancel that landed in the
   * start-to-commit window must not leave a live generation. Best effort: an unreadable
   * predecessor is not a cancelled one (retention may have deleted it).
   */
  private async predecessorCancelled(predecessorId: string): Promise<boolean> {
    try {
      const tip = await this.classifyTip(predecessorId);
      return tip.kind === "terminal" && tip.status === "cancelled";
    } catch {
      return false;
    }
  }

  /**
   * ADR 0109 D2 (i) — cancel `executionId` and every started generation after it, forward, at most
   * {@link maxChainHops} links: a `continued` member hands the cancel to its successor, and a
   * member that is still running (or already cancelled) is probed for a successor started in the
   * start-to-commit window. No authorization here: the caller authorized against the chain owner.
   * Returns whether any cancellation was performed.
   */
  private async cancelForward(
    executionId: string,
    reason: unknown,
    recheck?: (id: string) => Promise<void>
  ): Promise<boolean> {
    let id = executionId;
    let performed = false;
    for (let hop = 0; hop <= this.maxChainHops; hop++) {
      // a hop past the addressed id is authorized against ITS owner before anything is cancelled
      if (hop > 0 && recheck !== undefined) await recheck(id);
      let state: ExecutionState | null;
      const live = this.liveHandles.get(id);
      if (live !== undefined) {
        live.cancel(reason);
        performed = true;
        state = live.getState();
      } else {
        state = await this.foldState(id);
        if (state === null) {
          if (hop === 0) throw new Error(`No execution found for id: ${id}`);
          return performed;
        }
        if (
          state.status === "running" ||
          state.status === "pending" ||
          state.status === "suspended"
        ) {
          const fence = await this.fenceOf(id);
          const sequence = state.sequence + 1;
          const envelope: EventEnvelope = {
            id: `${id}-${sequence}`,
            workflowId: state.workflowId,
            executionId: id,
            eventType: "EXECUTION_CANCELLED",
            sequence,
            timestamp: this.now(),
            payload: { ...(reason !== undefined && { reason: String(reason) }) },
            ...(fence !== undefined && { metadata: { fence } }),
          };
          await this.eventStore.append(envelope);
          this.onEvent?.(envelope);
          await this.retireInbox(chainIdOf(state, id));
          performed = true;
        }
      }
      let next: string | undefined;
      if (state.status === "continued") {
        const to = state.variables._continuedTo;
        // Routed to the chain's newest verified generation (a continued member has nothing left to
        // cancel), else only a VERIFIED single link is cancelled into: a pointer at a foreign id
        // stops the cascade.
        const first = (await readRangeOf(this.eventStore, id, 0, 0))[0];
        const routed = first === undefined ? undefined : await this.routeToDeepest(id, first);
        if (routed !== undefined) next = routed.id;
        else {
          next =
            typeof to === "string" && to.length > 0 && (await this.verifiedHop(id, to))
              ? to
              : undefined;
        }
      }
      if (
        next === undefined &&
        state.status !== "continued" &&
        (state.status === "running" || state.status === "cancelled") &&
        (this.continueAsNewEnabled || state.status === "cancelled")
      ) {
        next = await this.probeSuccessor(id, chainOfState(state, id));
      }
      if (next === undefined) return performed;
      // More links than `maxChainHops`: the cancel did NOT reach the head. Say so, naming the
      // furthest id reached, rather than report a cancellation that left a live generation behind.
      if (hop >= this.maxChainHops)
        throw new ChainHopLimitError(executionId, this.maxChainHops, id);
      id = next;
    }
    throw new ChainHopLimitError(executionId, this.maxChainHops, id);
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
    principal?: PrincipalChain,
    /**
     * ADR 0110 — the kernel's own inbox delivery: the atomic batch is awaited BEFORE the runner
     * starts (a run that lost the write never executes a step), and a lost race (a rival notifier
     * took the slot, or a stale fence) is reported through {@link inboxLanded} rather than as a
     * storage error: it is expected contention, not a fault.
     */
    inboxDelivery = false,
    /**
     * ADR 0130 D11 (S7c) - the heartbeat hold the caller took BEFORE its fence and first append. The
     * run owns it from here: released AWAITED before any handle settles, and a lost lease aborts the
     * run. {@link NO_LEASE} (unwired) leaves every line below byte-identical (G2).
     */
    lease: DriverLease = NO_LEASE
  ): ExecutionHandle {
    // Backstop: `start`/`resume`/`resumeAs`/`restoreFromState` already validated the per-call
    // `options.deadlineMs` before appending anything; this covers the flow definition's own budget.
    assertValidBudget("deadlineMs", deadlineMs, `execution "${executionId}"`);
    // ADR 0109 D2 — what the log said when this run was entered: a successor checks its predecessor
    // on a FIRST run (a fresh start, or a recovery re-drive of one that never parked), never on a
    // resume from a park.
    const entryStatus = vm.peekState().status;
    let resolveCompletionRaw!: (state: ReturnType<typeof vm.getState>) => void;
    let rejectCompletionRaw!: (err: unknown) => void;
    let resolveSuspendRaw!: (state: ReturnType<typeof vm.getState>) => void;
    let rejectSuspendRaw!: (err: unknown) => void;

    const completionPromise = new Promise<ReturnType<typeof vm.getState>>((resolve, reject) => {
      resolveCompletionRaw = resolve;
      rejectCompletionRaw = reject;
    });

    const suspendPromise = new Promise<ReturnType<typeof vm.getState>>((resolve, reject) => {
      resolveSuspendRaw = resolve;
      rejectSuspendRaw = reject;
    });

    // ADR 0130 D11 (S7c) - the lease is released at the suspend/terminal commit and that release is
    // AWAITED before the handle settles (a prompt `send` winner is not blocked by our own stale
    // lease). Unwired, the settlers are the raw resolvers, synchronously, as before.
    const leased = lease !== NO_LEASE;
    let releasing: Promise<void> | undefined;
    const releaseOnce = (): Promise<void> => {
      releasing ??= lease.release().catch(() => {});
      return releasing;
    };
    const settleAfterRelease =
      <A>(raw: (a: A) => void) =>
      (a: A): void => {
        void releaseOnce().then(() => raw(a));
      };
    const resolveCompletion = leased
      ? settleAfterRelease(resolveCompletionRaw)
      : resolveCompletionRaw;
    const rejectCompletion = leased ? settleAfterRelease(rejectCompletionRaw) : rejectCompletionRaw;
    const resolveSuspend = leased ? settleAfterRelease(resolveSuspendRaw) : resolveSuspendRaw;
    const rejectSuspend = leased ? settleAfterRelease(rejectSuspendRaw) : rejectSuspendRaw;
    let leaseLost: LeaseLostError | undefined;

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
        .catch((err: unknown) => this.reportCheckpointError(executionId, err))
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
        this.reportCheckpointError(executionId, err);
      }
    };

    const journal = new ExecutionJournal(
      this.eventStore,
      { executionId, workflowId },
      vm,
      this.onEvent,
      (err) => {
        // A lost lease is expected, not a storage fault: it was reported where it was detected.
        if (
          !(err instanceof LeaseLostError) &&
          !(inboxDelivery && (isWriteConflict(err) || isStaleFence(err)))
        ) {
          this.onStorageError?.(executionId, err);
        }
        if (!cancelled) controller.abort(err);
      },
      maybeSnapshot,
      fence,
      this.now
    );

    // ADR 0130 D11 (S7c) - the run's lease. Lost (taken over, or past the local self-fencing deadline;
    // this may run SYNCHRONOUSLY inside `lease.valid()`): the journal is abandoned so NOTHING more is
    // appended (no EXECUTION_FAILED/CANCELLED: another node may now own the log), the run's existing
    // abort controller is aborted with the LeaseLostError (effects that honour the signal stop), and
    // both handles reject with it (superseded, not failed). The write gate additionally refuses every
    // append whose lease is no longer valid (a stall longer than the TTL), before it reaches the store.
    if (leased) {
      lease.onLost((err) => {
        if (leaseLost !== undefined) return;
        leaseLost = err;
        journal.abandon(err);
        controller.abort(err);
        rejectCompletionRaw(err);
        rejectSuspendRaw(err);
      });
      journal.setWriteGate(() => (lease.valid() ? undefined : (leaseLost ?? lease.lossError())));
    }

    // Commit bootstrap events (EXECUTION_STARTED / resume+RESUMED / restore) so
    // they flow through the same sequencer + writer as everything else.
    let atomicRun: BootstrapEvent[] = [];
    const flushAtomic = (): void => {
      if (atomicRun.length === 0) return;
      // An inbox delivery may LOSE its batch and be retried: its facts reach `onEvent` only once
      // the batch is durable, so a subscriber never sees a consumption that never landed.
      journal.commitAtomic(atomicRun, { deferOnEvent: inboxDelivery });
      atomicRun = [];
    };
    for (const b of bootstrapEvents) {
      if (b.atomic === true) {
        atomicRun.push(b);
        continue;
      }
      flushAtomic();
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
    flushAtomic();
    // ADR 0113 D3 — the replay-divergence detector. Armed AFTER the bootstrap (the runtime's own
    // appends: the start, the resume and its answers, a migration), so it judges only what the flow
    // BODY appends. The baseline is every completed frame (outside those a migration exempted):
    // the body must ask for each of them before it does anything new.
    const divergence: DivergenceGuard = new DivergenceGuard(
      executionId,
      this.divergenceMode,
      (() => {
        const expected = new Set(vm.expectedReplayFrames());
        return vm.recordedFrames().map((f) => ({ ...f, completed: expected.has(f.id) }));
      })(),
      (message) => {
        this.divergenceWarned++;
        this.onWarn(message);
      }
    );
    journal.setAppendGuard((eventType, payload) => {
      // A step the LOG ALREADY HAS a frame for (a failed or in-flight one, re-run live by design
      // — an untyped failure re-executes on every re-run) is part of the recorded shape, but only
      // the frames recorded BEFORE it are excused from being asked for first.
      if (eventType === "STEP_STARTED" || eventType === "EFFECT_INDOUBT") {
        const id = (payload as { stepId?: unknown } | null)?.stepId;
        if (typeof id === "string" && Object.hasOwn(vm.peekState().frames, id)) {
          divergence.check(eventType, id);
          return;
        }
      }
      divergence.check(eventType);
    });
    // Resolves once the bootstrap batch is durable, rejects with its write error: the inbox
    // delivery's proof that the append LANDED (a handle alone does not say so).
    let bootstrapLanded: Promise<void> | undefined;
    if (inboxDelivery) {
      bootstrapLanded = journal.drain();
      bootstrapLanded.catch(() => {});
    }

    const ctx: WorkflowContextImpl = new WorkflowContextImpl(
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
        ...(this.meterCeilings !== undefined && { meterCeilings: this.meterCeilings }),
        ...(this.errorClasses !== undefined && { errorClasses: this.errorClasses }),
        ...(this.surface !== undefined && { surface: this.surface }),
        // ADR 0130 D11 (S7c): no effect is dispatched under a lease that is no longer valid.
        ...(leased && {
          dispatchGate: () => {
            if (!lease.valid()) throw leaseLost ?? lease.lossError();
          },
        }),
        divergence,
        inbox: {
          enabled: this.inboxEnabled,
          chainId: chainIdOf(vm.peekState(), executionId),
          read: this.inboxSource,
          // ADR 0130 residuals D9: the live run applies the SAME delivery rule as the notify scan.
          quarantine: {
            readCopy: (entry) => this.readHeldCopy(chainIdOf(vm.peekState(), executionId), entry),
            autoRelease: this.inboxAutoRelease,
          },
        },
        continuation: {
          enabled: this.continueAsNewEnabled,
          maxCarryBytes: this.maxCarryBytes,
          validate: (carry) => this.validateCarry(workflowId, executionId, carry),
        },
      }
    );

    // ADR 0109 D2 — set the instant `EXECUTION_CONTINUED` is committed to this predecessor: from then
    // on nothing may follow it in this log (a cancel would fold `continued` -> `cancelled`).
    let rotated = false;
    const cancel = (reason?: unknown): void => {
      if (cancelled || rotated) return;
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
      // A zombie (an effect still running) must not append after the cancel record.
      ctx.seal({ cancel: true }); // keeps only STEP_CANCELLED of the steps the abort interrupts
      rejectCompletionRaw(err);
    };

    // K8.3 — execution deadline, anchored to the LOGGED EXECUTION_STARTED
    // timestamp (already folded from the bootstrap above on a fresh start, or
    // from the original log on resume) — a crash/resume never resets the clock,
    // and resuming past the deadline cancels immediately. Breach is a
    // kernel-driven cancel: durable EXECUTION_CANCELLED, in-flight effect aborted.
    let clearDeadline: (() => void) | undefined;
    // ADR 0109 D3 — a successor's deadline is `min(its flow deadline, the chain's absolute
    // deadline)`: the chain deadline was fixed at generation 0 and rides `continuedFrom.carried`,
    // so continuing is never a way to outlive it. Read from the fold (the bootstrap above applied).
    const chainDeadline = chainDeadlineOf(vm.peekState(), executionId);
    const effectiveDeadlineMs =
      chainDeadline === undefined
        ? deadlineMs
        : Math.min(
            deadlineMs ?? Number.POSITIVE_INFINITY,
            chainDeadline - (vm.getState().startedAt || this.now())
          );
    if (effectiveDeadlineMs !== undefined) {
      const startedAt = vm.getState().startedAt || this.now();
      const budget = effectiveDeadlineMs;
      // `startedAt` is a journal timestamp (`this.now`), so measure against the same clock.
      clearDeadline = armDeadline(
        () => remainingBudget(budget, startedAt, this.now),
        () =>
          cancel(
            new ExecutionCancelledError(
              `execution deadline exceeded (deadlineMs=${budget})`,
              undefined,
              "deadline"
            )
          )
      );
    }

    // ADR 0113 D3 — the run was refused under a diverged body (`divergence: "fail"`). NOTHING is
    // appended: no `EXECUTION_FAILED` (a deploy fault must not make a long-lived execution
    // permanently failed — after the code is fixed, or the execution migrated, it resumes), and no
    // park or completion. The log ends where the bootstrap left it; the handle rejects.
    const refuseDiverged = async (err: unknown): Promise<void> => {
      // PARK on the reserved gate (user decision, R7 fix round 1): a refused run that stayed
      // `running` was re-driven by every recovery pass, invisibly, forever. A park is the one state
      // recovery and timers leave alone and every consumer already reads as "waiting on a person";
      // `retryDiverged` re-runs it after the code is fixed, pinned or migrated. No EXECUTION_FAILED.
      // Never appended over a failed store or after a cancel (nothing may follow those).
      let tryPark = false;
      if (!journal.failed && err instanceof FlowReplayDivergenceError && !cancelled) {
        const summary = `skipped ${err.skippedCount}: ${err.skippedSteps.join(",")}`.slice(0, 256);
        journal.commit(
          "EXECUTION_SUSPENDED",
          { condition: { on: FLOW_DIVERGED_GATE, correlationKey: summary } },
          { unguarded: true }
        );
        tryPark = true;
      }
      ctx.seal();
      await journal.drain().catch(() => {});
      // The message says what actually happened: a park that did not land is not "PARKED".
      const parked = tryPark && !journal.failed;
      this.divergenceWarned++;
      this.onWarn(
        parked
          ? `execution "${executionId}" PARKED on "${FLOW_DIVERGED_GATE}" (divergence: fail): ${(err as Error).message} Re-run with retryDiverged("${executionId}") after the code is fixed, pinned or migrated.`
          : `execution "${executionId}" REFUSED (divergence: fail) and NOT parked (${cancelled ? "it was cancelled" : journal.failed ? "the store rejected the park" : "not a recorded-step divergence"}): ${(err as Error).message}`
      );
      rejectSuspend(err);
      rejectCompletion(err);
    };

    // ADR 0109 D2 — `ctx.continueAsNew` was accepted: start the successor FIRST (idempotent, at
    // its deterministic id), THEN commit `EXECUTION_CONTINUED` to this predecessor under its fence.
    // A crash between the two leaves a `running` predecessor, which `recoverAbandoned` re-drives:
    // the replay reaches the same call with the same carry, the start is a no-op and the commit
    // lands. Returns a failure to record (a conflicting successor id), or `undefined` when the
    // outcome has been settled here.
    const rotate = async (sig: ContinueAsNewSignal): Promise<{ error: unknown } | undefined> => {
      // ADR 0113 D3 — before the successor is started: nothing runs under a diverged body.
      const diverged = divergence.refusal("EXECUTION_CONTINUED");
      if (diverged !== undefined) {
        await refuseDiverged(diverged);
        return undefined;
      }
      const drained = ctx.parkBarrier(); // idle by construction (the call waited for it); freezes
      if (drained !== undefined) await drained;
      if (cancelled) {
        await journal.drain().catch(() => {});
        return undefined;
      }
      let started: Awaited<ReturnType<WorkflowRuntime["startSuccessor"]>>;
      try {
        // Everything journaled so far is durable before the successor inherits from the log.
        await journal.drain();
        started = await this.startSuccessor({
          predecessorId: executionId,
          workflowId,
          workflowVersion: vm.getState().workflowVersion,
          carry: sig.carry,
          deadlineMs,
          fallbackRunner: runner,
        });
      } catch (err) {
        if (err instanceof ContinuationConflictError) return { error: err };
        // Storage (or anything else) failed before the successor was durable: the predecessor
        // stays `running` and recovery re-drives it. Nothing may append after this point.
        ctx.seal();
        await journal.drain().catch(() => {});
        rejectSuspend(err);
        rejectCompletion(err);
        return undefined;
      }
      // A cancel that landed in the start-to-commit window must not leave a live generation
      // (D2 (i)): the predecessor's own EXECUTION_CANCELLED is terminal and nothing would ever
      // commit the continuation, so cancel the successor we just started.
      if (cancelled) {
        await journal.drain().catch(() => {});
        await this.cancelForward(
          started.successorId,
          JSON.stringify({ kind: "cascade", parent: executionId })
        ).catch((err: unknown) => this.onStorageError?.(started.successorId, err));
        return undefined;
      }
      rotated = true;
      journal.commit("EXECUTION_CONTINUED", {
        successorId: started.successorId,
        chainId: started.chainId,
        generation: started.generation,
      });
      // ADR 0112 D3 — nothing from this execution's own (abandoned) work follows its terminal.
      ctx.seal();
      try {
        await journal.drain();
      } catch (drainErr) {
        rejectSuspend(drainErr);
        rejectCompletion(drainErr);
        return undefined;
      }
      // The chain's inbox is NOT retired: it is keyed by `chainId` and the successor reads on.
      await checkpointOnSettle();
      resolveCompletion(vm.getState());
      return undefined;
    };

    const run = async () => {
      if (bootstrapLanded !== undefined) {
        try {
          await bootstrapLanded;
        } catch (lost) {
          // The delivery did not land: nothing of this run is durable, so no step may start.
          rejectCompletion(lost);
          rejectSuspend(lost);
          return;
        }
      }
      try {
        // ADR 0109 D2 (ii) — a successor whose predecessor was cancelled (a cancel that landed in the
        // start-to-commit window, after the cancel's own successor probe) must not run: it appends
        // its own cancellation (reason `cascade`) before its first effect.
        const predecessor = chainOfState(vm.peekState(), executionId).continuedFrom?.executionId;
        if (
          predecessor !== undefined &&
          (entryStatus === "pending" || entryStatus === "running") &&
          !cancelled &&
          (await this.predecessorCancelled(predecessor))
        ) {
          cancel(JSON.stringify({ kind: "cascade", parent: predecessor }));
          const durable = await journal
            .drain()
            .then(() => true)
            .catch(() => false);
          if (durable) await this.retireInbox(chainIdOf(vm.peekState(), executionId));
          return;
        }
        // ADR 0110 D2 — a quiescent flow with registered waits parks: the context rejects
        // `parkSignal` with a `WaitsPark`, which is handled exactly like a thrown `SuspendError`.
        // ADR 0109 — an accepted `continueAsNew` rejects `continueSignal` the same way, so a flow
        // that swallowed the sentinel still rotates.
        const output = await Promise.race([runner(ctx, input), ctx.parkSignal, ctx.continueSignal]);
        // ADR 0130 — a flow that swallowed the replay refusal must not complete on it.
        if (ctx.sealedReplayRefusal !== undefined) throw ctx.sealedReplayRefusal;

        // A cancel (a deadline that had already passed when a parked execution was resumed, say)
        // owns the outcome: EXECUTION_CANCELLED is committed and nothing may follow it.
        if (cancelled) {
          const durable = await journal
            .drain()
            .then(() => true)
            .catch(() => false);
          if (durable) await this.retireInbox(chainIdOf(vm.peekState(), executionId));
          return;
        }
        journal.commit("EXECUTION_COMPLETED", { output });
        // ADR 0112 D3 — nothing from this execution's own (abandoned) work follows its terminal.
        ctx.seal();
        await journal.drain(); // durability barrier
        await this.retireInbox(chainIdOf(vm.peekState(), executionId));
        await checkpointOnSettle(); // bound reads of the settled execution
        resolveCompletion(vm.getState());
      } catch (caught) {
        let err: unknown = caught;
        // ADR 0113 D3 — a refusal (even one the body swallowed, then failed on something else).
        const refused = err instanceof FlowReplayDivergenceError ? err : divergence.latched;
        if (refused !== undefined && !cancelled && !journal.failed) {
          await refuseDiverged(refused);
          return;
        }
        // ADR 0130 — a replayed inbox answer is still sealed on this node: refuse the ATTEMPT.
        // Nothing is appended (the context sealed the journal at the refusal), no EXECUTION_FAILED
        // (terminal: it would strand the execution for a capable node), no park, no completion.
        const sealedRefusal = ctx.sealedReplayRefusal;
        if (sealedRefusal !== undefined && !cancelled && !journal.failed) {
          ctx.seal();
          await journal.drain().catch(() => {});
          this.onWarn(
            `execution "${executionId}": run attempt REFUSED, NOT failed: ${sealedRefusal.message}`
          );
          // ADR 0130 D10: leave a durable, head-stamped refusal row (a TIMER-store row, never a log
          // append) so a capable node's poll can re-drive this `running` execution, on evidence.
          await this.markRefused(executionId);
          rejectSuspend(sealedRefusal);
          rejectCompletion(sealedRefusal);
          return;
        }
        // ADR 0130 residuals D7 - a read inside the attempt hit a stream this node cannot open: refuse
        // the ATTEMPT, never fail the execution (a terminal EXECUTION_FAILED would strand it for a
        // node that CAN open it).
        if (isSealedUnreadable(err) && !cancelled && !journal.failed) {
          ctx.seal();
          await journal.drain().catch(() => {});
          this.onWarn(
            `execution "${executionId}": run attempt REFUSED, NOT failed: ${(err as Error).message}`
          );
          await this.markRefused(executionId); // ADR 0130 D10 (see above)
          rejectSuspend(err);
          rejectCompletion(err);
          return;
        }
        if (err instanceof ContinueAsNewSignal) {
          const failure = await rotate(err);
          if (failure === undefined) return;
          err = failure.error; // a conflicting successor id: the predecessor FAILS with it
        }
        if (err instanceof SuspendError && err.condition.on !== FLOW_DIVERGED_GATE) {
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
          const legacy: typeof stripped & { stepId?: unknown } =
            isKernelHumanPark(err) && claimedStep !== undefined
              ? { ...stripped, stepId: claimedStep }
              : stripped;
          // ADR 0110 D4 — the registered waits of this park. A quiescent park (`WaitsPark`) is
          // described by them alone: a single gate wait keeps the legacy single-gate fields
          // byte-identically, anything else carries the reserved `on`. A legacy `ctx.suspend` park
          // that coexists with registered waits (a mixed flow) keeps ITS fields and adds `waits`.
          const registered = ctx.pendingWaits();
          const condition: typeof stripped & { stepId?: unknown } =
            err instanceof WaitsPark ? legacyConditionOf(registered) : legacy;
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
          const committedBase =
            wakeAt !== undefined && condition.wakeAt === undefined
              ? { ...condition, wakeAt }
              : condition;
          // ADR 0113 D3 — a park is a live append: refuse it BEFORE the barrier and the commit.
          const divergedAtPark = divergence.refusal("EXECUTION_SUSPENDED");
          if (divergedAtPark !== undefined) {
            await refuseDiverged(divergedAtPark);
            return;
          }
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
          // `waits` is added AFTER the commit-site strip above and the event is stamped
          // `metadata.kernel`: the fold honours a park's `waits` only on a stamped envelope.
          const waits = ctx.pendingWaits();
          if (err instanceof WaitsPark && waits.length === 0) {
            // Unreachable by construction (a quiescent park has no work to drain, so no wait can
            // settle between the decision and here); fail loudly rather than commit an unresumable park.
            const lost = new Error(
              `execution "${executionId}": a quiescent park lost every wait before it was committed`
            );
            rejectSuspend(lost);
            rejectCompletion(lost);
            return;
          }
          const committedCondition = waits.length > 0 ? { ...committedBase, waits } : committedBase;
          journal.commit(
            "EXECUTION_SUSPENDED",
            { condition: committedCondition },
            waits.length > 0 ? { metadata: { kernel: true } } : undefined
          );
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
            this.reportCheckpointError(executionId, err);
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
          // One row per TIMER arm (ADR 0110 D4): the wake time was recorded at first registration.
          for (const w of waits) {
            if (w.kind !== "timer" || w.wakeAt === undefined) continue;
            if (this.timerStore === undefined) {
              this.warnNoTimerStore(workflowId, "a ctx.select timer arm");
              continue;
            }
            try {
              await this.timerStore.schedule({ executionId, wakeAt: w.wakeAt });
            } catch (timerErr) {
              this.onStorageError?.(executionId, timerErr);
            }
          }
          resolveSuspend(state);
          // ADR 0110 D5 closure 2 — the park is durable: look once more for a message that arrived
          // in the gap between the quiescence read and the park, and self-resume (acquire-if-parked).
          if (waits.some((w) => w.kind === "inbox")) {
            void this.afterInboxPark(executionId, vm.getState());
          }
          void this.maybeTrimInbox(chainIdOf(state, executionId), state);
          return;
        }

        // Cancelled: cancel() already committed EXECUTION_CANCELLED and rejected
        // completion. Drain to make that write durable, then stop.
        if (cancelled) {
          const durable = await journal
            .drain()
            .then(() => true)
            .catch(() => false); // write error already surfaced via onStorageError
          if (durable) await this.retireInbox(chainIdOf(vm.peekState(), executionId));
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
        await this.retireInbox(chainIdOf(vm.peekState(), executionId));
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
    if (bootstrapLanded !== undefined) this.inboxLanded.set(handle, bootstrapLanded);
    this.liveHandles.set(executionId, handle);
    void run().finally(() => {
      // ADR 0130 D11 (S7c): the backstop for a path that returned without settling (a cancel); the
      // settlers above already released on every other path (idempotent).
      if (leased) void releaseOnce();
      clearDeadline?.();
      this.liveHandles.delete(executionId);
      this.startRecords.delete(executionId);
    });

    return handle;
  }
}

/**
 * ADR 0113 D4 — the recorded frame ids a `replay-check` migration would orphan. A frame passes when
 * its id is a step of the target flow OR belongs to a family the target still declares: the part
 * before the first `#` (every ADR 0061 `id#n` mint and `agentLoop$`'s `<loop>#turn:<n>:tool:<j>`),
 * or a name/RegExp in the target's `stepFamilies` for ids that do not follow that convention. A
 * vanished family fails once, reported with its frame count rather than one name per dynamic frame.
 */
export function orphanedFrames(
  recorded: readonly string[],
  stepIds: readonly string[],
  stepFamilies: readonly (string | RegExp)[] | undefined
): string[] {
  const known = new Set(stepIds);
  const named = new Set<string>();
  const patterns: RegExp[] = [];
  for (const f of stepFamilies ?? []) {
    if (typeof f === "string") named.add(f);
    else patterns.push(f);
  }
  const lost = new Map<string, number>(); // family (or exact id) -> frames orphaned
  for (const id of recorded) {
    if (known.has(id)) continue;
    const hash = id.indexOf("#");
    const family = hash > 0 ? id.slice(0, hash) : undefined;
    if (family !== undefined && (known.has(family) || named.has(family))) continue;
    if (named.has(id)) continue;
    if (
      patterns.some((re) => {
        re.lastIndex = 0; // a /g or /y pattern is stateful
        return re.test(id);
      })
    ) {
      continue;
    }
    const key = family !== undefined ? `${family}#*` : id;
    lost.set(key, (lost.get(key) ?? 0) + 1);
  }
  return [...lost].map(([key, n]) =>
    key.endsWith("#*") ? `${key} (${n} frame${n === 1 ? "" : "s"})` : key
  );
}
