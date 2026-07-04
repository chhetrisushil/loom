import { createRoot } from "react-dom/client";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { LoomProvider } from "@loom/renderer-react";
import { InMemoryEventStore, InMemorySnapshotStore } from "./runtime/browserStores";
import { IncidentProjection } from "./projections/IncidentProjection";
import { MetricsProjection } from "./projections/MetricsProjection";
import { InvestigateIncidentFlow } from "./flows/InvestigateIncident";
import { App } from "./App";

const effectRuntime = new EffectRuntime();
const projectionRuntime = new InMemoryProjectionRuntime();

projectionRuntime.register(MetricsProjection);
projectionRuntime.register(IncidentProjection);

const workflowRuntime = new WorkflowRuntime({
  eventStore: new InMemoryEventStore(),
  snapshotStore: new InMemorySnapshotStore(),
  effectRuntime,
  onEvent: (e) => projectionRuntime.handleEvent(e),
});

// registerFlow auto-registers LazyEffect for each step that carries handler$
workflowRuntime.registerFlow(
  InvestigateIncidentFlow.definition,
  InvestigateIncidentFlow.runner
);

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

createRoot(root).render(
  <LoomProvider workflowRuntime={workflowRuntime} projectionRuntime={projectionRuntime}>
    <App />
  </LoomProvider>
);
