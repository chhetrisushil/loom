import { z } from "zod";
import type { EffectKind, ToolDefinition } from "../types/definitions";

export interface ToolConfig<TIn, TOut> {
  id: string;
  name: string;
  description: string;
  kind?: EffectKind;
  inputSchema: z.ZodSchema<TIn>;
  outputSchema: z.ZodSchema<TOut>;
}

export function tool$<TIn = unknown, TOut = unknown>(
  config: ToolConfig<TIn, TOut>
): ToolDefinition<TIn, TOut> {
  return {
    _tag: "ToolDefinition",
    id: config.id,
    name: config.name,
    description: config.description,
    kind: config.kind ?? "tool",
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
  };
}
