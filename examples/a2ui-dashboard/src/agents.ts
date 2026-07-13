import { agent$, tool$ } from "@loom/core";
import type { AgentDefinition } from "@loom/core";
import { z } from "zod";

// ── The monitoring fleet ──────────────────────────────────────────────────────
//
// Three independent monitoring agents. Each is a first-class `agent$` with ONE
// responsibility — and, crucially for this example, each drives its OWN live UI
// panel. `defineConfig({ a2ui: true })` registers one A2UI surface per agent
// (`surfaceId = agent.id`), so the agent renders into `createA2UIEmitter(emit,
// agent.id)` with no hand-wired surface registration. The dashboard is just the
// union of the per-agent surfaces.

const probe = (id: string, name: string, description: string): AgentDefinition =>
  agent$({
    id,
    name,
    description,
    version: "1.0.0",
    tools: [
      tool$({
        id: `${id}-probe`,
        name: `${name} probe`,
        description,
        inputSchema: z.object({ host: z.string() }),
        outputSchema: z.object({ value: z.number(), status: z.string() }),
      }),
    ],
  });

export const CpuAgent = probe("cpu-agent", "CPU Monitor", "Samples CPU load and renders a gauge");
export const MemoryAgent = probe("memory-agent", "Memory Monitor", "Samples memory pressure");
export const DiskAgent = probe("disk-agent", "Disk Monitor", "Samples disk utilization");

export const FLEET: AgentDefinition[] = [CpuAgent, MemoryAgent, DiskAgent];
