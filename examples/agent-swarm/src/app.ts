import { type LoomApp, defineConfig } from "@loom/app";
import type { CapabilityCatalog } from "@loom/capability";
import { LocalDispatcher } from "@loom/dispatcher";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import type { AgentCard } from "@loom/plugin-a2a";
import { sqliteStorage } from "@loom/plugin-sqlite";
import { LocalWorkerRuntime } from "@loom/worker-runtime-local";
import { AGENT_CARDS, CAPABILITY_AGENT, FLEET } from "./agents/definitions";
import { buildCatalog } from "./capabilities/catalog";
import { SwarmConductor } from "./orchestrator/SwarmConductor";

export type StorageOpt = { kind: "memory" } | { kind: "sqlite"; dir: string; branching?: boolean };

export interface SwarmApp {
  app: LoomApp;
  catalog: CapabilityCatalog;
  dispatcher: ExecutionDispatcher;
  conductor: SwarmConductor;
}

/**
 * The composition root. `defineConfig` assembles the durable runtime + stores +
 * A2A bus, registering every capability's flow (so they resolve for BOTH the bus
 * and executeGraph) and advertising the fleet's AgentCards. Then we build the
 * compute dispatcher (in-process here — swap for HTTP/Cloud Run to distribute) and
 * the conductor.
 */
export function buildApp(opts?: { storage?: StorageOpt }): SwarmApp {
  const catalog = buildCatalog();
  const app = defineConfig({
    storage:
      opts?.storage?.kind === "sqlite"
        ? sqliteStorage({ dir: opts.storage.dir, branching: opts.storage.branching === true })
        : { kind: "memory" },
    catalog,
    agents: FLEET.map((a) => AGENT_CARDS[a.id]).filter((c): c is AgentCard => c !== undefined),
    capabilityAgents: CAPABILITY_AGENT,
  });

  // The compute seam: executeGraph fans nodes out through this dispatcher. Local
  // here; `new RemoteWorkerRuntime(url)` or a Cloud Run dispatcher moves it off-box.
  const dispatcher = new LocalDispatcher(new LocalWorkerRuntime(app.runtime));

  const conductor = new SwarmConductor({ catalog, bus: app.bus, dispatcher });
  return { app, catalog, dispatcher, conductor };
}
