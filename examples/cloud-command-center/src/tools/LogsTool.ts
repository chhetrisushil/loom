import { z } from "zod";
import { step$, tool$ } from "@loom/core";

export const LogsTool = tool$({
  id: "logs-tool",
  name: "Fetch Logs",
  description: "Fetches recent error logs for a database cluster",
  kind: "tool",
  inputSchema: z.object({ incidentId: z.string(), level: z.enum(["error", "warn", "info"]).optional() }),
  outputSchema: z.object({
    logs: z.array(
      z.object({ level: z.string(), message: z.string(), timestamp: z.number() })
    ),
  }),
});

export const FetchLogsStep = step$({
  id: "fetch-logs",
  name: "Fetch Logs",
  toolId: "logs-tool",
  inputSchema: z.object({ incidentId: z.string() }),
  outputSchema: z.object({
    logs: z.array(
      z.object({ level: z.string(), message: z.string(), timestamp: z.number() })
    ),
  }),
});
