import type { z } from "zod";
import type { FlowDefinition, PolicyDefinition, StepDefinition } from "../types/definitions";

export interface FlowConfig<TIn, TOut> {
  id: string;
  name: string;
  version: string;
  description?: string;
  inputSchema: z.ZodSchema<TIn>;
  outputSchema: z.ZodSchema<TOut>;
  // biome-ignore lint/suspicious/noExplicitAny: a flow's steps are heterogeneous — each step has its own input/output types, so the array element type must erase them
  steps: StepDefinition<any, any>[];
  policies?: PolicyDefinition[];
  /**
   * K8.3 — declarative wall-clock deadline for a live run of this flow,
   * anchored to the LOGGED `EXECUTION_STARTED` timestamp (stable across
   * recovery — a crash never resets it). Breach = kernel-driven cancellation
   * (`EXECUTION_CANCELLED`). Enforced while a process is actively running the
   * execution; durable firing across idle suspension is T1's timer service.
   */
  deadlineMs?: number;
}

export function flow$<TIn = unknown, TOut = unknown>(
  config: FlowConfig<TIn, TOut>
): FlowDefinition<TIn, TOut> {
  return {
    _tag: "FlowDefinition",
    id: config.id,
    name: config.name,
    version: config.version,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    steps: config.steps,
    ...(config.description !== undefined && { description: config.description }),
    ...(config.policies !== undefined && { policies: config.policies }),
    ...(config.deadlineMs !== undefined && { deadlineMs: config.deadlineMs }),
  };
}
