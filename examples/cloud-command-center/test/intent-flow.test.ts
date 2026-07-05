import { a2uiSurfaceProjection } from "@loom/a2ui";
import { EffectRuntime } from "@loom/effect-runtime";
import { IntentRuntime } from "@loom/intent";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { incidentCatalog } from "../src/capabilities";
import { InvestigateIncidentFlow } from "../src/flows/InvestigateIncident";
import { IncidentProjection } from "../src/projections/IncidentProjection";
import { MetricsProjection } from "../src/projections/MetricsProjection";
import { registerAiTriageEffect } from "../src/runtime/aiTriage";
import { InMemoryEventStore, InMemorySnapshotStore } from "../src/runtime/browserStores";

// Reproduces exactly what main.tsx + App.tsx do, headlessly, so a missing effect
// registration (the "No effect registered for toolId: ai-triage-tool" bug) is
// caught by CI instead of only in the browser.
function wireRuntime() {
  const effectRuntime = new EffectRuntime();
  const projectionRuntime = new InMemoryProjectionRuntime();
  projectionRuntime.register(MetricsProjection);
  projectionRuntime.register(IncidentProjection);
  projectionRuntime.register(a2uiSurfaceProjection("ui"));

  const workflowRuntime = new WorkflowRuntime({
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
    effectRuntime,
    onEvent: (e) => projectionRuntime.handleEvent(e),
  });
  workflowRuntime.registerFlow(InvestigateIncidentFlow.definition, InvestigateIncidentFlow.runner);
  registerAiTriageEffect(effectRuntime);
  return { workflowRuntime, projectionRuntime };
}

describe("cloud-command-center: intent → capability → flow", () => {
  it("routes intent to the investigate capability", async () => {
    const { workflowRuntime } = wireRuntime();
    const intent = new IntentRuntime({ catalog: incidentCatalog, workflowRuntime });
    const route = await intent.route("investigate high CPU on the postgres cluster");
    expect(route?.capability.id).toBe("investigate-incident");
  });

  it("runs the whole flow (incl. AI-triage step) to suspend, then resumes", async () => {
    const { workflowRuntime, projectionRuntime } = wireRuntime();
    const intent = new IntentRuntime({ catalog: incidentCatalog, workflowRuntime });

    // Run Intent — this is what failed before with "No effect registered".
    const handle = await intent.run("investigate high CPU on the postgres cluster", {
      incidentId: "cpu-001",
    });

    const suspended = await handle.waitForSuspend();
    expect(suspended.status).toBe("suspended");

    // A2UI: phase badge + streamed AI analysis reached the "ui" surface.
    const ui = projectionRuntime.getState<Record<string, unknown>>("ui", handle.executionId);
    expect(ui.phase).toBe("awaiting-approval");
    expect(String(ui.aiAnalysis ?? "")).toContain("Root cause");

    // Approve → resume → complete.
    const resumed = await workflowRuntime.resume(handle.executionId, {
      eventType: "ApprovalGranted",
      payload: { approved: true },
    });
    const done = await resumed.waitForCompletion();
    expect(done.status).toBe("completed");

    const uiFinal = projectionRuntime.getState<Record<string, unknown>>("ui", handle.executionId);
    expect(uiFinal.phase).toBe("resolved");
  });
});
