import { type LoomApp, defineConfig } from "@loom/app";
import { FLEET } from "./agents";
import { PANELS } from "./flows";

/**
 * The composition root — one `defineConfig` call. Passing the `agent$` DEFINITIONS
 * (not hand-built cards) unlocks both batteries-included flags:
 *
 *   a2a:  true → derive + register each agent's discoverable A2A `AgentCard`.
 *   a2ui: true → register ONE A2UI surface per agent (`surfaceId = agent.id`), so
 *                each agent can drive its own live panel with zero surface wiring.
 *
 * Both are opt-in; omit them and you register cards/surfaces by hand as before.
 */
export function buildApp(): LoomApp {
  return defineConfig({
    storage: { kind: "memory" },
    flows: PANELS.map((p) => p.flow),
    agents: FLEET,
    a2a: true,
    a2ui: true,
  });
}
