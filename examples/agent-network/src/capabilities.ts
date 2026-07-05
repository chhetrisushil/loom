import {
  MetricCard,
  StatusBadge,
  Timeline,
  blueprint$,
  grid,
  stack,
} from "@loom/blueprint-runtime";
import { capability$ } from "@loom/capability";
import { flow$, handler$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

// Two tiny capabilities that drive an A2UI "ui" surface as they run, so the same
// flow can be rendered on any surface (React, terminal, …).

const investigateStep = step$({
  id: "investigate",
  name: "Investigate",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({ summary: z.string() }),
  handler: handler$(async (input: { target: string }) => ({
    summary: `High CPU on ${input.target} traced to connection-pool starvation.`,
  })),
});

const investigateRunner: FlowRunner<{ target: string }, { summary: string }> = async (
  ctx,
  input
) => {
  ctx.ui.set("phase", "investigating");
  ctx.ui.set("target", input.target);
  ctx.ui.merge("metrics", { cpu: 87, memoryMb: 14000 });
  ctx.ui.append("timeline", "collected metrics");
  const result = await ctx.run(investigateStep, { target: input.target });
  ctx.ui.append("timeline", "root cause found");
  ctx.ui.set("summary", result.summary);
  ctx.ui.set("phase", "done");
  return result;
};

export const investigateFlow: RegisteredFlow<{ target: string }, { summary: string }> = {
  definition: flow$({
    id: "investigate-incident",
    name: "Investigate Incident",
    version: "1.0.0",
    inputSchema: z.object({ target: z.string() }),
    outputSchema: z.object({ summary: z.string() }),
    steps: [investigateStep],
  }),
  runner: investigateRunner,
};

const scaleStep = step$({
  id: "scale",
  name: "Scale",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({ summary: z.string() }),
  handler: handler$(async (input: { target: string }) => ({
    summary: `Scaled ${input.target} from 2 to 4 replicas.`,
  })),
});
const scaleRunner: FlowRunner<{ target: string }, { summary: string }> = (ctx, input) =>
  ctx.run(scaleStep, { target: input.target });

export const scaleFlow: RegisteredFlow<{ target: string }, { summary: string }> = {
  definition: flow$({
    id: "scale-cluster",
    name: "Scale Cluster",
    version: "1.0.0",
    inputSchema: z.object({ target: z.string() }),
    outputSchema: z.object({ summary: z.string() }),
    steps: [scaleStep],
  }),
  runner: scaleRunner,
};

export const investigateCapability = capability$({
  id: "investigate-incident",
  intent: "Investigate a production incident, find the root cause, and recommend a fix",
  tags: ["incident", "sre", "cpu", "database"],
  inputSchema: z.object({ target: z.string() }),
  flow: investigateFlow,
});

export const scaleCapability = capability$({
  id: "scale-cluster",
  intent: "Scale a database cluster up or down to add or remove capacity",
  tags: ["scaling", "capacity", "database", "cluster"],
  inputSchema: z.object({ target: z.string() }),
  flow: scaleFlow,
});

// A blueprint bound to the A2UI "ui" surface — rendered to the terminal surface.
export const incidentBlueprint = blueprint$({
  id: "incident",
  title: "Incident Command",
  layout: stack({
    children: [
      StatusBadge({ title: "Phase", binding: { projectionId: "ui", path: "phase" } }),
      grid({
        columns: 2,
        children: [
          MetricCard({
            title: "CPU",
            binding: { projectionId: "ui", path: "metrics.cpu" },
            unit: "%",
          }),
          MetricCard({
            title: "Memory",
            binding: { projectionId: "ui", path: "metrics.memoryMb" },
            unit: "MB",
          }),
        ],
      }),
      Timeline({ title: "Timeline", binding: { projectionId: "ui", path: "timeline" } }),
    ],
  }),
  projections: ["ui"],
});
