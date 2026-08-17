import type { z } from "zod";
import type {
  HandlerFn,
  HandlerRef,
  HandlerSpec,
  ReachableTool,
  RetryPolicy,
  StepDefinition,
} from "../types/definitions";

export interface StepConfig<TIn, TOut> {
  id: string;
  name?: string;
  toolId?: string;
  /**
   * EF — the class of side effect this step's tool performs, from the app's
   * `checks.effectClasses` ordering (e.g. `"external-write"`). Descriptive
   * metadata: read by `@loom/verify`'s `effect-class` rule at composition time,
   * never by the runtime. Absent ⇒ the step is unclassified and the rule reports
   * the flow as only partially verified rather than passing it silently.
   */
  effectClass?: string;
  handler?: HandlerSpec<TIn, TOut>;
  inputSchema: z.ZodSchema<TIn>;
  outputSchema: z.ZodSchema<TOut>;
  retry?: RetryPolicy;
  timeoutMs?: number;
  /** DE-4 — declared failure channels (channel → payload schema); see {@link StepDefinition.errors}. */
  errors?: Record<string, z.ZodSchema>;
  /**
   * Capabilities this step can reach at run time without declaring each as a step —
   * an agent's tool menu, an A2A peer's skills. See {@link ReachableTool}. Read by
   * `@loom/verify`; absent ⇒ nothing added, and the flow verifies exactly as before.
   */
  reachableTools?: readonly ReachableTool[];
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
    ...(config.effectClass !== undefined && { effectClass: config.effectClass }),
    ...(config.reachableTools !== undefined && { reachableTools: config.reachableTools }),
  };
}

export function handler$<TIn = unknown, TOut = unknown>(
  fn: HandlerFn<TIn, TOut>
): HandlerRef<TIn, TOut> {
  return { _loomHandlerRef: true, fn };
}
