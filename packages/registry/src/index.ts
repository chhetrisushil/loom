import type { AgentDefinition } from "@loom/core";

// Structural agent card shape. Mirrors the AgentCard served by @loom/a2a but is
// defined locally so the registry package stays dependency-light (core only).
export interface RegisteredAgentCard {
  name: string;
  description?: string;
  url?: string;
  version: string;
  capabilities?: { streaming?: boolean };
  skills?: Array<{ id: string; name: string; description?: string }>;
}

export interface RegisteredAgent {
  definition: AgentDefinition;
  card?: RegisteredAgentCard;
}

export class AgentRegistry {
  private readonly agents = new Map<string, RegisteredAgent>();

  register(definition: AgentDefinition, card?: RegisteredAgentCard): this {
    this.agents.set(definition.id, { definition, ...(card !== undefined && { card }) });
    return this;
  }

  get(id: string): RegisteredAgent | undefined {
    return this.agents.get(id);
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  all(): RegisteredAgent[] {
    return [...this.agents.values()];
  }

  ids(): string[] {
    return [...this.agents.keys()];
  }
}

export const globalAgentRegistry = new AgentRegistry();
