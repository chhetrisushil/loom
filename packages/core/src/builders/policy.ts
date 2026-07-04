import type { PolicyDefinition } from "../types/definitions";

export interface PolicyConfig {
  id: string;
  name: string;
  rules: Record<string, unknown>;
}

export function policy$(config: PolicyConfig): PolicyDefinition {
  return {
    _tag: "PolicyDefinition",
    id: config.id,
    name: config.name,
    rules: config.rules,
  };
}
