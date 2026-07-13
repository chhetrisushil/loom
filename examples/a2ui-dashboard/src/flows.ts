import { createA2UIEmitter } from "@loom/a2ui";
import { flow$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { sampleCpu, sampleDisk, sampleMemory } from "./metrics";

// One capability flow per agent. Each flow IS the agent's behavior: it samples its
// metric and streams the result into ITS OWN A2UI surface via
// `createA2UIEmitter(ctx.emit, <agentId>)`. Because A2UI updates travel as ordinary
// Loom events, every panel is durable, ordered, and fully reconstructable from the
// log — the surface state is just a projection folded by `a2uiSurfaceProjection`
// (auto-registered by `a2ui: true`).

const io = {
  inputSchema: z.object({ host: z.string() }),
  outputSchema: z.object({ value: z.number(), status: z.string() }),
};

interface Panel {
  agentId: string;
  flow: RegisteredFlow;
}

/** Build a monitoring flow that renders its live panel into the agent's surface. */
function panelFlow(
  flowId: string,
  agentId: string,
  title: string,
  sample: (host: string) => number,
  alertAt: number
): Panel {
  const runner: FlowRunner<{ host: string }, { value: number; status: string }> = async (
    ctx,
    input
  ) => {
    // The surface id IS the agent id — the surface `a2ui: true` registered for this agent.
    // (Bind `emit` to the context — it's a method that reads `this`, so pass a bound wrapper.)
    const ui = createA2UIEmitter((type, payload) => ctx.emit(type, payload), agentId);
    ui.set("title", title);
    ui.set("host", input.host);
    ui.set("status", "checking");
    ui.append("log", `probing ${title.toLowerCase()} on ${input.host}…`);

    const value = sample(input.host);
    const status = value >= alertAt ? "alert" : "ok";

    // Atomically publish the reading + verdict, then log it.
    ui.merge("", { value, status });
    ui.append("log", `${title} = ${value}% → ${status.toUpperCase()}`);

    return { value, status };
  };
  const flow: RegisteredFlow = {
    definition: flow$({ id: flowId, name: title, version: "1.0.0", ...io, steps: [] }),
    runner: runner as FlowRunner<unknown, unknown>,
  };
  return { agentId, flow };
}

export const PANELS: Panel[] = [
  panelFlow("cpu-flow", "cpu-agent", "CPU", sampleCpu, 80),
  panelFlow("memory-flow", "memory-agent", "Memory", sampleMemory, 80),
  panelFlow("disk-flow", "disk-agent", "Disk", sampleDisk, 90),
];
