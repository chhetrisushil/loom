import { handler$, step$, tool$ } from "@loom/core";
import { z } from "zod";

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
  // handler$ co-locates the implementation with the step definition.
  // At runtime: called directly via LazyEffect → HandlerRef.
  // At build time: @loom/compiler extracts this into a lazy chunk.
  handler: handler$(async (_input, _ctx) => ({
    cpu: { current: 87, threshold: 80 },
    memory: { usedMb: 14_000, totalMb: 16_000 },
    connections: { active: 450, max: 500 },
  })),
});
