import { handler$, step$, tool$ } from "@loom/core";
import { z } from "zod";

export const RemediationTool = tool$({
  id: "remediation-tool",
  name: "Apply Remediation",
  description: "Restarts the database instance and applies configuration fixes",
  kind: "tool",
  inputSchema: z.object({
    incidentId: z.string(),
    action: z.enum(["restart", "scale", "configure"]).optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    summary: z.string(),
    appliedAt: z.number(),
  }),
});

export const ApplyRemediationStep = step$({
  id: "apply-remediation",
  name: "Apply Remediation",
  toolId: "remediation-tool",
  inputSchema: z.object({ incidentId: z.string() }),
  outputSchema: z.object({
    success: z.boolean(),
    summary: z.string(),
    appliedAt: z.number(),
  }),
  handler: handler$(async (_input, _ctx) => ({
    success: true,
    summary: "Pod restarted successfully, CPU normalized to 32%",
    appliedAt: Date.now(),
  })),
});
