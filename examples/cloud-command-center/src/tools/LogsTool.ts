import { handler$, step$, tool$ } from "@loom/core";
import { z } from "zod";

export const LogsTool = tool$({
  id: "logs-tool",
  name: "Fetch Logs",
  description: "Fetches recent error logs for a database cluster",
  kind: "tool",
  inputSchema: z.object({
    incidentId: z.string(),
    level: z.enum(["error", "warn", "info"]).optional(),
  }),
  outputSchema: z.object({
    logs: z.array(z.object({ level: z.string(), message: z.string(), timestamp: z.number() })),
  }),
});

export const FetchLogsStep = step$({
  id: "fetch-logs",
  name: "Fetch Logs",
  toolId: "logs-tool",
  inputSchema: z.object({ incidentId: z.string() }),
  outputSchema: z.object({
    logs: z.array(z.object({ level: z.string(), message: z.string(), timestamp: z.number() })),
  }),
  handler: handler$(async (_input, _ctx) => ({
    logs: [
      { level: "error", message: "OOM killer invoked", timestamp: Date.now() - 5000 },
      { level: "error", message: "Connection pool exhausted", timestamp: Date.now() - 3000 },
      { level: "warn", message: "Replication lag > 500ms", timestamp: Date.now() - 1000 },
    ],
  })),
});
