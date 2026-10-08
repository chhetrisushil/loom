import type { RegisteredFlow } from "@loom/workflow-runtime";
import type { ZodSchema } from "zod";
import type { CapabilityDefinition } from "./types";

export interface CapabilityConfig<TIn, TOut> {
  id: string;
  name?: string;
  intent: string;
  tags?: string[];
  inputSchema: ZodSchema<TIn>;
  flow: RegisteredFlow<TIn, TOut>;
  /** Semver of this capability (M7). */
  version?: string;
  /** Ids of capabilities this one depends on (M7). */
  dependencies?: string[];
  /** R16 — accepts tainted values bound by a plan's `$from` (see `CapabilityDefinition.acceptsTainted`). The opt-in is a promise: nothing re-taints this capability's OUTPUT. */
  acceptsTainted?: boolean;
  /** R22 (ADR 0125) — user phrasings for search. */
  aliases?: string[];
}

// Wraps a RegisteredFlow as an intent-addressable capability.
export function capability$<TIn = unknown, TOut = unknown>(
  config: CapabilityConfig<TIn, TOut>
): CapabilityDefinition<TIn, TOut> {
  return {
    _tag: "CapabilityDefinition",
    id: config.id,
    name: config.name ?? config.id,
    intent: config.intent,
    tags: config.tags ?? [],
    inputSchema: config.inputSchema,
    flow: config.flow,
    ...(config.version !== undefined && { version: config.version }),
    ...(config.dependencies !== undefined && { dependencies: config.dependencies }),
    ...(config.acceptsTainted === true && { acceptsTainted: true }),
    ...(config.aliases !== undefined && { aliases: config.aliases }),
  };
}
