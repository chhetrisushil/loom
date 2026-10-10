import { SkillRegistry } from "@loom/agent";
import { agentSurfaceProjection, createSurfaceEmitter } from "@loom/agent-surface";
import {
  EraseCoordinator,
  type EraseSubjectOptions,
  type EraseSubjectResult,
  type Shredder,
  type SubjectExport,
  SubjectIndex,
  type SubjectResolver,
  type TenantResolver,
  exportSubject as exportSubjectData,
} from "@loom/compliance";
import { isProjectionHandlersRef, loadProjectionHandlers, projectionEventTypes } from "@loom/core";
import type {
  AgentDefinition,
  AnyProjectionDefinition,
  EventEnvelope,
  MemoryDefinition,
  PolicyDefinition,
  ScheduleDefinition,
  SkillDefinition,
  ToolDefinition,
} from "@loom/core";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import { EffectRuntime, PolicyAuthorizer } from "@loom/effect-runtime";
import type { CapabilityAuthorizer, EffectMiddleware } from "@loom/effect-runtime";
import type { BranchRegistry, EventStore, LeaseStore, TimerStore } from "@loom/event-runtime";
// Only the in-memory stores are imported statically — they are pure JS. We import
// them from the browser-safe `/memory` SUBPATH rather than the package barrel: the
// barrel also re-exports the SQLite stores (which `import "better-sqlite3"`), and
// these packages compile to CommonJS — which bundlers cannot tree-shake. The subpath
// keeps better-sqlite3 / node:fs out of browser bundles. The SQLite stores +
// node:fs/path are loaded lazily on the `kind:"sqlite"` path only (see
// `loadNodeModule`), so a browser app using in-memory storage stays clean.
import { InMemoryAsyncEventStore } from "@loom/event-runtime/memory";
import { type KnowledgeBase, openKnowledgeBase } from "@loom/knowledge";
import type { KnowledgeBaseConfig } from "@loom/knowledge";
import { InMemoryMemoryStore, MemoryRuntime } from "@loom/memory";
import type { MemoryStore } from "@loom/memory";
import {
  BudgetLedger,
  InMemoryKillSwitch,
  type KillSwitchRegistry,
  type SecretResolver,
  killSwitchMiddleware,
  redactOutputFrom,
  redactionMiddleware,
  secretOutputPathsByStep,
} from "@loom/middleware";
import { toAgentCard } from "@loom/plugin-a2a";
import type { AgentCard } from "@loom/plugin-a2a";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import type { SnapshotStore } from "@loom/snapshot-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime/memory";
import {
  composeAdapters,
  createTelemetryHook,
  scrubPathsByStep,
  scrubbingAdapter,
} from "@loom/telemetry";
import type { TelemetryAdapter } from "@loom/telemetry";
import { type VerificationReport, runVerification, verify as runVerify } from "@loom/verify";
import { LogLifecycle, TimerService, WorkflowRuntime } from "@loom/workflow-runtime";
import type { PrincipalCodec, PrincipalResolver, TimerDispatcher } from "@loom/workflow-runtime";
import type {
  ArchiveStores,
  ExecutionAuthorizer,
  ExecutionAuthzRequest,
  PinPredicate,
  RegisteredFlow,
  ResumeAuthenticator,
} from "@loom/workflow-runtime";
import { InProcessA2ABus } from "./InProcessA2ABus";
import {
  type PrincipalCryptoOptions,
  registerInboxPaths,
  registerPrincipalPaths,
  resolvePrincipalIdentity,
} from "./principalPolicy";
import {
  type AgentModule,
  type FlowModule,
  type ManifestView,
  type MemoryModule,
  type ProjectionModule,
  type ScheduleModule,
  type SkillModule,
  type ToolModule,
  agentDefinitionsFrom,
  manifestWarnings,
  memoryDefinitionsFrom,
  projectionDefinitionsFrom,
  registerFlowsFrom,
  registeredFlowsFrom,
  scheduleDefinitionsFrom,
  skillDefinitionsFrom,
  toolDefinitionsFrom,
} from "./registerFlows";
import {
  type AutonomyEnvelopeOptions,
  type ResolvedEnvelope,
  STRICT_DEFAULTS,
  type StrictOptions,
  budgetConfigured,
  envelopeMiddleware,
  permissiveNotice,
  resolveSpawn,
  strictProblems,
  withDefaultDeadline,
} from "./strict";
import { type FlowGraphFlow, validateFlowGraph } from "./validate";
import {
  type VerifyConfig,
  type VerifyLintInputs,
  normalizeVerify,
  resolveVerifyInput,
} from "./verifyAdapter";

/** Structural view of a CapabilityCatalog — avoids a hard `@loom/capability` dep. */
export interface CatalogLike {
  registerInto(runtime: WorkflowRuntime): void;
  get(capabilityId: string): { flow: RegisteredFlow } | undefined;
}

export type StorageConfig =
  /** Ephemeral in-memory stores — great for tests, demos, and browser apps. */
  | { kind: "memory" }
  /**
   * Bring your own storage backend. The runtime is storage-agnostic, so supply
   * any `EventStore` + `SnapshotStore` (and an optional `BranchRegistry` for
   * fork/branch). This is also how every concrete backend is wired: a store plugin
   * exports a preset returning this shape — `sqliteStorage({ dir })` from
   * `@loom/plugin-sqlite`, `postgresStorage({ url })` from `@loom/plugin-postgres`,
   * or your own — so `@loom/app` names no vendor and 1P/3P backends are symmetric
   * (ADR 0043).
   */
  | {
      kind: "custom";
      eventStore: EventStore;
      snapshotStore: SnapshotStore;
      branchRegistry?: BranchRegistry;
    };

/**
 * Everything that decides whether an operation is ALLOWED, in one place — because these
 * compose and are easy to half-wire. `authorizer` gates EFFECTS (the K2 capability ring);
 * `executionAuthorizer` gates an execution's LIFECYCLE; `resumeAuthenticator` gates the
 * events that reopen a suspended one. An app can need all three, and needing one is not
 * evidence it has the others.
 */
export interface SecurityOptions {
  /**
   * Capability protection ring (K2). When set, every effect is authorized against
   * it and ungranted effects are denied (least-privilege). Omit for permissive.
   * e.g. `new GrantTable({ "my-flow": ["metrics-tool", "logs-tool"] })`.
   */
  authorizer?: CapabilityAuthorizer;
  /**
   * R9 — the strict profile: flip the permissive defaults to a safe baseline. `true` (or an
   * options object) makes `defineConfig` THROW, listing every problem at once, unless the
   * app supplies what only it can write — {@link authorizer} and {@link executionAuthorizer} —
   * and keeps pre-flight verification on (`checks.verify`, defaulting to `"error"`). It also
   * turns on, with defaults you can override or set `false`:
   *
   *  - a default execution deadline for flows that declare none ({@link StrictOptions.defaultDeadlineMs});
   *  - the autonomy envelope's spawn depth/breadth caps and a per-execution token budget
   *    (`execution.envelope`, see {@link AutonomyEnvelopeOptions});
   *  - a process-local kill switch, exposed as `app.killSwitch`.
   *
   * `undefined` (the default) changes nothing about behaviour but logs ONE advisory through
   * `observability.onWarn` naming what is left permissive. `false` is the explicit, visible
   * opt-out: same behaviour, no advisory. See `docs/usage.md` ("Strict mode").
   */
  strict?: boolean | StrictOptions;
  /**
   * R9 — a kill switch consulted BEFORE every effect: system-wide, per tenant (the principal's
   * `tenant`) or per flow, with an admin handle (`InMemoryKillSwitch`) or your own
   * {@link KillSwitchRegistry} over a shared store to stop across processes. A stopped effect
   * is a typed refusal (`KillSwitchEngagedError`). It stops the NEXT effect; it does not cancel
   * a running execution or its children (that is the kernel's cancel cascade). Under
   * {@link strict} an in-memory one is created for you when this is omitted.
   */
  killSwitch?: KillSwitchRegistry;
  /**
   * App-global `policy$` definitions enforced on EVERY effect via a `PolicyAuthorizer`.
   * Per-flow policies are read automatically from each flow's `policies` (`flow$`); these
   * `policies` apply on top of them, everywhere. A policy composes UNDER {@link authorizer}
   * (both must allow — defense in depth), so it can tighten a grant but never widen it.
   * Enforcement is deny-wins; a flow with no governing policy is unaffected (opt-in).
   */
  policies?: PolicyDefinition[];
  /**
   * K10-R2 — secret handling. Wiring a resolver installs {@link redactionMiddleware} on the
   * effect path (outermost), so:
   *  - `secretRef(...)` values in step INPUT are resolved to the real value for the tool
   *    while the log keeps only the reference (the secret never enters STEP_STARTED); and
   *  - step OUTPUT fields marked `secret()` (K10-R1) are replaced by a reference before
   *    STEP_COMPLETED — derived automatically from the registered flows' step schemas.
   *
   * Omitting the key installs nothing (G2). This is the low-risk half of K10-R2; automatic
   * substitution inside the kernel hot path remains deliberately deferred.
   */
  secrets?: {
    /** Resolves secret references to real values (back it with a vault/KMS in production). */
    resolver: SecretResolver;
  };
  /**
   * K12.2 — authenticates approval-type resume events. A resume the authenticator rejects
   * is REFUSED (a forged approval never resumes); a verified one records a durable
   * `APPROVAL_GRANTED` fact, so "who approved" is evidence rather than a claim.
   *
   * Surfaced here because it was otherwise unreachable: it is a {@link WorkflowRuntime}
   * dep with no setter, so an app assembled by `defineConfig` could not authenticate
   * resumes at all. Pre-flight verification errors on a flow that declares resume gates
   * with nothing wired here (`suspension-safety`, K12).
   */
  resumeAuthenticator?: ResumeAuthenticator;
  /**
   * C.1 — authorizes execution lifecycle operations (`start`/`resume`/`cancel`, and the
   * public `loadState`). Without `strict`, consulted only for calls that carry a `principal`.
   * `executionAccessPolicy()` from `@loom/workflow-runtime` is the first-party reference policy.
   *
   * SECURITY CONTRACT, restated from {@link WorkflowRuntime} because this is where it is
   * now wired: outside `strict`, principal-less calls bypass the gate BY DESIGN, so the
   * kernel's own machinery (TimerService, recovery) keeps working; the integrator is then
   * responsible for attaching an authenticated principal to every externally-originated
   * call. Under `strict` (R3) a principal-less call is NOT waved through — it reaches this
   * authorizer with `principal: undefined` and the policy decides — while the kernel's own
   * machinery presents the runtime's system grant instead (it authorizes the LIFECYCLE op only;
   * the flow's effects run as the principal recorded at start, ADR 0111). Edge-enforced
   * policy, still not a substitute for authenticating the caller.
   *
   * Distinct from {@link authorizer}, which gates EFFECTS (the K2 capability ring). This
   * one gates the execution's lifecycle; an app that needs both wires both.
   */
  executionAuthorizer?: ExecutionAuthorizer;
  /** C.1 — audit/telemetry hook fired whenever {@link executionAuthorizer} refuses. */
  onExecutionDenied?: (request: ExecutionAuthzRequest, reason?: string) => void;
  /**
   * R3k (ADR 0111 D3) — an app that must not put even an actor id in its log supplies a codec:
   * every execution then records `{ v: 1, ref }` only, and the runtime rebuilds the effect
   * principal with `fromRef` on every start / resume / timer wake / recovery. REQUIRED under
   * {@link strict} or a composed {@link compliance} plugin unless {@link crypto} is composed
   * (otherwise `defineConfig` refuses to compose, {@link PrincipalRecordingRefusedError}).
   * `@loom/orchestration`'s supervisor composes its own codec for delegated children.
   */
  principalCodec?: PrincipalCodec;
  /**
   * R3k (ADR 0111 D2) — replace the default rehydration of a recorded principal (rebuild
   * `{ tenant, actor, onBehalfOf }`; deny a delegation that cannot be restored) for every record.
   */
  principalResolver?: PrincipalResolver;
  /**
   * R3k (ADR 0111 D1) — the crypto plugin's stores. Composing them makes `defineConfig` register
   * `principal.identity.*` (and the snapshot's `variables._principal.identity.*`) as sensitive, so
   * the identity subset is encrypted at rest and shredded with the subject. Pass the SAME
   * instances your stores are built from, before the first execution starts.
   */
  crypto?: PrincipalCryptoOptions;
  /**
   * T3 (GDPR/CCPA-enabling) — data-subject rights. Supply a {@link SubjectResolver} (given an
   * event, the data subject it concerns — usually read off EXECUTION_STARTED input, e.g. the
   * userId) to maintain a live subject index over the event stream, exposing
   * `app.subjectIndex` and `app.exportSubject(subjectId)` (Art. 15 access / Art. 20
   * portability). Omitting the key builds nothing (G2). Not legal advice.
   */
  compliance?: {
    subjectOf: SubjectResolver;
    /**
     * T3-R2.4 — partition the subject index by tenant so two tenants sharing a subject id are
     * never merged (a cross-tenant access/erasure leak). Given an event, return its tenant —
     * the tenant is not persisted in events by default, so read it from input/metadata. Omit
     * for a single-tenant app.
     */
    tenantOf?: TenantResolver;
    /**
     * T3 Phase B — enable `app.eraseSubject` (Art. 17). Wire `shred` to the crypto plugin's
     * `shredSubject` (bound to the KeyStore + raw store + snapshot store); it MUST be
     * idempotent, which `shredSubject` is per execution (ADR 0106) — call it again rather than
     * guarding on the key. Erasure is liveness-gated: shredded now if the subject's
     * executions are all terminal, else parked (durable `ERASURE_PENDING`) and auto-completed
     * when the last live execution terminates — never shredding a fold in flight.
     */
    erase?: { shred: Shredder };
  };
}

/**
 * Where the app's own signal goes. None of these change behaviour; every one of them is
 * the difference between a failure you can see and a failure you cannot — `onStorageError`
 * especially, which is the ONLY channel a failed snapshot has.
 */
export interface ObservabilityOptions {
  /** Telemetry adapters, composed and wired to the event stream. */
  telemetry?: TelemetryAdapter[];
  /** Extra event observer, fired after projection + telemetry. */
  onEvent?: (event: EventEnvelope) => void;
  /** Sink for boot-time warnings (manifest cross-check + validation). Default `console.warn`. */
  onWarn?: (message: string) => void;
  /**
   * Fired when a durable write rejects. Forwarded verbatim to {@link WorkflowRuntime},
   * which reports two different kinds through it:
   *
   * - an **event** append that rejects — the run is aborted regardless and
   *   `waitForCompletion`/`waitForSuspend` reject with a `StorageWriteError`, so this
   *   hook is only logging/metrics;
   * - a **snapshot** save that rejects — fire-and-forget, so this hook is the ONLY
   *   channel. Nothing else observes it and the run continues unharmed.
   *
   * The second is why this is surfaced here alongside {@link LoomConfig.snapshotEvery}.
   * Setting a cadence turns on a mid-run checkpoint whose failure is otherwise silent:
   * the execution keeps running, replay quietly stops being bounded, and the only
   * symptom is a `loadState` that gets slower over time. Cheap against an in-memory or
   * local store; a real risk against a network-backed or quota-limited one — which is
   * exactly the storage a cadence is worth setting for.
   */
  onStorageError?: (executionId: string, err: unknown) => void;
}

/**
 * How much log a restart has to fold, and how long it is kept. Both trade write cost for
 * read cost; see `docs/scaling.md` for the measurements.
 */
export interface DurabilityOptions {
  /**
   * Take a mid-run snapshot every N committed events, and a matching one at completion,
   * bounding what a later `loadState`/resume has to fold.
   *
   * Forwarded verbatim to {@link WorkflowRuntime}. It is surfaced here because
   * `defineConfig` builds the runtime, so an app wired the supported way had no way to
   * set it at all — and settle-time checkpointing (`docs/scaling.md` §3.2) is gated on
   * it, which left the larger half of that work unreachable rather than merely off by
   * default.
   *
   * Omit (or 0) for today's behaviour: snapshots at suspend and fork only, and a
   * `foldState` that reads the whole log. Worth setting once executions get long —
   * measured at a 102-event log it is 4.76 ms → 1.22 ms p50; at 4 events it is nothing
   * (0.72 → 0.71 ms), so short flows should not bother. Larger N means fewer snapshot
   * writes and a longer worst-case replay.
   */
  snapshotEvery?: number;
  retention?: {
    /** Where each execution's events/snapshot are copied before deletion (A6). */
    archive?: ArchiveStores;
    /**
     * K10.6 — pin predicate: retention exempts executions this returns `true`
     * for (outcome `"pinned"`). The kernel supplies the gate; what pins is
     * policy (G3) — e.g. `pinByEventKinds(store, ["FINDING_RECORDED"])` from
     * `@loom/plugin-content`.
     */
    pinned?: PinPredicate;
    /**
     * ADR 0106 — the pinned event KINDS (the list given to `pinByEventKinds` and
     * `sweepUnpinnedContent`). `lifecycle.compact` keeps these events in place, so a
     * compacted run keeps its findings. `lifecycle.compact` consults `pinned` only when this
     * is empty (then a pinned execution is not compacted); with kinds declared, a pinned
     * execution compacts around them. Validated at boot: non-empty strings, no kernel kinds.
     */
    pinnedEventTypes?: readonly string[];
    /**
     * ADR 0106 — executions whose whole log `lifecycle.compact` must leave uncompacted (a
     * legal hold by tag). Consulted always, unlike `pinned`.
     */
    compactionExempt?: PinPredicate;
  };
}

/**
 * How and where the work runs: placement, the effect chain wrapped around every call,
 * boundary parsing, and the clock. Storage-agnostic — none of it names a backend.
 */
export interface ExecutionOptions {
  /** Placement dispatcher for the bus (default: in-process). e.g. Cloud Run. */
  dispatcher?: ExecutionDispatcher;
  /** Static, ordered effect middleware (retries, logging, …). */
  effectMiddleware?: EffectMiddleware[];
  /**
   * ADR 0112 D2 — error classes a fail-fast `parallel` scope may rehydrate BY NAME. The scope
   * journals the failing error's name and message; the first run and every re-run throw the
   * value built from that record: a `TypedFailure` stays typed, a class listed here (the built-in
   * `Error` family is always known) is rebuilt `new ctor(message)` — deterministic, message
   * only, no `cause` — and anything else is a `ParallelScopeFailedError` carrying the name.
   * Only read when `kernel.features.scopes` is on.
   */
  errorClasses?: Record<string, new (message: string) => Error>;
  /**
   * R9 — the autonomy envelope: bounds on what a runaway agent can do (spawn depth/breadth,
   * spend, effect rate). Off unless configured, except the defaults {@link SecurityOptions.strict}
   * applies. Installs its middleware between redaction and your `effectMiddleware`. See
   * {@link AutonomyEnvelopeOptions}.
   */
  envelope?: AutonomyEnvelopeOptions;
  /**
   * DX (ADR 0063/0064 follow-up) — composition-time effect registration hook,
   * called once with the constructed `EffectRuntime` before any execution
   * starts. The seam that makes single-effect dispatchers compose declaratively:
   * `registerEffects: (fx) => { registerMcpInvoke(client, fx); registerSandboxEval(fx, store); }`.
   * Discovery (`toolModules`) supplies tool *metadata*; this supplies the
   * runnable effects. Static wiring (P5) — the hook runs at boot, never later.
   *
   * Declared in the `execution` group (`defineConfig({ execution: { registerEffects } })`);
   * the flat spelling throws. This is also how `agentLoop$` gets its model and tool effects
   * in a `defineConfig` app: `execution: { registerEffects: (fx) => { fx.register("model",
   * createAgentModelEffect(provider)); } }`, then `agentLoop$(ctx, { modelToolId: "model", … })`.
   */
  registerEffects?: (effects: EffectRuntime) => void;
  /**
   * Injectable clock for event-envelope timestamps (DST/simulation); retention windows
   * and content-GC citation ages read them. Default `Date.now`. Not fold-relevant, but
   * DEADLINE-relevant: step `timeoutMs` and execution `deadlineMs` are anchored to
   * timestamps written with it and measure remaining time with it, while the timer that
   * enforces them waits real milliseconds, so it must advance in real time. A FIXED clock
   * silently disables crash-surviving deadlines (every resume re-grants the full budget);
   * a budget above 2^31-1 ms (~24.8 days) then never fires within a single run either;
   * an OFFSET is safe only if every runtime touching the log uses the same offset (this
   * covers timer wake times and cron too, and applies across an upgrade: timers parked
   * before it carry wall-clock `wakeAt`, so an offset clock fires them |offset| early or
   * late, never under a fixed clock, and old and new nodes disagree during a rolling
   * upgrade; the default wall clock is unaffected). Caveat (3): under a FIXED clock,
   * sleeps, `suspend({ timeout })` and cron schedules NEVER fire (they used to fire on
   * wall time); advance the clock or drive `tick(now)` yourself. "A fixed or offset clock
   * is fine" applies to deadlines only. `sleepUntil(absolute)` targets and cron
   * occurrences are measured on this clock, not wall time.
   * `ctx.sleep`/`suspend({timeout})` wake times use it too, and the `TimerService` that
   * `timers` wires defaults to it, so wake times and the clock that judges them agree
   * (an offset clock still wakes correctly). Lease expiry is not read from this clock: the
   * lease store judges it on the clock that stamped it.
   */
  now?: () => number;
  /**
   * K10.1 — log-lifecycle wiring. Presence exposes `app.lifecycle` (a {@link LogLifecycle})
   * for explicit, non-background retention/compaction passes (the spec's anti-hidden-thread
   * stance — an operator or `loom retention run` drives it; nothing prunes on a timer). The
   * branch-integrity guard is wired automatically when the storage backend supplies a
   * `branchRegistry`. Supply `archive` for archive-before-delete (A6). Omitting the key is
   * byte-identical to not wiring it (G2) — `app.lifecycle` is still available, unarchived.
   */
  /**
   * ADR 0051 D7 — opt-in input validation at start. When true, every entry path
   * (direct starts, schedule occurrences, A2A submits) parses the flow's declared
   * `inputSchema` at the boundary: invalid input refuses with a typed
   * `InputValidationError` before anything is appended, and the parsed value
   * (Zod defaults/transforms applied) is what runs and is recorded. Omitted =
   * declaration-only metadata, byte-identical (G2).
   */
  validateInput?: boolean;
}

/**
 * Pre-flight checks that run at composition time, before anything executes. All opt-in,
 * all refuse-early rather than fail-later.
 */
export interface ChecksOptions {
  /**
   * Run structural flow-graph validation at boot (missing effects, dangling
   * capability→agent maps). `true`/`"warn"` reports via `onWarn`; `"error"`
   * throws on the first error. See {@link validateFlowGraph}.
   */
  validate?: boolean | "warn" | "error";
  /**
   * Pre-flight runtime verification (`@loom/verify`). Runs read-only, off-log checks over
   * the resolved app **at boot, before any execution starts**. `"error"` throws on an
   * error-severity finding; `"warn"` reports via {@link onWarn}; `"off"` (the default)
   * is byte-identical to not wiring verify (G2). Use the object form to declare the
   * metered resource dimensions or restrict the rule set. The strongest check today is
   * capability-compat (a step's effect must be granted in the K2 `GrantTable`).
   * `app.verify()` re-runs the same checks on demand (used by `loom verify`).
   */
  verify?: VerifyConfig;
  /**
   * Optional compiler manifest to cross-check against — any flow the compiler saw
   * but that isn't registered (or that carries a compiler warning) is reported
   * via `onWarn` at boot rather than failing at dispatch.
   */
  manifest?: ManifestView;
}

/**
 * The single, static description of a Loom app. It is deliberately declarative
 * and side-effect-free to read: `defineConfig` turns it into the same runtime +
 * transport you would otherwise hand-assemble, so a resume / remote worker
 * reconstructs an identical wiring (determinism). It does NOT build app-specific
 * conductor logic (the Orchestrator) or HTTP routes.
 */
export interface LoomConfig {
  storage: StorageConfig;
  /** Projection runtime to fold events into UI surfaces. Default in-memory. */
  projectionRuntime?: ProjectionRuntime;
  /**
   * Agent surfaces to register on the projection runtime. A bare string is the surface id;
   * the object form declares K10-R6 egress redaction — surface dot-paths masked before any
   * reader (client/renderer) sees them (surface patches are app-authored, so sensitive surface
   * paths are declared explicitly rather than derived from schema marks).
   */
  surfaces?: (string | { id: string; redact?: readonly string[] })[];
  /** Flows registered directly (in addition to any from `catalog`). */
  flows?: RegisteredFlow[];
  /**
   * Statically-imported flow modules — every `RegisteredFlow`-shaped export is
   * registered (see {@link registerFlowsFrom}). Lets an app do
   * `import * as flows from "./flows"` instead of listing each flow, while
   * staying deterministic (static imports, not manifest dynamic-import).
   */
  flowModules?: FlowModule[];
  /**
   * Statically-imported agent modules (from `loom gen`'s `agentModules`) — every `agent$`
   * definition exported is discovered by value shape and folded into {@link agents}, so it
   * participates in the A2A / agent-surface auto-wiring behind the {@link a2a}/{@link agentSurface} flags. Same
   * folder-convention discovery as `flowModules`, extended to `app/agents/*.ts`.
   */
  agentModules?: AgentModule[];
  /**
   * Statically-imported tool modules (from `loom gen`'s `toolModules`) — every `tool$`
   * definition is discovered by value shape and exposed on `app.tools` (for introspection /
   * validation). NOTE: a tool's runnable EFFECT is registered separately
   * (`effectRuntime.register(id, new ToolEffect(fn))`) — `tool$` is metadata-only by design,
   * so effects are never auto-wired from a definition.
   */
  toolModules?: ToolModule[];
  /**
   * Statically-imported skill modules (from `loom gen`'s `skillModules`) — every `skill$`
   * definition is discovered by value shape and registered into `app.skills` (a
   * {@link SkillRegistry}) for deterministic, offline skill selection. Only the cheap metadata
   * (id/name/description/tags) is held for scoring; the `instructions$` body stays lazy until a
   * skill is chosen. Same folder-convention discovery as `flowModules`, from `app/skills/*.ts`.
   */
  skillModules?: SkillModule[];
  /**
   * Skills registered directly (in addition to any discovered from `skillModules`). Accepts the
   * `skill$` `SkillDefinition`s you'd otherwise hand into a `SkillRegistry` yourself.
   */
  skills?: SkillDefinition[];
  /**
   * Statically-imported schedule modules (from `loom gen`'s `scheduleModules`) — every
   * `schedule$` definition is discovered by value shape and merged with {@link timers}`.schedules`,
   * then handed to the `TimerService` so each cron occurrence starts its flow. Exposed on
   * `app.schedules` for introspection. NOTE: schedules only *fire* when {@link timers} is
   * configured with a `TimerStore`; discovered without `timers`, they are inert (a boot warning
   * is emitted). Same folder-convention discovery, from `app/schedules/*.ts`.
   */
  scheduleModules?: ScheduleModule[];
  /**
   * Statically-imported memory modules (from `loom gen`'s `memoryModules`) — every `memory$`
   * definition is discovered by value shape and registered into `app.memory` (a
   * {@link MemoryRuntime}) so agents can resolve their `memoryId`. Same folder-convention
   * discovery as `flowModules`, from `app/memories/*.ts`.
   */
  memoryModules?: MemoryModule[];
  /** Memory definitions registered directly (in addition to any from `memoryModules`). */
  memories?: MemoryDefinition[];
  /**
   * Backing store for `app.memory`. Defaults to an in-memory store (content is lost on restart —
   * memory is separate from the durable event log). Pass a persistent `MemoryStore` for durability.
   */
  memoryStore?: MemoryStore;
  /**
   * Statically-imported projection modules (from `loom gen`'s `projectionModules`) — every
   * `projection$` definition is discovered by value shape and folded into the projection
   * runtime. A compiler-emitted lazy-handlers ref becomes an **event-type-gated** projection:
   * its fold code loads on demand the first time one of its handled events fires (a projection
   * whose events never fire never loads its code). Discovery from `app/projections/*.ts`.
   */
  projectionModules?: ProjectionModule[];
  /**
   * Projection definitions registered directly (in addition to any from `projectionModules`).
   *
   * Typed as {@link AnyProjectionDefinition} because a fold is invariant in its state: a
   * `ProjectionDefinition<CpuState>` is assignable to no other instantiation, so an array of
   * concretely-typed projections could not be passed here at all.
   */
  projections?: AnyProjectionDefinition[];
  /** Capability catalog registered into the runtime + wired to agents. */
  catalog?: CatalogLike;
  /**
   * Agents advertised on the in-process A2A bus. Accepts either hand-built `AgentCard`s
   * (registered verbatim, exactly as before) **or** `agent$` `AgentDefinition`s. A definition
   * is auto-wired only when the matching flag is enabled ({@link a2a} / {@link agentSurface}); with the
   * flags off, nothing about the current manual flow changes.
   */
  agents?: (AgentCard | AgentDefinition)[];
  /** capabilityId → agentId routing for the bus. */
  capabilityAgents?: Record<string, string>;
  /**
   * K/DX — auto-expose declared `agent$` definitions on the A2A bus. When `true`, every
   * `AgentDefinition` in {@link agents} has its `AgentCard` derived (`toAgentCard`) and
   * registered — no hand-written, drift-prone card objects. **Opt-in**: default/omitted is
   * byte-identical to today (only explicit `AgentCard`s register; definitions warn if passed
   * without this flag). Hand-wiring cards + `bus.registerAgent` keeps working unchanged.
   */
  a2a?: boolean;
  /**
   * K/DX — auto-register an agent surface per declared `agent$` definition (`surfaceId =
   * agent.id`), so an agent can drive its own UI via `createSurfaceEmitter(emit, agent.id)` with
   * no manual `surfaces` entry. **Opt-in**: default/omitted registers nothing extra; manual
   * `surfaces: [...]` is unaffected. Harmless (empty projection) for agents that never emit.
   */
  agentSurface?: boolean;
  /**
   * Wave 2 rolling-upgrade flags. Each flag guards a WRITER whose output an older node cannot read;
   * turn it on only after every node runs the version that reads it (default off).
   */
  kernel?: {
    features?: {
      /**
       * ADR 0118 D4 (R8k) — live re-drive of a contended resume. On, `app.redrive` is populated
       * (needs `timers`), and a supervisor built with `superviseChildren({ redrive: app.redrive })`
       * turns a `ResumeContendedError` into a backed-off `TimerStore` row that this app's
       * `TimerService` fires, so the parent completes without anyone calling `recover()`. OFF by
       * default because an older node's `TimerService` judges every row by `suspendedOn.wakeAt` and
       * RETIRES a re-drive row as obsolete — a silent loss. With the flag off a contended resume is
       * reported through `onError` and `recover()` re-drives it (today's behaviour).
       */
      redrive?: boolean;
      /**
       * ADR 0112 D1/D2 (R6) — cancellation scopes: `ctx.parallel` aborts the scope on the first real
       * branch failure, records `STEP_CANCELLED` for the work it cancels and journals a
       * `PARALLEL_COMPLETED` record that a re-run serves. OFF by default because an older node does
       * not fold the record: it would re-run the cancelled branches live and diverge from the node
       * that failed fast. Off, `parallel` is the pre-R6 bounded `Promise.all` (no abort, no record);
       * the park barrier (ADR 0112 D3) writes no new event and is always on. Turn it on once every
       * node runs a version that folds `PARALLEL_COMPLETED`.
       */
      scopes?: boolean;
      /**
       * ADR 0110 (R2) — the durable inbox: `ctx.receive` / `ctx.select` (registering waits, a
       * multi-wait park, wait-addressed resumes) and the authorized `runtime.send`. OFF by default
       * because an execution that has ever parked with `waits` cannot be driven by an older node
       * (its fold ignores `waits` and `MESSAGE_CONSUMED`): the one-way door of an additive-kind
       * bump. Off, `ctx.receive` / `ctx.select` / `send` throw a message naming this flag. Wire
       * `timers` on every node too: a send from another process wakes a parked owner through a
       * `TimerStore` row.
       */
      inbox?: boolean;
      /**
       * ADR 0109 (R1b) — `ctx.continueAsNew`: end an execution and start its successor with a carry,
       * so a long-lived conversational / multi-party agent keeps a bounded fold and snapshot. OFF by
       * default because a pre-1.23.0 node ignores `EXECUTION_CONTINUED` and the `continued` status:
       * it would read the predecessor as still running and re-drive it. Off, `ctx.continueAsNew`
       * throws a message naming this flag (existing chains stay readable and resumable). Turn it on
       * once every node folds `EXECUTION_CONTINUED`. The caller-chosen-id reservation of the
       * successor shape (`<x>~<digits>` on the root segment) applies regardless of this flag.
       */
      continueAsNew?: boolean;
      /**
       * ADR 0113 D1 (R7) — record the structural flow hash as `sha256:<hex>` on new starts. OFF by
       * default because a node that predates ADR 0113 compares a recorded hash with its own 32-bit
       * `fnv1a:` one and refuses (`FlowCodeMismatchError`) every execution a newer node started.
       * Off, new starts keep writing `fnv1a:`; both forms are always READ. Turn it on once every
       * node reads `sha256:`. `security.strict` does NOT turn it on: a rolling upgrade is a fleet
       * decision, not a security posture.
       */
      sha256FlowHash?: boolean;
    };
    /** ADR 0109 D1/D4 — continue-as-new bounds (read only when `features.continueAsNew` is on). */
    continuation?: {
      /** Largest carry `ctx.continueAsNew` accepts, in bytes of its JSON text. Default 1 MiB. */
      maxCarryBytes?: number;
      /** Bounds only the RESIDUAL forward stepping after a head walk is routed to the newest generation (ADR 0109 D4). Default 8. */
      maxChainHops?: number;
    };
    /** ADR 0110 D1/D6 — inbox bounds (read only when `features.inbox` is on). */
    inbox?: {
      /** `send` refuses beyond this many unconsumed messages per chain. Default 10 000. */
      maxBacklog?: number;
      /**
       * `send` refuses once the stream retains this many entries above its oldest UNCONSUMED
       * message, whatever their consumption state (a cold topic pins every entry above it).
       * Default 4 x `maxBacklog`. An `onWarn` fires once per chain at 50% of it.
       */
      maxRetained?: number;
      /** Largest JSON payload `send` accepts, in bytes. Default 65 536. */
      maxPayloadBytes?: number;
      /**
       * ADR 0110 amendment, D10a — expire UNCONSUMED messages after this many milliseconds: a number
       * for every topic, or `{ default?, topics? }` per topic. OFF by default (nothing expires, no
       * behaviour changes). An expiry is a journaled discard (`reason: "expired"`, recorded as the
       * runtime, never an operator), so it replays; it is timed from the message's envelope timestamp
       * by the app's `TimerService` rows, never read inside the fold. Each TTL is at least 60 000 ms
       * (a smaller one is refused): the age is judged across nodes' clocks, on the store's own clock
       * when it has `storeNow()` (Postgres), else the TTL must far exceed the fleet's clock skew. Needs
       * `timers`; enable it on EVERY node of a fleet before relying on it (a node without it retires an
       * expiry row as obsolete, and expiry is then lost until a `recoverAbandoned` sweep).
       */
      messageTtlMs?: number | { default?: number; topics?: Readonly<Record<string, number>> };
    };
    /**
     * ADR 0115 (R15) — per-dimension override of the sanity ceiling on one `RESOURCE_METERED`
     * increment, enforced where userspace appends (`guardUserspaceEmit`). A built-in dimension
     * may be raised or lowered; a custom one defaults to 1e15 and may only be lowered. The fold
     * never reads it (a pure fold cannot read a runtime setting).
     */
    meterCeilings?: Readonly<Record<string, number>>;
    /**
     * ADR 0113 D3 (R7) — the replay-divergence detector. A re-run whose flow body never asks for a
     * step the log records as completed, before its first live append of ANY kind (step, decision,
     * emit, park, spawn, continuation) or at completion, has diverged from its log: the code
     * changed shape under an in-flight execution. `"warn"` (default) reports once per run through
     * `observability.onWarn` and proceeds; `"fail"` refuses BEFORE the append with
     * `FlowReplayDivergenceError` (a `FlowDivergenceError`) and writes no terminal event;
     * `"off"` is silent. Under `security.strict` the default is `"fail"`. Membership only, no
     * order check; frames before an `EXECUTION_MIGRATED` are exempt. No wire change: the check
     * is runtime-only, so it is not a rolling-upgrade flag.
     */
    divergence?: "off" | "warn" | "fail";
  };
  /**
   * T1 — durable timers. Wire a {@link TimerStore} (`InMemoryTimerStore`,
   * `SqliteTimerStore`/`PostgresTimerStore` beside your event store) and the app
   * runs a {@link TimerService}: `ctx.sleep`/`ctx.sleepUntil` — and
   * `suspend({ timeout })` — get durable, restart-surviving wakes fired as
   * `TIMER_FIRED`, and `schedules` (`schedule$`) fire cron occurrences with
   * deterministic, idempotent starts. `fenced: true` for multi-node deployments
   * (K9.4 tokens per fire). Omit everything for today's behavior.
   */
  timers?: {
    store: TimerStore;
    pollMs?: number;
    schedules?: ScheduleDefinition[];
    fenced?: boolean;
    /** Advisory: pre-warm a scheduled flow's first effect this many ms before it fires. */
    warmLeadMs?: number;
    /**
     * #392 — where a wake runs. With a dispatcher the service re-drives each due execution
     * on the lane it was STARTED in (`start({ computeTarget })`), instead of resuming inside
     * whichever process happens to run the timer. Without one, wakes run here, unchanged.
     *
     * Wire it in any deployment where executions are placed deliberately: a branch given its
     * own compute otherwise wakes up in the web server after its first suspension.
     */
    dispatcher?: TimerDispatcher;
    /**
     * #380 — ownership before a wake. With a `LeaseStore` the service CLAIMS an execution
     * before resuming it and renews while the wake is in flight, so two nodes polling one
     * timer store do not both resume (and both pay for) the same work. Without one, a
     * duplicate wake is made safe by fencing (K9.4) but is still run twice.
     *
     * `owner` is this node's identity — a pod name, a process uuid, whatever your deployment
     * already uses to mean "this process". See `TimerService` for the ttl/renewal semantics:
     * the ttl is the tolerance for a node that DIED, not a bound on how long a run may take.
     */
    leases?: {
      store: LeaseStore;
      owner: string;
      ttlMs?: number;
      renewEveryMs?: number;
    };
  };
  /**
   * Whether composing this app also STARTS the background services it wires (today: the
   * durable-timer service). Default `true` — `defineConfig` has always started what it wired.
   *
   * Set `false` when something needs to INSPECT a composition rather than run it. An operator
   * command that reads this app's stores must not, merely by importing the module, begin polling
   * for due timers and firing schedules against production storage — a diagnostic with side
   * effects is worse than a missing one, and `import` happens before any of its own code runs.
   *
   * Nothing is given up: {@link LoomApp.start} starts exactly what `autostart` would have,
   * whenever the caller actually means to.
   */
  autostart?: boolean;

  // ── Grouped options ───────────────────────────────────────────────────────
  /** See {@link SecurityOptions}. */
  security?: SecurityOptions;
  /** See {@link ObservabilityOptions}. */
  observability?: ObservabilityOptions;
  /** See {@link DurabilityOptions}. */
  durability?: DurabilityOptions;
  /** See {@link ExecutionOptions}. */
  execution?: ExecutionOptions;
  /** See {@link ChecksOptions}. */
  checks?: ChecksOptions;
}

export interface LoomStores {
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  branchRegistry?: BranchRegistry;
  /**
   * The backing store for `app.memory` and `app.knowledge(...)` — present only when one
   * was CONFIGURED. Absent means the app fell back to the in-memory default, which is the
   * state worth being able to detect: agent memory and any corpus are lost on restart, and
   * an operator command that writes into one would be writing into a throwaway.
   */
  memoryStore?: MemoryStore;
  /**
   * The durable-timer store, present only when `timers` was configured. Absent means this
   * deployment has no timer firing at all — sleeps and scheduled flows never wake — which is
   * a thing an operator command must be able to SEE rather than infer from an empty table.
   */
  timerStore?: TimerStore;
  /**
   * The lease store, present only when `timers.leases` was configured. Absent is the answer
   * to "who owns this execution?" being *nobody is tracking that* — distinct from "every
   * lease is expired", which is a fleet that died. A diagnostic must not render the first as
   * a count of the second.
   */
  leaseStore?: LeaseStore;
}

export interface LoomApp {
  /**
   * Start the background services this app wired (today: the durable-timer service).
   * Idempotent, and a no-op when nothing with a lifecycle is configured. Called for you at
   * composition time unless `autostart: false` — this is the other half of that switch, so
   * "build now, run later" never means "built, and can never run".
   */
  start(): void;
  runtime: WorkflowRuntime;
  effectRuntime: EffectRuntime;
  projectionRuntime: ProjectionRuntime;
  bus: InProcessA2ABus;
  /** R9 — whether `security.strict` was enabled. */
  strict: boolean;
  /**
   * R9 — the resolved autonomy envelope, present when any bound is in force. Hand
   * `app.envelope.spawn` to `superviseChildren({ limits })` (the supervisor is app-owned, so
   * `defineConfig` cannot start it for you) and to `boundOrchestration` in flows.
   */
  envelope?: ResolvedEnvelope;
  /**
   * R9 — the kill switch in force: the one you supplied, or the in-memory one strict created
   * (an `InMemoryKillSwitch`, whose `stopAll`/`stopTenant`/`stopWorkflow` is the admin API).
   */
  killSwitch?: KillSwitchRegistry;
  stores: LoomStores;
  /** Tool definitions discovered from `toolModules` (metadata; register effects separately). */
  tools: ToolDefinition[];
  /**
   * Skill registry holding every `skill$` definition from `skills` + `skillModules` — the
   * deterministic, offline selection surface (`app.skills.find(query)`). Empty when none declared.
   */
  skills: SkillRegistry;
  /**
   * Schedule definitions from `scheduleModules` + `timers.schedules` (for introspection). These are
   * wired into the `TimerService` and fire only when `timers` is configured; empty when none.
   */
  schedules: ScheduleDefinition[];
  /**
   * Memory runtime holding every `memory$` definition from `memories` + `memoryModules`, backed by
   * `memoryStore` (in-memory by default). Agents resolve their `memoryId` against it.
   */
  memory: MemoryRuntime;
  /**
   * Open (or return) the document corpus named `scope`, over the same `memoryStore` that
   * backs `app.memory` (ADR 0091). One `KnowledgeBase` per scope, cached: two instances of
   * one corpus are not wrong, they are just two objects doing the same work.
   *
   * `options` may only be passed the FIRST time a scope is opened. A second call that
   * passes them for an already-open corpus throws rather than silently ignoring them —
   * two parts of an app configuring one corpus with different chunkers would chunk it
   * differently on alternate ingests, which shows up as retrieval quality and nothing else.
   *
   * Throws if a `memory$` definition shares the corpus tier's id AND evicts: the two run
   * over the same store, so reading that memory through `app.memory` would evict passages
   * the corpus manifest still counts.
   */
  knowledge(scope: string, options?: Omit<KnowledgeBaseConfig, "memory" | "scope">): KnowledgeBase;
  /**
   * K10.1 log lifecycle — explicit retention/compaction over this app's stores, with the
   * branch-integrity guard wired when a `branchRegistry` is present. Drive it from an
   * operator pass (`loom retention run`); nothing runs it on a timer. See {@link LogLifecycle}.
   */
  lifecycle: LogLifecycle;
  /**
   * ADR 0118 D4 — what `superviseChildren({ redrive })` needs, present only when
   * `kernel.features.redrive` is on AND `timers` is configured: the `TimerStore` the re-drive rows
   * are written to and the `TimerService` that fires them.
   */
  redrive?: { timers: TimerStore; service: TimerService };
  /**
   * ADR 0118 D3 — register the app-owned child supervisor so `lifecycle` retention does not delete a
   * finished child whose parent is still parked on it (`pinParkedChildren`, composed with
   * `durability.retention.pinned` by OR). Returns the supervisor, so it composes inline:
   * `const supervisor = app.supervise(superviseChildren({ runtime: app.runtime, flows }))`.
   * `defineConfig` cannot do this itself: the supervisor is built FROM the runtime it returns.
   */
  supervise<S extends { parkedOnChild(executionId: string): Promise<boolean> }>(supervisor: S): S;
  /**
   * T3 — live subject index (`subjectId → executions`), present only when `compliance` is
   * wired. Fed by the event stream; rebuildable from the log. See `@loom/compliance`.
   */
  subjectIndex?: SubjectIndex;
  /**
   * T3 — assemble a data-subject export (Art. 15 access + Art. 20 portability) for every
   * execution the subject index attributes to `subjectId`. Throws if `compliance` is not
   * configured. For a partially-erased subject, wire the crypto store in tolerant mode
   * (K10-R4) so shredded fields export as `{ $shredded }` rather than throwing.
   */
  exportSubject(
    subjectId: string,
    options?: { includeEvents?: boolean; tenant?: string }
  ): Promise<SubjectExport>;
  /**
   * T3 — request erasure of a subject (Art. 17), optionally scoped to a `tenant` (T3-R2.4).
   * Shreds now if the subject's executions are all terminal, else parks the request and
   * completes it when the last one terminates; a PARKED (suspended) execution counts as live
   * unless `options.parked` is `"shred"` (opt-in; see `EraseSubjectOptions`). Throws unless
   * `compliance.erase` is configured.
   */
  eraseSubject(
    subjectId: string,
    tenant?: string,
    options?: EraseSubjectOptions
  ): Promise<EraseSubjectResult>;
  /**
   * Re-run pre-flight verification on demand (read-only, off-log). Returns the report;
   * the caller decides what to do with it (the CLI exits non-zero on `!ok`). Available
   * regardless of the `verify` config key. `options.lint` merges EXTRA compiler-lint
   * findings (per-flow, over any configured `verify.lint`) — `loom verify` uses this to
   * inject the compiler manifest's ADR 0061 `loopIdentity` field automatically. See
   * `@loom/verify`.
   */
  verify(options?: { lint?: VerifyLintInputs }): VerificationReport;
  close(): Promise<void>;
}

function buildStores(storage: StorageConfig): LoomStores {
  if (storage.kind === "custom") {
    // Bring your own backend — used verbatim. Concrete backends arrive this way via
    // a store plugin's preset (`sqliteStorage()`, `postgresStorage()`, …), so
    // `@loom/app` stays free of any vendor dependency (ADR 0043).
    return {
      eventStore: storage.eventStore,
      snapshotStore: storage.snapshotStore,
      ...(storage.branchRegistry !== undefined && { branchRegistry: storage.branchRegistry }),
    };
  }
  // storage.kind === "memory" — the only backend the composition root itself knows.
  return {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
  };
}

/**
 * Every option in one flat internal shape, whichever spelling the app used.
 *
 * The dual surface stops here: `defineConfig`'s body reads this and never asks whether an
 * option came from. Groups are how an app WRITES the config; this is how the file reads
 * it, and keeping the two separate means moving an option between groups is a change to
 * `GROUPED_OPTIONS` and nothing else.
 */
type ResolvedConfig = Omit<
  LoomConfig,
  "security" | "observability" | "durability" | "execution" | "checks"
> &
  SecurityOptions &
  ObservabilityOptions &
  DurabilityOptions &
  ExecutionOptions &
  ChecksOptions;

/** Options that moved into a group, paired with the group that now owns them. */
export const GROUPED_OPTIONS = [
  [
    "security",
    [
      "authorizer",
      "policies",
      "secrets",
      "resumeAuthenticator",
      "executionAuthorizer",
      "onExecutionDenied",
      "compliance",
      "strict",
      "killSwitch",
      "principalCodec",
      "principalResolver",
      "crypto",
    ],
  ],
  ["observability", ["telemetry", "onEvent", "onWarn", "onStorageError"]],
  ["durability", ["snapshotEvery", "retention"]],
  [
    "execution",
    [
      "dispatcher",
      "effectMiddleware",
      "registerEffects",
      "now",
      "validateInput",
      "envelope",
      "errorClasses",
    ],
  ],
  ["checks", ["validate", "verify", "manifest"]],
] as const;

/**
 * Flatten the groups into the one shape `defineConfig`'s body reads.
 *
 * The grouping is presentation: it decides how an app WRITES the config, not how this
 * file consumes it. Normalizing once at the boundary means the ~100 reads below never ask
 * which group an option came from, so moving an option between groups is a change to this
 * table and nothing else.
 */
export function normalizeConfig(config: LoomConfig): ResolvedConfig {
  const supplied = config as unknown as Record<string, unknown>;
  const resolved = { ...supplied };
  const moved: string[] = [];
  for (const [group, options] of GROUPED_OPTIONS) {
    const bag = supplied[group] as Record<string, unknown> | undefined;
    delete resolved[group];
    for (const option of options) {
      // A pre-grouping spelling. TypeScript rejects it on an object literal, but a config
      // built up dynamically — or any JS caller — reaches here typed as nothing at all,
      // and `{...supplied}` would have carried it through and quietly WORKED. Removing the
      // declaration without this makes the option removed in the types and live in the
      // runtime, which is the worst of both: no editor help, no error, and an app that
      // breaks whenever the spread stops covering for it.
      if (supplied[option] !== undefined) moved.push(`\`${option}\` → \`${group}.${option}\``);
      delete resolved[option];
      if (bag?.[option] !== undefined) resolved[option] = bag[option];
    }
  }
  if (moved.length > 0) {
    throw new Error(
      `defineConfig: ${moved.join(", ")} — these options now live in a group. Move them, or pin @loom/app to the previous version.`
    );
  }
  return resolved as unknown as ResolvedConfig;
}

/**
 * Assemble a Loom app from a static config: stores, an EffectRuntime wired with
 * middleware, a projection runtime with surfaces, telemetry, the WorkflowRuntime,
 * registered flows, and the A2A bus with agent/capability routes. Returns the
 * assembled pieces — the app still owns its Orchestrator and transport.
 *
 * This is sugar over the existing DI: everything it returns can also be hand-
 * built, and hand-wiring keeps working unchanged.
 */
export function defineConfig(rawConfig: LoomConfig): LoomApp {
  const config = normalizeConfig(rawConfig);

  // R9 — strict profile. Resolved FIRST so a refusal happens before anything is built.
  const strictOpts: StrictOptions | undefined =
    config.strict === true ? {} : config.strict === false ? undefined : config.strict;
  const strict = strictOpts !== undefined;
  const warnOut = config.onWarn ?? ((m: string) => console.warn(`[loom] ${m}`));
  const posture = {
    authorizer: config.authorizer,
    executionAuthorizer: config.executionAuthorizer,
    resumeAuthenticator: config.resumeAuthenticator,
    resumeAuthenticatorOptional: strictOpts?.requireResumeAuthenticator === false,
    verify: config.verify,
    envelope: config.envelope,
    killSwitch: config.killSwitch,
  };
  if (strict) {
    const problems = strictProblems(posture);
    if (problems.length > 0) {
      throw new Error(
        `[loom] security.strict: cannot compose this app —\n${problems.map((p) => `  - ${p}`).join("\n")}\nSet \`security.strict: false\` to opt out explicitly.`
      );
    }
  } else if (config.strict === undefined) {
    const notice = permissiveNotice(posture);
    if (notice !== undefined) warnOut(notice);
  }
  // R3k — how the principal's identity may be recorded. Resolved before anything is built, so a
  // refusal leaves nothing half-composed; the crypto paths are registered once it is decided.
  const principalIdentity = resolvePrincipalIdentity({
    strict,
    compliance: config.compliance !== undefined,
    crypto: config.crypto,
    codec: config.principalCodec,
  });
  if (config.crypto !== undefined) registerPrincipalPaths(config.crypto);
  if (config.crypto !== undefined && config.kernel?.features?.inbox === true) {
    registerInboxPaths(config.crypto);
  }
  const killSwitch: KillSwitchRegistry | undefined =
    config.killSwitch ?? (strict ? new InMemoryKillSwitch() : undefined);
  const ledger = new BudgetLedger();
  const spawn = resolveSpawn(config.envelope?.spawn, strict);
  const envelopeActive = Object.keys(spawn).length > 0 || budgetConfigured(config.envelope, strict);
  const stores = buildStores(config.storage);
  // Present only when CONFIGURED — see LoomStores.memoryStore for why the distinction is
  // the useful part.
  if (config.memoryStore !== undefined) stores.memoryStore = config.memoryStore;
  // Same contract for the two stores an operator pass needs to find: what the app WIRED, not
  // a default standing in for it. A diagnostic can then distinguish "not configured" from
  // "configured and empty" — the distinction the whole census turns on.
  if (config.timers !== undefined) stores.timerStore = config.timers.store;
  if (config.timers?.leases !== undefined) stores.leaseStore = config.timers.leases.store;

  // K10-R2 — secret redaction runs OUTERMOST on the effect path (it must resolve input
  // references before any other middleware sees the value, and redact output references
  // last). Its per-step secret-output paths are populated AFTER flow registration into a
  // Map the redactOutput closure reads by reference, so the map is mutated in place — never
  // reassigned — to keep that reference live.
  const secretPathsByStep = new Map<string, readonly string[]>();
  // Order (outermost first): kill switch → redaction → envelope (rate limit, budget) → user.
  // A stopped effect must never resolve a secret or spend budget, and the envelope's refusals
  // must come before user middleware (a retry wrapper must not re-attempt a refused effect).
  const effectMiddleware: EffectMiddleware[] = [
    ...envelopeMiddleware(config.envelope, strict, ledger),
    ...(config.effectMiddleware ?? []),
  ];
  if (config.secrets !== undefined) {
    effectMiddleware.unshift(
      redactionMiddleware({
        resolver: config.secrets.resolver,
        redactOutput: redactOutputFrom(secretPathsByStep),
      })
    );
  }
  if (killSwitch !== undefined) effectMiddleware.unshift(killSwitchMiddleware(killSwitch));
  // Policy enforcement (policy$ → K2 ring). Per-flow policies are read from each flow's
  // `policies` (config.flows + flowModules — read by shape, no runtime needed yet); `config.policies`
  // are global. A PolicyAuthorizer composes UNDER config.authorizer (both must allow). No policies
  // ⇒ the authorizer is exactly config.authorizer, so behaviour is byte-identical to before.
  const flowPolicies: Record<string, PolicyDefinition[]> = {};
  const addPolicies = (workflowId: string, pols?: PolicyDefinition[]): void => {
    if (!pols || pols.length === 0) return;
    const existing = flowPolicies[workflowId];
    if (existing) existing.push(...pols);
    else flowPolicies[workflowId] = [...pols];
  };
  for (const flow of [
    ...(config.flows ?? []),
    ...registeredFlowsFrom(...(config.flowModules ?? [])),
  ]) {
    addPolicies(flow.definition.id, flow.definition.policies);
  }
  // Agent-attached policies (`agent$({ policies })`). A capability-bound agent runs a flow via the
  // A2A executor (`runtime.start(flow)`), so its effects execute under that flow's workflowId — the
  // agent's policies bind to `capabilityAgents[capabilityId] → agent`, keyed by the capability's
  // flow. They merge with any flow-level policies on the same flow.
  const agentDefsById = new Map<string, AgentDefinition>();
  for (const entry of [
    ...(config.agents ?? []),
    ...agentDefinitionsFrom(...(config.agentModules ?? [])),
  ]) {
    if ("_tag" in entry && entry._tag === "AgentDefinition") agentDefsById.set(entry.id, entry);
  }
  for (const [capabilityId, agentId] of Object.entries(config.capabilityAgents ?? {})) {
    const agent = agentDefsById.get(agentId);
    const cap = config.catalog?.get(capabilityId);
    if (agent?.policies && cap) addPolicies(cap.flow.definition.id, agent.policies);
  }
  const globalPolicies = config.policies ?? [];
  const hasPolicies = globalPolicies.length > 0 || Object.keys(flowPolicies).length > 0;
  const authorizer: CapabilityAuthorizer | undefined = hasPolicies
    ? new PolicyAuthorizer(flowPolicies, {
        global: globalPolicies,
        ...(config.authorizer !== undefined && { base: config.authorizer }),
      })
    : config.authorizer;

  const effectRuntime = new EffectRuntime(
    effectMiddleware,
    authorizer !== undefined ? { authorizer } : {}
  );
  // Composition-time effect registration (single-effect dispatchers like
  // mcp.invoke / sandbox.eval register here; P5 — static, at boot).
  config.registerEffects?.(effectRuntime);

  const projectionRuntime = config.projectionRuntime ?? new InMemoryProjectionRuntime();
  for (const surface of config.surfaces ?? []) {
    const [id, redact] =
      typeof surface === "string" ? [surface, undefined] : [surface.id, surface.redact];
    projectionRuntime.register(
      agentSurfaceProjection(id, ...(redact !== undefined ? [{ redact }] : []))
    );
  }

  // projection$ definitions (explicit + discovered via projectionModules) folded into the
  // projection runtime. Each is adapted to the runtime's Projection shape; a compiler-emitted
  // lazy-handlers ref becomes an event-type-gated `lazy` projection (its fold code loads on the
  // first matching event), otherwise the inline fold map is used directly.
  for (const def of [
    ...(config.projections ?? []),
    ...projectionDefinitionsFrom(...(config.projectionModules ?? [])),
  ]) {
    projectionRuntime.register(
      isProjectionHandlersRef(def.handlers)
        ? {
            id: def.id,
            initialState: def.initialState,
            // ADR 0095 — the declared fold semantics travel with the registration, so
            // `projectionRuntime.pins()` can answer what an artifact's recorded pin is
            // compared against.
            ...(def.version !== undefined && { version: def.version }),
            lazy: {
              eventTypes: projectionEventTypes(def.handlers),
              load: () => loadProjectionHandlers(def.handlers),
            },
          }
        : {
            id: def.id,
            initialState: def.initialState,
            ...(def.version !== undefined && { version: def.version }),
            handlers: def.handlers,
          }
    );
  }

  // Built AFTER flow registration (below) so K10-R6 egress scrubbing can derive its paths
  // from the registered steps' schemas. `onEvent` reads it by closure; no event can fire
  // before defineConfig returns, so the deferred assignment is safe.
  let telemetryHook: ((event: EventEnvelope) => void) | undefined;

  // T3 — subject index, fed live off the event stream (rebuildable from the log). Cheap to
  // construct; only built when `compliance` is wired (G2).
  const subjectIndex =
    config.compliance !== undefined
      ? new SubjectIndex(config.compliance.subjectOf, {
          ...(config.compliance.tenantOf !== undefined && { tenantOf: config.compliance.tenantOf }),
        })
      : undefined;

  // T3 Phase B — erasure coordinator, only when erasure is wired. Rehydrates any parked
  // requests from the durable control stream (best-effort, so a restart resumes deferrals).
  const eraseCoordinator =
    subjectIndex !== undefined && config.compliance?.erase !== undefined
      ? new EraseCoordinator({
          index: subjectIndex,
          eventStore: stores.eventStore,
          snapshotStore: stores.snapshotStore,
          shred: config.compliance.erase.shred,
          // `parked: "shred"` cancels each parked owner first, under the runtime's own authority.
          // `runtime` is assigned below; nothing erases before defineConfig returns.
          cancel: (executionId, reason) =>
            runtime.cancel(executionId, reason, runtime.systemOptions()),
        })
      : undefined;
  // Both erasure calls read (and eventually write) the durable store, so both reject on an
  // ordinary storage failure — and nothing awaits either, so an escaping rejection is
  // UNHANDLED and Node terminates the process by default. A blip while reading the parked
  // list at boot, or while folding one event, would take the whole app down.
  //
  // Reported rather than swallowed: an erasure that did not complete is a compliance fact
  // someone has to know about. It stays parked durably (`ERASURE_PENDING`), so the next
  // terminal event for that subject retries it.
  const warnErasure = (err: unknown): void => {
    const warn = config.onWarn ?? ((m: string) => console.warn(`[loom] ${m}`));
    warn(`erasure coordinator: ${String(err)} — the request stays parked and will retry`);
  };
  void eraseCoordinator?.loadParked().catch(warnErasure);

  const onEvent = (event: EventEnvelope): void => {
    projectionRuntime.handleEvent(event);
    subjectIndex?.handleEvent(event); // index BEFORE coordinator (it reads the index)
    // Fire-and-forget: a parked erasure completes asynchronously once its last fold ends.
    void eraseCoordinator?.handleEvent(event).catch(warnErasure);
    telemetryHook?.(event);
    config.onEvent?.(event);
  };

  const runtime = new WorkflowRuntime({
    eventStore: stores.eventStore,
    snapshotStore: stores.snapshotStore,
    effectRuntime,
    onEvent,
    // ADR 0114: the kernel names no UI vocabulary, so the composed app injects the `ctx.ui` accessor.
    surface: createSurfaceEmitter,
    ...(stores.branchRegistry !== undefined && { branchRegistry: stores.branchRegistry }),
    ...(config.timers !== undefined && { timerStore: config.timers.store }),
    ...(config.validateInput !== undefined && { validateInput: config.validateInput }),
    ...(config.snapshotEvery !== undefined && { snapshotEvery: config.snapshotEvery }),
    ...(config.kernel?.meterCeilings !== undefined && {
      meterCeilings: config.kernel.meterCeilings,
    }),
    // ADR 0113 D3 — an explicit setting wins; otherwise strict flips the default to `fail`.
    ...((config.kernel?.divergence !== undefined || strict) && {
      divergence: config.kernel?.divergence ?? STRICT_DEFAULTS.divergence,
    }),
    ...(config.kernel?.features?.sha256FlowHash === true && { sha256FlowHash: true }),
    ...(config.kernel?.features?.scopes === true && { scopes: true }),
    ...(config.kernel?.features?.continueAsNew === true && {
      continueAsNewEnabled: true,
      ...(config.kernel.continuation?.maxCarryBytes !== undefined && {
        maxCarryBytes: config.kernel.continuation.maxCarryBytes,
      }),
      ...(config.kernel.continuation?.maxChainHops !== undefined && {
        maxChainHops: config.kernel.continuation.maxChainHops,
      }),
    }),
    ...(config.kernel?.features?.inbox === true && {
      inboxEnabled: true,
      ...(config.kernel.inbox?.maxBacklog !== undefined && {
        inboxMaxBacklog: config.kernel.inbox.maxBacklog,
      }),
      ...(config.kernel.inbox?.maxRetained !== undefined && {
        inboxMaxRetained: config.kernel.inbox.maxRetained,
      }),
      ...(config.kernel.inbox?.maxPayloadBytes !== undefined && {
        inboxMaxPayloadBytes: config.kernel.inbox.maxPayloadBytes,
      }),
      ...(config.kernel.inbox?.messageTtlMs !== undefined && {
        inboxMessageTtlMs: config.kernel.inbox.messageTtlMs,
      }),
    }),
    ...(config.errorClasses !== undefined && { errorClasses: config.errorClasses }),
    ...(config.onStorageError !== undefined && { onStorageError: config.onStorageError }),
    // One warning channel for the app: the same sink that reports a schedule which can
    // never fire also reports a deadline this runtime cannot keep.
    ...(config.onWarn !== undefined && { onWarn: config.onWarn }),
    ...(config.resumeAuthenticator !== undefined && {
      resumeAuthenticator: config.resumeAuthenticator,
    }),
    ...(config.executionAuthorizer !== undefined && {
      executionAuthorizer: config.executionAuthorizer,
    }),
    // R3 — under strict a principal-less lifecycle call reaches the authorizer (fail-closed).
    ...(strict &&
      strictOpts?.requirePrincipal !== false && {
        executionAuthz: { requirePrincipal: true },
      }),
    ...(config.onExecutionDenied !== undefined && {
      onExecutionDenied: config.onExecutionDenied,
    }),
    ...(config.principalCodec !== undefined && { principalCodec: config.principalCodec }),
    ...(config.principalResolver !== undefined && { principalResolver: config.principalResolver }),
    principalIdentity,
    ...(config.now !== undefined && { now: config.now }),
  });

  // R9 — default execution deadline (strict only). See `withDefaultDeadline` for why it wraps
  // the entry points instead of rewriting flow definitions.
  const defaultDeadline =
    strictOpts?.defaultDeadlineMs === false
      ? undefined
      : strict
        ? (strictOpts?.defaultDeadlineMs ?? STRICT_DEFAULTS.defaultDeadlineMs)
        : undefined;
  if (defaultDeadline !== undefined) withDefaultDeadline(runtime, defaultDeadline);

  // Schedules come from the explicit `timers.schedules` list AND from `scheduleModules` (loom gen
  // discovery, value-shape). Both feed the one TimerService. Exposed on `app.schedules`.
  const schedules = [
    ...(config.timers?.schedules ?? []),
    ...scheduleDefinitionsFrom(...(config.scheduleModules ?? [])),
  ];

  // T1 — durable-timer firing service (opt-in; stopped on close()).
  let timerService: TimerService | undefined;
  if (config.timers !== undefined) {
    timerService = new TimerService(runtime, config.timers.store, {
      ...(config.timers.pollMs !== undefined && { pollMs: config.timers.pollMs }),
      ...(schedules.length > 0 && { schedules }),
      ...(config.timers.fenced !== undefined && { fenced: config.timers.fenced }),
      ...(config.timers.warmLeadMs !== undefined && { warmLeadMs: config.timers.warmLeadMs }),
      ...(config.timers.dispatcher !== undefined && { dispatcher: config.timers.dispatcher }),
      ...(config.timers.leases !== undefined && { leases: config.timers.leases }),
    });
    // Composition starts it, unless the caller is inspecting rather than running (`autostart`).
    //
    // The env var is how a TOOL asks a config it did not write to be inspectable. An operator
    // running `loom census --config ./dist/app.js` cannot edit that module, and the start
    // happens during `import` — before any of the command's own code runs — so the request has
    // to be in place beforehand. It only ever suppresses, never starts.
    const inspectOnly = process.env.LOOM_NO_AUTOSTART === "1";
    if (config.autostart !== false && !inspectOnly) {
      timerService.start();
    } else if (inspectOnly && config.autostart === true) {
      // Suppressing a DEFAULT is the quiet, expected case. Suppressing what a config asked for
      // explicitly is someone's intent being overridden by an environment variable — the one
      // way this could silently stop timers in production, so it says so.
      const warn = config.onWarn ?? ((m: string) => console.warn(`[loom] ${m}`));
      warn(
        "LOOM_NO_AUTOSTART=1 — background services were NOT started, though this config sets `autostart: true`. Unset it to run normally."
      );
    }
  } else if (schedules.length > 0) {
    // Discovered/declared schedules can't fire without a TimerStore — surface it loudly at boot
    // rather than silently never running them.
    const warn = config.onWarn ?? ((m: string) => console.warn(`[loom] ${m}`));
    warn(
      `${schedules.length} schedule(s) declared but no \`timers\` store is configured — they will not fire. Add \`timers: { store }\` to enable cron.`
    );
  }

  // ADR 0118 D4 — the re-drive flag. Resolved here, beside the TimerService it hands out.
  let redrive: { timers: TimerStore; service: TimerService } | undefined;
  if (config.kernel?.features?.redrive === true) {
    if (timerService !== undefined && config.timers !== undefined) {
      redrive = { timers: config.timers.store, service: timerService };
    } else {
      const warn = config.onWarn ?? ((m: string) => console.warn(`[loom] ${m}`));
      warn(
        "kernel.features.redrive is on but no `timers` store is configured — nothing can fire a re-drive row, so a contended resume is reported through onError and left to recover()."
      );
    }
  }

  // ADR 0110 — the durable inbox's cross-process wake and its timer arms need a TimerStore.
  if (config.kernel?.features?.inbox === true && config.timers === undefined) {
    const warn = config.onWarn ?? ((m: string) => console.warn(`[loom] ${m}`));
    warn(
      "kernel.features.inbox is on but no `timers` store is configured — a message sent from another process cannot wake a parked execution, and a ctx.select timer arm never fires. Add `timers: { store }`."
    );
  }

  // K10.1 — log lifecycle wired over the same stores. Cheap to construct; drives nothing
  // until a caller invokes applyRetention/compact (G2). The branch guard is active whenever
  // the backend supplies a branchRegistry.
  // ADR 0118 D3 — a supervisor registered through `app.supervise` pins the children its parents are
  // parked on; ORed with the app's own predicate. Constructed unconditionally and inert until a
  // supervisor is registered, so the predicate is only added to the lifecycle when one could exist
  // (it is consulted at retention time, never on a hot path).
  const supervisors: Array<{ parkedOnChild(executionId: string): Promise<boolean> }> = [];
  const pinned = async (executionId: string): Promise<boolean> => {
    if (config.retention?.pinned !== undefined && (await config.retention.pinned(executionId))) {
      return true;
    }
    for (const s of supervisors) if (await s.parkedOnChild(executionId)) return true;
    return false;
  };
  const lifecycle = new LogLifecycle(stores.eventStore, stores.snapshotStore, {
    ...(config.retention?.archive !== undefined && { archive: config.retention.archive }),
    pinned,
    ...(config.retention?.pinnedEventTypes !== undefined && {
      pinnedEventTypes: config.retention.pinnedEventTypes,
    }),
    ...(config.retention?.compactionExempt !== undefined && {
      compactionExempt: config.retention.compactionExempt,
    }),
    ...(config.onWarn !== undefined && { onWarn: config.onWarn }),
    ...(stores.branchRegistry !== undefined && { branchRegistry: stores.branchRegistry }),
  });

  config.catalog?.registerInto(runtime);
  for (const flow of config.flows ?? []) {
    runtime.registerFlow(flow.definition, flow.runner);
  }
  if (config.flowModules && config.flowModules.length > 0) {
    registerFlowsFrom(runtime, ...config.flowModules);
  }

  // Every flow is now registered — gather the full step set once for the derivations below.
  const allSteps = runtime
    .getFlowIds()
    .flatMap((id) => runtime.getFlow(id)?.definition.steps ?? []);

  // K10-R2 — derive each step's secret-output paths from its `secret()`-marked schema and
  // fill the (by-reference) map the redactOutput closure reads. Mutated, not reassigned.
  if (config.secrets !== undefined) {
    for (const [stepId, paths] of secretOutputPathsByStep(allSteps)) {
      secretPathsByStep.set(stepId, paths);
    }
  }

  // K10-R6 — telemetry is a separate egress (data ships OUTSIDE the trust boundary). Scrub
  // `sensitive`/`internal`-marked fields (K10-R1) from step input/output before any adapter
  // sees them. Automatic when telemetry is wired and a field is marked; a pass-through
  // otherwise (G2 — scrubbingAdapter returns the inner adapter unchanged on an empty map).
  if (config.telemetry && config.telemetry.length > 0) {
    const composed = composeAdapters(...config.telemetry);
    telemetryHook = createTelemetryHook(scrubbingAdapter(composed, scrubPathsByStep(allSteps)));
  }

  if (config.manifest) {
    const warn = config.onWarn ?? ((m: string) => console.warn(`[loom] ${m}`));
    for (const message of manifestWarnings(
      config.manifest,
      (id) => runtime.getFlow(id) !== undefined
    )) {
      warn(message);
    }
  }

  // Tool definitions discovered from `toolModules` (value-shape; metadata only — effects are
  // registered explicitly, tool$ carries no handler). Exposed on the app for introspection.
  const tools = toolDefinitionsFrom(...(config.toolModules ?? []));

  // Skills come from the explicit `skills` list AND from `skillModules` (loom gen discovery,
  // value-shape). Both register into one SkillRegistry — the offline, replay-safe selection
  // surface. Only metadata is held here; each skill's instructions$ body stays lazy (ADR 0044).
  const skills = new SkillRegistry();
  for (const skill of [
    ...(config.skills ?? []),
    ...skillDefinitionsFrom(...(config.skillModules ?? [])),
  ]) {
    skills.register(skill);
  }

  // Memory definitions from the explicit `memories` list + `memoryModules` (loom gen discovery),
  // registered into one MemoryRuntime backed by `memoryStore` (in-memory default). Agents resolve
  // their `memoryId` against `app.memory`.
  // Materialized rather than defaulted inside MemoryRuntime, so `app.knowledge(...)` can
  // put a corpus in the SAME store as `app.memory`. Two stores would be two corpora that
  // look like one.
  const memoryStore = config.memoryStore ?? new InMemoryMemoryStore();
  const memory = new MemoryRuntime(memoryStore);
  for (const def of [
    ...(config.memories ?? []),
    ...memoryDefinitionsFrom(...(config.memoryModules ?? [])),
  ]) {
    memory.register(def);
  }

  /** One KnowledgeBase per `tier::scope`, opened on demand by `app.knowledge(...)`. */
  const corpora = new Map<string, KnowledgeBase>();

  const bus = new InProcessA2ABus(runtime, config.dispatcher);
  let unwiredDefs = 0;
  // Agents come from the explicit `agents` list AND from `agentModules` (loom gen discovery,
  // value-shape). Both feed the same wiring: cards register verbatim; agent$ definitions
  // auto-wire only behind the a2a/agentSurface flags.
  const allAgents = [
    ...(config.agents ?? []),
    ...agentDefinitionsFrom(...(config.agentModules ?? [])),
  ];
  for (const entry of allAgents) {
    // A hand-built AgentCard registers verbatim — the manual flow, unchanged.
    if (!("_tag" in entry && entry._tag === "AgentDefinition")) {
      bus.registerAgent(entry as AgentCard);
      continue;
    }
    // An agent$ definition is auto-wired ONLY behind the opt-in flags.
    const def = entry;
    if (config.a2a) bus.registerAgent(toAgentCard(def)); // derive + register its card
    if (config.agentSurface) projectionRuntime.register(agentSurfaceProjection(def.id)); // one surface per agent
    if (!config.a2a && !config.agentSurface) unwiredDefs += 1;
  }
  if (unwiredDefs > 0) {
    const warn = config.onWarn ?? ((m: string) => console.warn(`[loom] ${m}`));
    warn(
      `${unwiredDefs} agent definition(s) passed to \`agents\` but neither \`a2a\` nor \`agentSurface\` is enabled — they are not wired to anything. Enable a flag, or pass hand-built AgentCards to wire manually.`
    );
  }
  for (const [capabilityId, agentId] of Object.entries(config.capabilityAgents ?? {})) {
    const cap = config.catalog?.get(capabilityId);
    if (cap) bus.registerCapability(capabilityId, agentId, cap.flow);
  }

  if (config.validate) {
    const warn = config.onWarn ?? ((m: string) => console.warn(`[loom] ${m}`));
    const flows = runtime.getFlowIds().map((id) => {
      const def = runtime.getFlow(id)?.definition;
      return { id, steps: (def?.steps ?? []) as FlowGraphFlow["steps"] };
    });
    const issues = validateFlowGraph({
      flows,
      hasEffect: (toolId) => effectRuntime.has(toolId),
      ...(config.capabilityAgents !== undefined && { capabilityAgents: config.capabilityAgents }),
      ...(config.catalog !== undefined && {
        hasCapability: (id: string) => config.catalog?.get(id) !== undefined,
      }),
    });
    for (const issue of issues) {
      const message = `${issue.severity}: ${issue.detail}`;
      if (config.validate === "error" && issue.severity === "error") {
        throw new Error(`[loom] flow-graph validation failed — ${message}`);
      }
      warn(message);
    }
  }

  // Pre-flight verification (opt-in, G2). Built lazily so an unwired app pays nothing:
  // with no `verify` key and no `app.verify()` call, `resolveInput` never runs.
  const verifyCfg = normalizeVerify(
    config.verify ??
      // Strict keeps pre-flight verification on; the envelope's metering reports these dimensions.
      (strict
        ? { mode: "error", meteredDimensions: ["tokens", "costUsd", "ms"] as const }
        : undefined)
  );
  // Compiler lint findings (issue #82 nondeterminism; ADR 0061 loop identity) flow
  // into the determinism rule. `extraLint` (from `app.verify({ lint })` — e.g. the
  // manifest's loopIdentity field injected by `loom verify`) merges per-flow OVER
  // the configured `verify.lint`.
  const resolveInput = (extraLint?: VerifyLintInputs) => {
    const nonDeterministicByFlow = {
      ...verifyCfg?.lint?.nonDeterministicByFlow,
      ...extraLint?.nonDeterministicByFlow,
    };
    const loopIdentityByFlow = {
      ...verifyCfg?.lint?.loopIdentityByFlow,
      ...extraLint?.loopIdentityByFlow,
    };
    // ADR 0086. Missing here meant the reach analysis was unreachable from the
    // only wiring an app actually uses — `resolveVerifyInput` took it, but
    // nothing routed it there. A capability the happy path cannot reach is the
    // same defect as one with no producer.
    const runnerReachByFlow = {
      ...verifyCfg?.lint?.runnerReachByFlow,
      ...extraLint?.runnerReachByFlow,
    };
    return resolveVerifyInput(runtime, {
      ...(authorizer !== undefined && { authorizer }),
      ...(config.dispatcher !== undefined && { dispatcher: config.dispatcher }),
      ...(verifyCfg?.meteredDimensions !== undefined && {
        meteredDimensions: verifyCfg.meteredDimensions,
      }),
      ...(verifyCfg?.effectClasses !== undefined && { effectClasses: verifyCfg.effectClasses }),
      ...(Object.keys(nonDeterministicByFlow).length > 0 && { nonDeterministicByFlow }),
      ...(Object.keys(loopIdentityByFlow).length > 0 && { loopIdentityByFlow }),
      ...(Object.keys(runnerReachByFlow).length > 0 && { runnerReachByFlow }),
      ...(verifyCfg?.reach !== undefined && { reachDeclarations: verifyCfg.reach }),
    });
  };
  const verifyOptions = verifyCfg?.rules !== undefined ? { rules: verifyCfg.rules } : undefined;

  if (verifyCfg !== undefined && verifyCfg.mode !== "off") {
    const warn = config.onWarn ?? ((m: string) => console.warn(`[loom] ${m}`));
    // "error" throws VerificationError before the app is returned (boot fails, like validate).
    runVerification(verifyCfg.mode, resolveInput, verifyOptions, warn);
  }

  return {
    runtime,
    effectRuntime,
    projectionRuntime,
    bus,
    strict,
    ...(envelopeActive && { envelope: { spawn, ledger } }),
    ...(killSwitch !== undefined && { killSwitch }),
    stores,
    tools,
    skills,
    schedules,
    memory,
    knowledge(scope, options) {
      const tier = options?.tier ?? "semantic";
      const key = `${tier}::${scope}`;
      const open = corpora.get(key);
      if (open !== undefined) {
        if (options !== undefined) {
          throw new Error(
            `[loom] knowledge("${scope}") is already open; its options were fixed by the first call. Configure a corpus once (a second chunker would chunk the same corpus differently on alternate ingests), or use a different scope.`
          );
        }
        return open;
      }
      const clash = memory.definitionFor(tier);
      if (clash?.ttlMs !== undefined || clash?.maxEntries !== undefined) {
        throw new Error(
          `[loom] knowledge("${scope}") uses memory tier "${tier}", but a memory$({ id: "${tier}" }) with ttlMs/maxEntries is registered over the same store. Reading it through app.memory would evict passages the corpus manifest still counts, so the corpus would retrieve as fragments of itself. Give the corpus its own tier: app.knowledge("${scope}", { tier: "knowledge" }).`
        );
      }
      const kb = openKnowledgeBase(memoryStore, { ...options, scope, tier });
      corpora.set(key, kb);
      return kb;
    },
    lifecycle,
    ...(redrive !== undefined && { redrive }),
    supervise(supervisor) {
      supervisors.push(supervisor);
      return supervisor;
    },
    ...(subjectIndex !== undefined && { subjectIndex }),
    exportSubject(subjectId, options) {
      if (subjectIndex === undefined) {
        // Reject (not throw) so the Promise-returning contract holds either way.
        return Promise.reject(
          new Error("[loom] exportSubject requires `compliance: { subjectOf }` in defineConfig")
        );
      }
      return exportSubjectData(subjectId, {
        index: subjectIndex,
        eventStore: stores.eventStore,
        ...(options?.includeEvents !== undefined && { includeEvents: options.includeEvents }),
        ...(options?.tenant !== undefined && { tenant: options.tenant }),
      });
    },
    eraseSubject(subjectId, tenant, options) {
      if (eraseCoordinator === undefined) {
        return Promise.reject(
          new Error("[loom] eraseSubject requires `compliance: { subjectOf, erase: { shred } }`")
        );
      }
      return eraseCoordinator.eraseSubject(subjectId, tenant, options);
    },
    verify(options) {
      return runVerify(resolveInput(options?.lint), verifyOptions);
    },
    start() {
      timerService?.start();
    },
    async close() {
      timerService?.stop();
      await config.timers?.store.close();
      await stores.eventStore.close();
      await stores.snapshotStore.close();
      await stores.branchRegistry?.close();
    },
  };
}
