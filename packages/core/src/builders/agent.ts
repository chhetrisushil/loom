import type {
  AgentDefinition,
  AgentSkillDef,
  PolicyDefinition,
  ToolDefinition,
} from "../types/definitions";

export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  tools: ToolDefinition[];
  policies?: PolicyDefinition[];
  memoryId?: string;
  version?: string;
  capabilities?: { streaming?: boolean };
  skills?: AgentSkillDef[];
}

export function agent$(config: AgentConfig): AgentDefinition {
  return {
    _tag: "AgentDefinition",
    id: config.id,
    name: config.name,
    tools: config.tools,
    ...(config.description !== undefined && { description: config.description }),
    ...(config.policies !== undefined && { policies: config.policies }),
    ...(config.memoryId !== undefined && { memoryId: config.memoryId }),
    ...(config.version !== undefined && { version: config.version }),
    ...(config.capabilities !== undefined && { capabilities: config.capabilities }),
    ...(config.skills !== undefined && { skills: config.skills }),
  };
}
