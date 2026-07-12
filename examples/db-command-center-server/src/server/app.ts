import { BroadcastingProjectionRuntime, defineConfig } from "@loom/app";
import type { EventEnvelope } from "@loom/core";
import type { BranchRegistry } from "@loom/event-runtime";
import type { AgentCard } from "@loom/plugin-a2a";
import { sqliteStorage } from "@loom/plugin-sqlite";
import type { WorkflowRuntime } from "@loom/workflow-runtime";
import { AGENT_CARDS, CAPABILITY_AGENT, FLEET } from "../agents/definitions";
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
    agents: FLEET.map((a) => AGENT_CARDS[a.id]).filter((c): c is AgentCard => c !== undefined),
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
