import { defineConfig } from "@loom/app";
import { LoomProvider } from "@loom/plugin-renderer-react";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CAPABILITY_AGENT, FLEET } from "./agents/definitions";
import { buildCatalog } from "./capabilities/catalog";
import { Orchestrator } from "./orchestrator/Orchestrator";
import { buildRegistry } from "./widgets/registry";

const MISSION_ID = "mission-1";

// coalesceNotifications batches a streaming burst (e.g. many console lines) into
// one notification per microtask — fewer downstream re-renders under load. We
// pass our own projection runtime so defineConfig registers the surfaces on it
// and wires onEvent → handleEvent for us.
const projectionRuntime = new InMemoryProjectionRuntime({ coalesceNotifications: true });

// The catalog registers every capability's flow (each step carries handler$, so
// its effect is auto-registered as a LazyEffect — no manual wiring needed).
const catalog = buildCatalog();

// ── One declarative app assembly ────────────────────────────────────────────────
// defineConfig builds the stores (in-memory for this browser app), the
// EffectRuntime, the WorkflowRuntime, registers the catalog's flows, and stands up
// the in-process A2A bus with the fleet's cards + capability→agent routes.
const app = defineConfig({
  storage: { kind: "memory" },
  projectionRuntime,
  // The two A2UI surfaces the command center renders. Widgets bind to them with
  // { projectionId: "mission" | "telemetry", path }.
  surfaces: ["mission", "telemetry"],
  catalog,
  // a2a: true derives + registers each agent's card from the `agent$` definitions.
  agents: FLEET,
  a2a: true,
  capabilityAgents: CAPABILITY_AGENT,
});

// ── The conductor ─────────────────────────────────────────────────────────────
const orchestrator = new Orchestrator({
  projectionRuntime: app.projectionRuntime,
  missionRuntime: app.runtime,
  catalog,
  bus: app.bus,
  missionId: MISSION_ID,
});

const widgetRegistry = buildRegistry();

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

createRoot(root).render(
  <LoomProvider workflowRuntime={app.runtime} projectionRuntime={app.projectionRuntime}>
    <App
      orchestrator={orchestrator}
      projectionRuntime={app.projectionRuntime}
      registry={widgetRegistry}
      missionId={MISSION_ID}
      agentCards={app.bus.agentCards()}
    />
  </LoomProvider>
);
