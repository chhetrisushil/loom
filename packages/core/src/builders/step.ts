import type { z } from "zod";
import type {
  HandlerFn,
  HandlerRef,
  HandlerSpec,
  RetryPolicy,
  StepDefinition,
} from "../types/definitions";

export interface StepConfig<TIn, TOut> {
  id: string;
  name?: string;
  toolId?: string;
  handler?: HandlerSpec<TIn, TOut>;
  inputSchema: z.ZodSchema<TIn>;
  outputSchema: z.ZodSchema<TOut>;
  retry?: RetryPolicy;
  timeoutMs?: number;
  /** DE-4 — declared failure channels (channel → payload schema); see {@link StepDefinition.errors}. */
  errors?: Record<string, z.ZodSchema>;
}

export function step$<TIn = unknown, TOut = unknown>(
  config: StepConfig<TIn, TOut>
): StepDefinition<TIn, TOut> {
  return {
    _tag: "StepDefinition",
    id: config.id,
    name: config.name ?? config.id,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    ...(config.toolId !== undefined && { toolId: config.toolId }),
    ...(config.handler !== undefined && { handler: config.handler }),
    ...(config.retry !== undefined && { retry: config.retry }),
    ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
    ...(config.errors !== undefined && { errors: config.errors }),
  };
}

export function handler$<TIn = unknown, TOut = unknown>(
  fn: HandlerFn<TIn, TOut>
): HandlerRef<TIn, TOut> {
  return { _loomHandlerRef: true, fn };
}
