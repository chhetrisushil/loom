import type { ZodSchema } from "zod";
import type { RegisteredFlow } from "@loom/workflow-runtime";
import type { CapabilityDefinition } from "./types";

export interface CapabilityConfig<TIn, TOut> {
  id: string;
  name?: string;
  intent: string;
  tags?: string[];
  inputSchema: ZodSchema<TIn>;
  flow: RegisteredFlow<TIn, TOut>;
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
  };
}
