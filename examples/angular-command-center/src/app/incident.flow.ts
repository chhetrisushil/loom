import { flow$, handler$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

// ── Schemas ───────────────────────────────────────────────────────────────────

const inputSchema = z.object({ incidentId: z.string() });
const outputSchema = z.object({ resolved: z.boolean(), summary: z.string() });

export type IncidentInput = z.infer<typeof inputSchema>;
export type IncidentOutput = z.infer<typeof outputSchema>;

export interface MetricsData {
  cpu: { current: number; threshold: number };
  memory: { usedMb: number; totalMb: number };
  connections: { active: number; max: number };
}

export interface LogData {
  errorCount: number;
  topError: string;
  timeRange: string;
}

// ── Steps ─────────────────────────────────────────────────────────────────────

export const FetchMetricsStep = step$({
  id: "fetch-metrics",
  toolId: "metrics-tool",
  inputSchema: z.object({ incidentId: z.string() }),
  outputSchema: z.object({
    cpu: z.object({ current: z.number(), threshold: z.number() }),
    memory: z.object({ usedMb: z.number(), totalMb: z.number() }),
    connections: z.object({ active: z.number(), max: z.number() }),
  }),
  handler: handler$(async (_input: { incidentId: string }): Promise<MetricsData> => {
    await new Promise((r) => setTimeout(r, 700));
    return {
      cpu: { current: 87, threshold: 80 },
      memory: { usedMb: 14_000, totalMb: 16_000 },
      connections: { active: 450, max: 500 },
    };
  }),
});

export const FetchLogsStep = step$({
  id: "fetch-logs",
  toolId: "logs-tool",
  inputSchema: z.object({ incidentId: z.string() }),
  outputSchema: z.object({
    errorCount: z.number(),
    topError: z.string(),
    timeRange: z.string(),
  }),
  handler: handler$(async (_input: { incidentId: string }): Promise<LogData> => {
    await new Promise((r) => setTimeout(r, 500));
    return {
      errorCount: 243,
      topError: "connection pool exhausted",
      timeRange: "last 15 min",
    };
  }),
});

export const ApplyRemediationStep = step$({
  id: "apply-remediation",
  toolId: "remediation-tool",
  inputSchema: z.object({ incidentId: z.string() }),
  outputSchema: z.object({ success: z.boolean(), summary: z.string() }),
  handler: handler$(async (input: { incidentId: string }) => {
    await new Promise((r) => setTimeout(r, 600));
    return {
      success: true,
      summary: `Remediation applied for ${input.incidentId}: connection pool reset, query cache cleared`,
    };
  }),
});

// ── Flow ──────────────────────────────────────────────────────────────────────

export const InvestigateIncidentDefinition = flow$({
  id: "investigate-incident",
  name: "Investigate Incident",
  version: "1.0.0",
  inputSchema,
  outputSchema,
  steps: [FetchMetricsStep, FetchLogsStep, ApplyRemediationStep],
});

const runner: FlowRunner<IncidentInput, IncidentOutput> = async (ctx, input) => {
  ctx.emit("INCIDENT_STARTED", { incidentId: input.incidentId });

  const [metrics, logs] = await Promise.all([
    ctx.run(FetchMetricsStep, { incidentId: input.incidentId }),
    ctx.run(FetchLogsStep, { incidentId: input.incidentId }),
  ]);

  ctx.emit("ANALYSIS_COMPLETE", { metrics, logs });
  ctx.emit("APPROVAL_REQUESTED", { incidentId: input.incidentId, metrics, logs });

  await ctx.suspend({ on: "ApprovalGranted", correlationKey: input.incidentId });

  const remediation = await ctx.run(ApplyRemediationStep, { incidentId: input.incidentId });

  ctx.emit("INCIDENT_RESOLVED", { incidentId: input.incidentId, summary: remediation.summary });

  return { resolved: remediation.success, summary: remediation.summary };
};

export const InvestigateIncidentFlow: RegisteredFlow<IncidentInput, IncidentOutput> = {
  definition: InvestigateIncidentDefinition,
  runner,
};
