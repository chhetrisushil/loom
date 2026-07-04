import { z } from "zod";
import type { RetryPolicy, StepDefinition } from "../types/definitions";

export interface StepConfig<TIn, TOut> {
  id: string;
  name: string;
  toolId?: string;
  inputSchema: z.ZodSchema<TIn>;
  outputSchema: z.ZodSchema<TOut>;
  retry?: RetryPolicy;
  timeoutMs?: number;
}

export function step$<TIn = unknown, TOut = unknown>(
  config: StepConfig<TIn, TOut>
): StepDefinition<TIn, TOut> {
  return {
    _tag: "StepDefinition",
    id: config.id,
    name: config.name,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    ...(config.toolId !== undefined && { toolId: config.toolId }),
    ...(config.retry !== undefined && { retry: config.retry }),
    ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
  };
}
