import { SkillRegistry } from "@loom/agent";
import { agentSurfaceProjection } from "@loom/agent-surface";
import {
  EraseCoordinator,
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
  EventEnvelope,
  MemoryDefinition,
  PolicyDefinition,
  ProjectionDefinition,
  ScheduleDefinition,
  SkillDefinition,
  ToolDefinition,
} from "@loom/core";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import { EffectRuntime, PolicyAuthorizer } from "@loom/effect-runtime";
import type { CapabilityAuthorizer, EffectMiddleware } from "@loom/effect-runtime";
import type { BranchRegistry, EventStore, TimerStore } from "@loom/event-runtime";
// Only the in-memory stores are imported statically — they are pure JS. We import
// them from the browser-safe `/memory` SUBPATH rather than the package barrel: the
// barrel also re-exports the SQLite stores (which `import "better-sqlite3"`), and
// these packages compile to CommonJS — which bundlers cannot tree-shake. The subpath
// keeps better-sqlite3 / node:fs out of browser bundles. The SQLite stores +
// node:fs/path are loaded lazily on the `kind:"sqlite"` path only (see
// `loadNodeModule`), so a browser app using in-memory storage stays clean.
import { InMemoryAsyncEventStore } from "@loom/event-runtime/memory";
import { MemoryRuntime } from "@loom/memory";
import type { MemoryStore } from "@loom/memory";
import {
  type SecretResolver,
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
import type { ArchiveStores, PinPredicate, RegisteredFlow } from "@loom/workflow-runtime";
import { InProcessA2ABus } from "./InProcessA2ABus";
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
  /** Projection definitions registered directly (in addition to any from `projectionModules`). */
  projections?: ProjectionDefinition[];
  /**
   * Optional compiler manifest to cross-check against — any flow the compiler saw
   * but that isn't registered (or that carries a compiler warning) is reported
   * via `onWarn` at boot rather than failing at dispatch.
   */
  manifest?: ManifestView;
  /** Sink for boot-time warnings (manifest cross-check + validation). Default `console.warn`. */
  onWarn?: (message: string) => void;
  /**
   * Run structural flow-graph validation at boot (missing effects, dangling
   * capability→agent maps). `true`/`"warn"` reports via `onWarn`; `"error"`
   * throws on the first error. See {@link validateFlowGraph}.
   */
  validate?: boolean | "warn" | "error";
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
  /** Static, ordered effect middleware (retries, logging, …). */
  effectMiddleware?: EffectMiddleware[];
  /**
   * DX (ADR 0063/0064 follow-up) — composition-time effect registration hook,
   * called once with the constructed `EffectRuntime` before any execution
   * starts. The seam that makes single-effect dispatchers compose declaratively:
   * `registerEffects: (fx) => { registerMcpInvoke(client, fx); registerSandboxEval(fx, store); }`.
   * Discovery (`toolModules`) supplies tool *metadata*; this supplies the
   * runnable effects. Static wiring (P5) — the hook runs at boot, never later.
   */
  registerEffects?: (effects: EffectRuntime) => void;
  /**
   * Capability protection ring (K2). When set, every effect is authorized against
   * it and ungranted effects are denied (least-privilege). Omit for permissive.
   * e.g. `new GrantTable({ "my-flow": ["metrics-tool", "logs-tool"] })`.
   */
  authorizer?: CapabilityAuthorizer;
  /**
   * App-global `policy$` definitions enforced on EVERY effect via a `PolicyAuthorizer`.
   * Per-flow policies are read automatically from each flow's `policies` (`flow$`); these
   * `policies` apply on top of them, everywhere. A policy composes UNDER {@link authorizer}
   * (both must allow — defense in depth), so it can tighten a grant but never widen it.
   * Enforcement is deny-wins; a flow with no governing policy is unaffected (opt-in).
   */
  policies?: PolicyDefinition[];
  /** Telemetry adapters, composed and wired to the event stream. */
  telemetry?: TelemetryAdapter[];
  /** Placement dispatcher for the bus (default: in-process). e.g. Cloud Run. */
  dispatcher?: ExecutionDispatcher;
  /** Extra event observer, fired after projection + telemetry. */
  onEvent?: (event: EventEnvelope) => void;
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
  };
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
  };
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
     * `shredSubject` (bound to the KeyStore + raw store); it MUST be idempotent (no-op when a
     * subject is already erased). Erasure is liveness-gated: shredded now if the subject's
     * executions are all terminal, else parked (durable `ERASURE_PENDING`) and auto-completed
     * when the last live execution terminates — never shredding a fold in flight.
     */
    erase?: { shred: Shredder };
  };
}

export interface LoomStores {
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  branchRegistry?: BranchRegistry;
}

export interface LoomApp {
  runtime: WorkflowRuntime;
  effectRuntime: EffectRuntime;
  projectionRuntime: ProjectionRuntime;
  bus: InProcessA2ABus;
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
   * K10.1 log lifecycle — explicit retention/compaction over this app's stores, with the
   * branch-integrity guard wired when a `branchRegistry` is present. Drive it from an
   * operator pass (`loom retention run`); nothing runs it on a timer. See {@link LogLifecycle}.
   */
  lifecycle: LogLifecycle;
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
   * completes it when the last one terminates. Throws unless `compliance.erase` is configured.
   */
  eraseSubject(subjectId: string, tenant?: string): Promise<EraseSubjectResult>;
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
 * Assemble a Loom app from a static config: stores, an EffectRuntime wired with
 * middleware, a projection runtime with surfaces, telemetry, the WorkflowRuntime,
 * registered flows, and the A2A bus with agent/capability routes. Returns the
 * assembled pieces — the app still owns its Orchestrator and transport.
 *
 * This is sugar over the existing DI: everything it returns can also be hand-
 * built, and hand-wiring keeps working unchanged.
 */
export function defineConfig(config: LoomConfig): LoomApp {
  const stores = buildStores(config.storage);

  // K10-R2 — secret redaction runs OUTERMOST on the effect path (it must resolve input
  // references before any other middleware sees the value, and redact output references
  // last). Its per-step secret-output paths are populated AFTER flow registration into a
  // Map the redactOutput closure reads by reference, so the map is mutated in place — never
  // reassigned — to keep that reference live.
  const secretPathsByStep = new Map<string, readonly string[]>();
  const effectMiddleware: EffectMiddleware[] = [...(config.effectMiddleware ?? [])];
  if (config.secrets !== undefined) {
    effectMiddleware.unshift(
      redactionMiddleware({
        resolver: config.secrets.resolver,
        redactOutput: redactOutputFrom(secretPathsByStep),
      })
    );
  }
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
            lazy: {
              eventTypes: projectionEventTypes(def.handlers),
              load: () => loadProjectionHandlers(def.handlers),
            },
          }
        : { id: def.id, initialState: def.initialState, handlers: def.handlers }
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
          shred: config.compliance.erase.shred,
        })
      : undefined;
  void eraseCoordinator?.loadParked();

  const onEvent = (event: EventEnvelope): void => {
    projectionRuntime.handleEvent(event);
    subjectIndex?.handleEvent(event); // index BEFORE coordinator (it reads the index)
    // Fire-and-forget: a parked erasure completes asynchronously once its last fold ends.
    void eraseCoordinator?.handleEvent(event);
    telemetryHook?.(event);
    config.onEvent?.(event);
  };

  const runtime = new WorkflowRuntime({
    eventStore: stores.eventStore,
    snapshotStore: stores.snapshotStore,
    effectRuntime,
    onEvent,
    ...(stores.branchRegistry !== undefined && { branchRegistry: stores.branchRegistry }),
    ...(config.timers !== undefined && { timerStore: config.timers.store }),
    ...(config.validateInput !== undefined && { validateInput: config.validateInput }),
  });

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
    });
    timerService.start();
  } else if (schedules.length > 0) {
    // Discovered/declared schedules can't fire without a TimerStore — surface it loudly at boot
    // rather than silently never running them.
    const warn = config.onWarn ?? ((m: string) => console.warn(`[loom] ${m}`));
    warn(
      `${schedules.length} schedule(s) declared but no \`timers\` store is configured — they will not fire. Add \`timers: { store }\` to enable cron.`
    );
  }

  // K10.1 — log lifecycle wired over the same stores. Cheap to construct; drives nothing
  // until a caller invokes applyRetention/compact (G2). The branch guard is active whenever
  // the backend supplies a branchRegistry.
  const lifecycle = new LogLifecycle(stores.eventStore, stores.snapshotStore, {
    ...(config.retention?.archive !== undefined && { archive: config.retention.archive }),
    ...(config.retention?.pinned !== undefined && { pinned: config.retention.pinned }),
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
  const memory =
    config.memoryStore !== undefined ? new MemoryRuntime(config.memoryStore) : new MemoryRuntime();
  for (const def of [
    ...(config.memories ?? []),
    ...memoryDefinitionsFrom(...(config.memoryModules ?? [])),
  ]) {
    memory.register(def);
  }

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
  const verifyCfg = normalizeVerify(config.verify);
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
    return resolveVerifyInput(runtime, {
      ...(authorizer !== undefined && { authorizer }),
      ...(config.dispatcher !== undefined && { dispatcher: config.dispatcher }),
      ...(verifyCfg?.meteredDimensions !== undefined && {
        meteredDimensions: verifyCfg.meteredDimensions,
      }),
      ...(Object.keys(nonDeterministicByFlow).length > 0 && { nonDeterministicByFlow }),
      ...(Object.keys(loopIdentityByFlow).length > 0 && { loopIdentityByFlow }),
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
    stores,
    tools,
    skills,
    schedules,
    memory,
    lifecycle,
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
    eraseSubject(subjectId, tenant) {
      if (eraseCoordinator === undefined) {
        return Promise.reject(
          new Error("[loom] eraseSubject requires `compliance: { subjectOf, erase: { shred } }`")
        );
      }
      return eraseCoordinator.eraseSubject(subjectId, tenant);
    },
    verify(options) {
      return runVerify(resolveInput(options?.lint), verifyOptions);
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
