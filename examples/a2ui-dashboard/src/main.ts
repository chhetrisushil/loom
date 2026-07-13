import type { A2UISurfaceState } from "@loom/a2ui";
import { buildApp } from "./app";
import { PANELS } from "./flows";
import { renderPanel } from "./render";

// A headless driver: runs each monitoring agent against a host, then renders each
// agent's OWN A2UI surface. Nothing wires surfaces by hand — `a2ui: true` gave each
// agent$ a surface, and each flow drove it via `createA2UIEmitter(emit, agentId)`.
async function main(): Promise<void> {
  const app = buildApp();
  const host = process.argv[2] ?? "web-2"; // web-1 healthy, web-2 under pressure

  console.log(`\n📊 Ops dashboard for ${host} — one A2UI surface per agent (a2ui: true)\n`);

  // Run every agent's flow; each drives its own surface under its own execution.
  const runs = await Promise.all(
    PANELS.map(async (panel) => {
      const handle = await app.runtime.start(panel.flow, { host });
      await handle.waitForCompletion();
      return { agentId: panel.agentId, executionId: handle.executionId };
    })
  );

  // Render each agent's surface — read straight from the projection runtime.
  for (const run of runs) {
    const surface = app.projectionRuntime.getState<A2UISurfaceState>(run.agentId, run.executionId);
    console.log(renderPanel(run.agentId, surface));
    console.log("");
  }

  await app.close();
}

void main();
