import { a2uiSurfaceProjection } from "@loom/a2ui";
import type { EventEnvelope, ScheduleDefinition } from "@loom/core";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import { EffectRuntime } from "@loom/effect-runtime";
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
import type { AgentCard } from "@loom/plugin-a2a";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import type { SnapshotStore } from "@loom/snapshot-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime/memory";
import { composeAdapters, createTelemetryHook } from "@loom/telemetry";
import type { TelemetryAdapter } from "@loom/telemetry";
import { type VerificationReport, runVerification, verify as runVerify } from "@loom/verify";
import { LogLifecycle, TimerService, WorkflowRuntime } from "@loom/workflow-runtime";
import type { ArchiveStores, RegisteredFlow } from "@loom/workflow-runtime";
import { InProcessA2ABus } from "./InProcessA2ABus";
import {
  type FlowModule,
  type ManifestView,
  manifestWarnings,
  registerFlowsFrom,
} from "./registerFlows";
import { type FlowGraphFlow, validateFlowGraph } from "./validate";
import { type VerifyConfig, normalizeVerify, resolveVerifyInput } from "./verifyAdapter";

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
  /** A2UI surfaces to register on the projection runtime. */
  surfaces?: string[];
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
  /** Agent cards advertised on the in-process A2A bus. */
  agents?: AgentCard[];
  /** capabilityId → agentId routing for the bus. */
  capabilityAgents?: Record<string, string>;
  /** Static, ordered effect middleware (retries, logging, …). */
  effectMiddleware?: EffectMiddleware[];
  /**
   * Capability protection ring (K2). When set, every effect is authorized against
   * it and ungranted effects are denied (least-privilege). Omit for permissive.
   * e.g. `new GrantTable({ "my-flow": ["metrics-tool", "logs-tool"] })`.
   */
  authorizer?: CapabilityAuthorizer;
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
  retention?: {
    /** Where each execution's events/snapshot are copied before deletion (A6). */
    archive?: ArchiveStores;
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
  /**
   * K10.1 log lifecycle — explicit retention/compaction over this app's stores, with the
   * branch-integrity guard wired when a `branchRegistry` is present. Drive it from an
   * operator pass (`loom retention run`); nothing runs it on a timer. See {@link LogLifecycle}.
   */
  lifecycle: LogLifecycle;
  /**
   * Re-run pre-flight verification on demand (read-only, off-log). Returns the report;
   * the caller decides what to do with it (the CLI exits non-zero on `!ok`). Available
   * regardless of the `verify` config key. See `@loom/verify`.
   */
  verify(): VerificationReport;
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
  const effectRuntime = new EffectRuntime(
    config.effectMiddleware ?? [],
    config.authorizer !== undefined ? { authorizer: config.authorizer } : {}
  );

  const projectionRuntime = config.projectionRuntime ?? new InMemoryProjectionRuntime();
  for (const surface of config.surfaces ?? []) {
    projectionRuntime.register(a2uiSurfaceProjection(surface));
  }

  const telemetryHook =
    config.telemetry && config.telemetry.length > 0
      ? createTelemetryHook(composeAdapters(...config.telemetry))
      : undefined;

  const onEvent = (event: EventEnvelope): void => {
    projectionRuntime.handleEvent(event);
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
  });

  // T1 — durable-timer firing service (opt-in; stopped on close()).
  let timerService: TimerService | undefined;
  if (config.timers !== undefined) {
    timerService = new TimerService(runtime, config.timers.store, {
      ...(config.timers.pollMs !== undefined && { pollMs: config.timers.pollMs }),
      ...(config.timers.schedules !== undefined && { schedules: config.timers.schedules }),
      ...(config.timers.fenced !== undefined && { fenced: config.timers.fenced }),
      ...(config.timers.warmLeadMs !== undefined && { warmLeadMs: config.timers.warmLeadMs }),
    });
    timerService.start();
  }

  // K10.1 — log lifecycle wired over the same stores. Cheap to construct; drives nothing
  // until a caller invokes applyRetention/compact (G2). The branch guard is active whenever
  // the backend supplies a branchRegistry.
  const lifecycle = new LogLifecycle(stores.eventStore, stores.snapshotStore, {
    ...(config.retention?.archive !== undefined && { archive: config.retention.archive }),
    ...(stores.branchRegistry !== undefined && { branchRegistry: stores.branchRegistry }),
  });

  config.catalog?.registerInto(runtime);
  for (const flow of config.flows ?? []) {
    runtime.registerFlow(flow.definition, flow.runner);
  }
  if (config.flowModules && config.flowModules.length > 0) {
    registerFlowsFrom(runtime, ...config.flowModules);
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

  const bus = new InProcessA2ABus(runtime, config.dispatcher);
  for (const card of config.agents ?? []) {
    bus.registerAgent(card);
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
  const resolveInput = () =>
    resolveVerifyInput(runtime, {
      ...(config.authorizer !== undefined && { authorizer: config.authorizer }),
      ...(config.dispatcher !== undefined && { dispatcher: config.dispatcher }),
      ...(verifyCfg?.meteredDimensions !== undefined && {
        meteredDimensions: verifyCfg.meteredDimensions,
      }),
    });
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
    lifecycle,
    verify() {
      return runVerify(resolveInput(), verifyOptions);
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
