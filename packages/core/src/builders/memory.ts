import type { MemoryDefinition } from "../types/definitions";

export interface MemoryConfig {
  id: string;
  name: string;
  ttlMs?: number;
  maxEntries?: number;
}

export function memory$(config: MemoryConfig): MemoryDefinition {
  return {
    _tag: "MemoryDefinition",
    id: config.id,
    name: config.name,
    ...(config.ttlMs !== undefined && { ttlMs: config.ttlMs }),
    ...(config.maxEntries !== undefined && { maxEntries: config.maxEntries }),
  };
}
