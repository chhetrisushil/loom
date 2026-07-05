import * as fs from "node:fs";
import * as path from "node:path";
import { a2uiSurfaceProjection } from "@loom/a2ui";
import type { EventEnvelope } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { SqliteEventStore } from "@loom/event-runtime";
import { SqliteSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { InProcessA2ABus } from "../a2a/InProcessA2ABus";
import { AGENT_CARDS, CAPABILITY_AGENT, FLEET } from "../agents/definitions";
import { buildCatalog } from "../capabilities/catalog";
import { Orchestrator } from "../orchestrator/Orchestrator";
import { MISSION_ID, type ServerFrame } from "../wire";
import { BroadcastingProjectionRuntime } from "./BroadcastingProjectionRuntime";

const SURFACES = ["mission", "telemetry"];

export interface ServerApp {
  readonly missionId: string;
  readonly orchestrator: Orchestrator;
  readonly projectionRuntime: BroadcastingProjectionRuntime;
  // A serialized ProjectionSnapshot of the mission + telemetry surfaces.
  snapshot(): string;
  // Observe the A2UI patch frames the server would push to SSE clients.
  subscribeBroadcast(cb: (frame: ServerFrame) => void): () => void;
  close(): void;
}

// Builds the entire durable, server-side agentic backend for one mission — the
// SQLite stores, the WorkflowRuntime, the A2A bus + agents, and the Orchestrator,
// wired to a broadcasting projection runtime. Kept transport-free so it can be
// driven headlessly in tests and wrapped by the HTTP server in main.ts.
export function createApp(opts: { dataDir: string; missionId?: string }): ServerApp {
  const missionId = opts.missionId ?? MISSION_ID;
  fs.mkdirSync(opts.dataDir, { recursive: true });

  const eventStore = new SqliteEventStore(path.join(opts.dataDir, "events.db"));
  const snapshotStore = new SqliteSnapshotStore(path.join(opts.dataDir, "snapshots.db"));
  const effectRuntime = new EffectRuntime();

  const observers = new Set<(frame: ServerFrame) => void>();
  const emitPatch = (envelope: EventEnvelope): void => {
    for (const cb of observers) cb({ kind: "patch", envelope });
  };

  const projectionRuntime = new BroadcastingProjectionRuntime(missionId, SURFACES, emitPatch);
  projectionRuntime.register(a2uiSurfaceProjection("mission"));
  projectionRuntime.register(a2uiSurfaceProjection("telemetry"));

  const missionRuntime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime,
    onEvent: (e: EventEnvelope) => projectionRuntime.handleEvent(e),
  });

  const catalog = buildCatalog();
  catalog.registerInto(missionRuntime);

  const bus = new InProcessA2ABus(missionRuntime);
  for (const agent of FLEET) {
    const card = AGENT_CARDS[agent.id];
    if (card) bus.registerAgent(card);
  }
  for (const [capabilityId, agentId] of Object.entries(CAPABILITY_AGENT)) {
    const cap = catalog.get(capabilityId);
    if (cap) bus.registerCapability(capabilityId, agentId, cap.flow);
  }

  const orchestrator = new Orchestrator({
    projectionRuntime,
    missionRuntime,
    catalog,
    bus,
    missionId,
  });

  return {
    missionId,
    orchestrator,
    projectionRuntime,
    snapshot: () => projectionRuntime.snapshot(),
    subscribeBroadcast(cb) {
      observers.add(cb);
      return () => observers.delete(cb);
    },
    close() {
      eventStore.close();
      snapshotStore.close();
    },
  };
}
