import type { AgentDefinition } from "@loom/core";
import type { AgentCard } from "./types";

// Options for deriving an AgentCard from an agent$ definition. Everything here is
// deployment/runtime context that does not belong on the agent definition itself.
export interface ToAgentCardOptions {
  // Public URL for the agent. Defaults to the in-process scheme derived from the
  // agent id; an A2AServer overrides this with the resolved address at request
  // time (see createA2AServer, which takes Omit<AgentCard, "url">).
  url?: string;
  // Fallback version if the definition does not carry one.
  version?: string;
  // Fallback capabilities if the definition does not carry them.
  capabilities?: { streaming?: boolean };
}

// Derive the public A2A AgentCard from an agent definition. name/description come
// straight from the definition; skills/capabilities/version are read from the
// (optional) card metadata authored on agent$, falling back to opts then to sane
// defaults. This is the single source of truth that removes the hand-written,
// drift-prone card objects.
export function toAgentCard(agent: AgentDefinition, opts: ToAgentCardOptions = {}): AgentCard {
  return {
    name: agent.name,
    description: agent.description ?? "",
    url: opts.url ?? `loom+inproc://${agent.id}`,
    version: agent.version ?? opts.version ?? "1.0.0",
    capabilities: agent.capabilities ?? opts.capabilities ?? { streaming: false },
    skills: agent.skills ?? [],
  };
}
