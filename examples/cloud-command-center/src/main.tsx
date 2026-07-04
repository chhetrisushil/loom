import { createRoot } from "react-dom/client";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { LoomProvider } from "@loom/renderer-react";
import { a2uiSurfaceProjection } from "@loom/a2ui";
import { InMemoryEventStore, InMemorySnapshotStore } from "./runtime/browserStores";
import { registerAiTriageEffect } from "./runtime/aiTriage";
import { IncidentProjection } from "./projections/IncidentProjection";
import { MetricsProjection } from "./projections/MetricsProjection";
import { InvestigateIncidentFlow } from "./flows/InvestigateIncident";
import { App } from "./App";

const effectRuntime = new EffectRuntime();
const projectionRuntime = new InMemoryProjectionRuntime();

projectionRuntime.register(MetricsProjection);
projectionRuntime.register(IncidentProjection);
// A2UI: fold the "ui" surface so ctx.ui.* patches (phase badge, streamed AI
// analysis) reach the widgets bound to { projectionId: "ui", … }.
projectionRuntime.register(a2uiSurfaceProjection("ui"));

const workflowRuntime = new WorkflowRuntime({
  eventStore: new InMemoryEventStore(),
  snapshotStore: new InMemorySnapshotStore(),
  effectRuntime,
  onEvent: (e) => projectionRuntime.handleEvent(e),
});

// registerFlow auto-registers a LazyEffect for each step that carries handler$
// (metrics, logs, remediation). The AI-triage step has no co-located handler —
// its effect is registered here with the configured LLM provider.
workflowRuntime.registerFlow(
  InvestigateIncidentFlow.definition,
  InvestigateIncidentFlow.runner
);
registerAiTriageEffect(effectRuntime);

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

createRoot(root).render(
  <LoomProvider workflowRuntime={workflowRuntime} projectionRuntime={projectionRuntime}>
    <App />
  </LoomProvider>
);
