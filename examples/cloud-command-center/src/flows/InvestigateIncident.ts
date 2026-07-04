import { z } from "zod";
import { flow$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
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
  steps: [FetchMetricsStep, FetchLogsStep, ApplyRemediationStep],
});

export const investigateIncidentRunner: FlowRunner<InvestigateInput, InvestigateOutput> = async (
  ctx,
  input
) => {
  ctx.emit("INCIDENT_INVESTIGATION_STARTED", { incidentId: input.incidentId });

  const metrics = await ctx.run(FetchMetricsStep, { incidentId: input.incidentId });
  const logs = await ctx.run(FetchLogsStep, { incidentId: input.incidentId });

  ctx.emit("INCIDENT_ANALYSIS_COMPLETE", { metrics, logs });

  ctx.emit("APPROVAL_REQUESTED", {
    incidentId: input.incidentId,
    metrics,
    logs,
  });

  await ctx.suspend({
    on: "ApprovalGranted",
    correlationKey: input.incidentId,
    timeout: 24 * 60 * 60 * 1000,
  });

  const remediation = await ctx.run(ApplyRemediationStep, { incidentId: input.incidentId });

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
