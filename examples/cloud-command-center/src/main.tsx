import { defineConfig } from "@loom/app";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { LoomProvider } from "@loom/renderer-react";
import type { RegisteredFlow } from "@loom/workflow-runtime";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { InvestigateIncidentFlow } from "./flows/InvestigateIncident";
import { IncidentProjection } from "./projections/IncidentProjection";
import { MetricsProjection } from "./projections/MetricsProjection";
import { registerAiTriageEffect } from "./runtime/aiTriage";

// This app registers CUSTOM projections (metrics + incident), so we build the
// projection runtime ourselves and hand it to defineConfig. defineConfig then
// registers the "ui" A2UI surface (via `surfaces`) and wires
// onEvent → projectionRuntime.handleEvent for us.
const projectionRuntime = new InMemoryProjectionRuntime();
projectionRuntime.register(MetricsProjection);
projectionRuntime.register(IncidentProjection);

// The composition root: defineConfig assembles the stores, EffectRuntime,
// WorkflowRuntime and A2A bus from this static config. registerFlow (invoked by
// defineConfig for each entry in `flows`) auto-registers a LazyEffect for every
// step that carries handler$ (metrics, logs, remediation).
const app = defineConfig({
  storage: { kind: "memory" },
  projectionRuntime,
  // A2UI: fold the "ui" surface so ctx.ui.* patches (phase badge, streamed AI
  // analysis) reach the widgets bound to { projectionId: "ui", … }.
  surfaces: ["ui"],
  flows: [InvestigateIncidentFlow as RegisteredFlow],
});

// The AI-triage step has no co-located handler — its effect is registered here
// with the configured LLM provider, on the runtime's EffectRuntime.
registerAiTriageEffect(app.effectRuntime);

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

createRoot(root).render(
  <LoomProvider workflowRuntime={app.runtime} projectionRuntime={app.projectionRuntime}>
    <App />
  </LoomProvider>
);
