import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentCard } from "@loom/a2a";
import { a2uiSurfaceProjection } from "@loom/a2ui";
import type { EventEnvelope } from "@loom/core";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EffectMiddleware } from "@loom/effect-runtime";
import {
  InMemoryAsyncEventStore,
  SqliteBranchRegistry,
  SqliteEventStore,
} from "@loom/event-runtime";
import type { BranchRegistry, EventStore } from "@loom/event-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { InMemoryAsyncSnapshotStore, SqliteSnapshotStore } from "@loom/snapshot-runtime";
import type { SnapshotStore } from "@loom/snapshot-runtime";
import { composeAdapters, createTelemetryHook } from "@loom/telemetry";
import type { TelemetryAdapter } from "@loom/telemetry";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { RegisteredFlow } from "@loom/workflow-runtime";
import { InProcessA2ABus } from "./InProcessA2ABus";

/** Structural view of a CapabilityCatalog — avoids a hard `@loom/capability` dep. */
export interface CatalogLike {
  registerInto(runtime: WorkflowRuntime): void;
  get(capabilityId: string): { flow: RegisteredFlow } | undefined;
}

export interface StorageConfig {
  kind: "sqlite" | "memory";
  /** Directory for the SQLite DB files. Default ".loom". Ignored for "memory". */
  dir?: string;
  /** Provision a branch registry (fork/branch support). SQLite only. */
  branching?: boolean;
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
  /** A2UI surfaces to register on the projection runtime. */
  surfaces?: string[];
  /** Flows registered directly (in addition to any from `catalog`). */
  flows?: RegisteredFlow[];
  /** Capability catalog registered into the runtime + wired to agents. */
  catalog?: CatalogLike;
  /** Agent cards advertised on the in-process A2A bus. */
  agents?: AgentCard[];
  /** capabilityId → agentId routing for the bus. */
  capabilityAgents?: Record<string, string>;
  /** Static, ordered effect middleware (retries, logging, …). */
  effectMiddleware?: EffectMiddleware[];
  /** Telemetry adapters, composed and wired to the event stream. */
  telemetry?: TelemetryAdapter[];
  /** Placement dispatcher for the bus (default: in-process). e.g. Cloud Run. */
  dispatcher?: ExecutionDispatcher;
  /** Extra event observer, fired after projection + telemetry. */
  onEvent?: (event: EventEnvelope) => void;
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
  close(): Promise<void>;
}

function buildStores(storage: StorageConfig): LoomStores {
  if (storage.kind === "sqlite") {
    const dir = storage.dir ?? ".loom";
    fs.mkdirSync(dir, { recursive: true });
    const stores: LoomStores = {
      eventStore: new SqliteEventStore(path.join(dir, "events.db")),
      snapshotStore: new SqliteSnapshotStore(path.join(dir, "snapshots.db")),
    };
    if (storage.branching) {
      // Own DB file so branch writes never contend with the event-log write lock.
      stores.branchRegistry = new SqliteBranchRegistry(path.join(dir, "branches.db"));
    }
    return stores;
  }
  if (storage.branching) {
    throw new Error("in-memory storage does not support branching; use storage.kind='sqlite'");
  }
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
  const effectRuntime = new EffectRuntime(config.effectMiddleware ?? []);

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
  });

  config.catalog?.registerInto(runtime);
  for (const flow of config.flows ?? []) {
    runtime.registerFlow(flow.definition, flow.runner);
  }

  const bus = new InProcessA2ABus(runtime, config.dispatcher);
  for (const card of config.agents ?? []) {
    bus.registerAgent(card);
  }
  for (const [capabilityId, agentId] of Object.entries(config.capabilityAgents ?? {})) {
    const cap = config.catalog?.get(capabilityId);
    if (cap) bus.registerCapability(capabilityId, agentId, cap.flow);
  }

  return {
    runtime,
    effectRuntime,
    projectionRuntime,
    bus,
    stores,
    async close() {
      await stores.eventStore.close();
      await stores.snapshotStore.close();
      await stores.branchRegistry?.close();
    },
  };
}
