import type { ModelRoute } from "@loom/reasoning";
import { GemmaProvider } from "./GemmaProvider";
import { changeSpecJsonSchema } from "./schema";

// The recommended Gemma tiers for the appgen planner, ordered for the elevation ladder.
// "E" = effective parameters (Per-Layer Embeddings keep memory low for a larger effective
// depth). Pick the *tier* as the contract; pin exact model files/ids at install time.

export interface GemmaTier {
  /** Route id used in traces/logs. */
  id: string;
  /** Ladder position: lower = cheaper/weaker (start here), higher = elevate target. */
  tier: number;
  approxRamGb: number;
  note: string;
}

export const GEMMA_TIERS: Record<string, GemmaTier> = {
  e2b: { id: "gemma-e2b", tier: 0, approxRamGb: 4, note: "floor: greenfield schema-fill" },
  e4b: {
    id: "gemma-e4b",
    tier: 0,
    approxRamGb: 5,
    note: "default: brownfield planning (4-bit QAT)",
  },
  "12b": { id: "gemma-12b", tier: 1, approxRamGb: 8, note: "ceiling: vague intent / large repo" },
};

/** The default planner tier (best intelligence/footprint balance). */
export const DEFAULT_TIER = "e4b";

/**
 * Build a cheap-first {@link ModelRoute} from a local .gguf and a tier key, wiring a
 * grammar-constrained {@link GemmaProvider}. Feed the returned route(s) to
 * `planChangesModel({ routes })`.
 */
export function gemmaRoute(modelPath: string, tierKey: string = DEFAULT_TIER): ModelRoute {
  const tier = GEMMA_TIERS[tierKey] ?? GEMMA_TIERS[DEFAULT_TIER]!;
  return {
    id: tier.id,
    tier: tier.tier,
    tags: ["planning"],
    provider: new GemmaProvider({ modelPath, jsonSchema: changeSpecJsonSchema() }),
  };
}
