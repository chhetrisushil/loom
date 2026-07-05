import { a2uiSurfaceProjection } from "@loom/a2ui";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { AgentRegistry } from "@loom/registry";
import { LoomProvider } from "@loom/renderer-react";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { InProcessA2ABus } from "./a2a/InProcessA2ABus";
import { AGENT_CARDS, CAPABILITY_AGENT, FLEET } from "./agents/definitions";
import { buildCatalog } from "./capabilities/catalog";
import { Orchestrator } from "./orchestrator/Orchestrator";
import { InMemoryEventStore, InMemorySnapshotStore } from "./runtime/browserStores";
import { buildRegistry } from "./widgets/registry";

const MISSION_ID = "mission-1";

// ── Runtimes ──────────────────────────────────────────────────────────────────
const effectRuntime = new EffectRuntime();

// coalesceNotifications batches a streaming burst (e.g. many console lines) into
// one notification per microtask — fewer downstream re-renders under load.
const projectionRuntime = new InMemoryProjectionRuntime({ coalesceNotifications: true });

// The two A2UI surfaces the command center renders. Widgets bind to them with
// { projectionId: "mission" | "telemetry", path }.
projectionRuntime.register(a2uiSurfaceProjection("mission"));
projectionRuntime.register(a2uiSurfaceProjection("telemetry"));

const missionRuntime = new WorkflowRuntime({
  eventStore: new InMemoryEventStore(),
  snapshotStore: new InMemorySnapshotStore(),
  effectRuntime,
  onEvent: (e) => projectionRuntime.handleEvent(e),
});

// ── Capabilities → flows ──────────────────────────────────────────────────────
// registerInto registers every capability's flow; each step carries handler$, so
// its effect is auto-registered as a LazyEffect (no manual wiring needed).
const catalog = buildCatalog();
catalog.registerInto(missionRuntime);

// ── The A2A fleet ─────────────────────────────────────────────────────────────
const bus = new InProcessA2ABus(missionRuntime);
const registry = new AgentRegistry();
for (const agent of FLEET) {
  const card = AGENT_CARDS[agent.id];
  if (card) {
    bus.registerAgent(card);
    registry.register(agent, { name: card.name, version: card.version, skills: card.skills });
  }
}
for (const [capabilityId, agentId] of Object.entries(CAPABILITY_AGENT)) {
  const cap = catalog.get(capabilityId);
  if (cap) bus.registerCapability(capabilityId, agentId, cap.flow);
}

// ── The conductor ─────────────────────────────────────────────────────────────
const orchestrator = new Orchestrator({
  projectionRuntime,
  missionRuntime,
  catalog,
  bus,
  missionId: MISSION_ID,
});

const widgetRegistry = buildRegistry();

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

createRoot(root).render(
  <LoomProvider workflowRuntime={missionRuntime} projectionRuntime={projectionRuntime}>
    <App
      orchestrator={orchestrator}
      projectionRuntime={projectionRuntime}
      registry={widgetRegistry}
      missionId={MISSION_ID}
      agentCards={bus.agentCards()}
    />
  </LoomProvider>
);
