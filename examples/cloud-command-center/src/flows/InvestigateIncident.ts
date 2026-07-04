import { z } from "zod";
import { flow$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { AiTriageStep } from "../tools/AiTriageTool";
import { ApplyRemediationStep } from "../tools/RemediationTool";
import { FetchLogsStep } from "../tools/LogsTool";
import { FetchMetricsStep } from "../tools/MetricsTool";

const inputSchema = z.object({ incidentId: z.string() });
const outputSchema = z.object({ resolved: z.boolean(), summary: z.string() });

export type InvestigateInput = z.infer<typeof inputSchema>;
export type InvestigateOutput = z.infer<typeof outputSchema>;

export const InvestigateIncidentDefinition = flow$({
  id: "investigate-incident",
  name: "Investigate Incident",
  version: "1.0.0",
  description: "Investigates a high-CPU database incident and applies remediation after approval",
  inputSchema,
  outputSchema,
  steps: [FetchMetricsStep, FetchLogsStep, AiTriageStep, ApplyRemediationStep],
});

export const investigateIncidentRunner: FlowRunner<InvestigateInput, InvestigateOutput> = async (
  ctx,
  input
) => {
  ctx.emit("INCIDENT_INVESTIGATION_STARTED", { incidentId: input.incidentId });
  // A2UI: patch the UI surface directly from the flow. These durable, replayable
  // patches drive the Workflow Phase badge without any bespoke event/projection.
  ctx.ui.set("phase", "investigating");

  const metrics = await ctx.run(FetchMetricsStep, { incidentId: input.incidentId });
  const logs = await ctx.run(FetchLogsStep, { incidentId: input.incidentId });

  ctx.emit("INCIDENT_ANALYSIS_COMPLETE", { metrics, logs });

  // AI triage: the configured LLM streams a root-cause analysis to the UI
  // (A2UI) and the final text is durably memoized on the step frame.
  ctx.ui.set("phase", "triaging");
  const triage = await ctx.run(AiTriageStep, { metrics, logs });

  ctx.ui.set("phase", "awaiting-approval");
  ctx.emit("APPROVAL_REQUESTED", {
    incidentId: input.incidentId,
    metrics,
    logs,
    aiAnalysis: triage.analysis,
  });

  await ctx.suspend({
    on: "ApprovalGranted",
    correlationKey: input.incidentId,
    timeout: 24 * 60 * 60 * 1000,
  });

  ctx.ui.set("phase", "remediating");
  const remediation = await ctx.run(ApplyRemediationStep, { incidentId: input.incidentId });

  ctx.ui.set("phase", "resolved");
  ctx.emit("INCIDENT_RESOLVED", {
    incidentId: input.incidentId,
    summary: remediation.summary,
  });

  return {
    resolved: remediation.success,
    summary: remediation.summary,
  };
};

export const InvestigateIncidentFlow: RegisteredFlow<InvestigateInput, InvestigateOutput> = {
  definition: InvestigateIncidentDefinition,
  runner: investigateIncidentRunner,
};
