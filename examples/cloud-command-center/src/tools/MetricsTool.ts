import { z } from "zod";
import { step$, tool$ } from "@loom/core";

export const MetricsTool = tool$({
  id: "metrics-tool",
  name: "Fetch Metrics",
  description: "Fetches current CPU, memory, and connection metrics for a database cluster",
  kind: "tool",
  inputSchema: z.object({ incidentId: z.string(), clusterId: z.string().optional() }),
  outputSchema: z.object({
    cpu: z.object({ current: z.number(), threshold: z.number() }),
    memory: z.object({ usedMb: z.number(), totalMb: z.number() }),
    connections: z.object({ active: z.number(), max: z.number() }),
  }),
});

export const FetchMetricsStep = step$({
  id: "fetch-metrics",
  name: "Fetch Metrics",
  toolId: "metrics-tool",
  inputSchema: z.object({ incidentId: z.string() }),
  outputSchema: z.object({
    cpu: z.object({ current: z.number(), threshold: z.number() }),
    memory: z.object({ usedMb: z.number(), totalMb: z.number() }),
    connections: z.object({ active: z.number(), max: z.number() }),
  }),
});
