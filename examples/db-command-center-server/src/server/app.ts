import { BroadcastingProjectionRuntime, defineConfig } from "@loom/app";
import type { EventEnvelope } from "@loom/core";
import type { BranchRegistry } from "@loom/event-runtime";
import { sqliteStorage } from "@loom/plugin-sqlite";
import type { WorkflowRuntime } from "@loom/workflow-runtime";
import { CAPABILITY_AGENT, FLEET } from "../agents/definitions";
import { buildCatalog } from "../capabilities/catalog";
import { Orchestrator } from "../orchestrator/Orchestrator";
import { MISSION_ID, type ServerFrame } from "../wire";

const SURFACES = ["mission", "telemetry"];

export interface ServerApp {
  readonly missionId: string;
  readonly orchestrator: Orchestrator;
  readonly projectionRuntime: BroadcastingProjectionRuntime;
  // The durable workflow runtime — exposed so speculative branches can be forked
  // from a task execution (missionRuntime.fork) and driven independently.
  readonly missionRuntime: WorkflowRuntime;
  // Git-style branch registry: movable refs + fork lineage for speculation.
  readonly branchRegistry: BranchRegistry;
  // A serialized ProjectionSnapshot of the mission + telemetry surfaces.
  snapshot(): string;
  // Observe the A2UI patch frames the server would push to SSE clients.
  subscribeBroadcast(cb: (frame: ServerFrame) => void): () => void;
  close(): void;
}

// Builds the entire durable, server-side agentic backend for one mission. The
// composition root (SQLite stores, WorkflowRuntime, effect runtime, A2A bus +
// agents) is now assembled by `defineConfig`; this file only adds the app-specific
// pieces: the broadcasting projection runtime (SSE) and the Orchestrator. Kept
// transport-free so it can be driven headlessly in tests and wrapped by main.ts.
export function createApp(opts: { dataDir: string; missionId?: string }): ServerApp {
  const missionId = opts.missionId ?? MISSION_ID;

  const observers = new Set<(frame: ServerFrame) => void>();
  const emitPatch = (envelope: EventEnvelope): void => {
    for (const cb of observers) cb({ kind: "patch", envelope });
  };
  const projectionRuntime = new BroadcastingProjectionRuntime(missionId, SURFACES, emitPatch);

  const catalog = buildCatalog();
  const app = defineConfig({
    storage: sqliteStorage({ dir: opts.dataDir, branching: true }),
    projectionRuntime,
    surfaces: SURFACES,
    catalog,
    // Batteries-included A2A/A2UI wiring from the `agent$` definitions. `a2a: true` derives +
    // registers each agent's AgentCard (replacing the hand-built card map), and `a2ui: true`
    // registers an A2UI surface per agent (`surfaceId = agent.id`) so each agent is addressable
    // as its own surface. Both are opt-in; with them off you wire cards/surfaces by hand as before.
    agents: FLEET,
    a2a: true,
    a2ui: true,
    capabilityAgents: CAPABILITY_AGENT,
  });

  if (!app.stores.branchRegistry) {
    throw new Error("branch registry required for speculative forks");
  }
  const branchRegistry = app.stores.branchRegistry;

  const orchestrator = new Orchestrator({
    projectionRuntime,
    missionRuntime: app.runtime,
    catalog,
    bus: app.bus,
    missionId,
  });

  return {
    missionId,
    orchestrator,
    projectionRuntime,
    missionRuntime: app.runtime,
    branchRegistry,
    snapshot: () => projectionRuntime.snapshot(),
    subscribeBroadcast(cb) {
      observers.add(cb);
      return () => observers.delete(cb);
    },
    close() {
      void app.close();
    },
  };
}
