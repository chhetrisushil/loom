import type { ZodSchema } from "zod";

export type EffectKind = "tool" | "llm" | "human" | "a2a";

// ── Handler types (used by handler$() and the compiler) ──────────────────────

export interface StepHandlerContext {
  executionId: string;
  stepId: string;
  workflowId: string;
  attempt: number;
  emit(eventType: string, payload: unknown): void;
}

export type HandlerFn<TIn = unknown, TOut = unknown> = (
  input: TIn,
  ctx: StepHandlerContext
) => Promise<TOut>;

export type HandlerLoader<TIn = unknown, TOut = unknown> = () => Promise<{
  default: HandlerFn<TIn, TOut>;
}>;

export interface HandlerRef<TIn = unknown, TOut = unknown> {
  readonly _loomHandlerRef: true;
  readonly fn: HandlerFn<TIn, TOut>;
}

export type HandlerSpec<TIn = unknown, TOut = unknown> =
  | HandlerRef<TIn, TOut>
  | HandlerLoader<TIn, TOut>;

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs?: number;
  backoffMultiplier?: number;
}

export interface PolicyDefinition {
  readonly _tag: "PolicyDefinition";
  id: string;
  name: string;
  rules: Record<string, unknown>;
}

export interface MemoryDefinition {
  readonly _tag: "MemoryDefinition";
  id: string;
  name: string;
  ttlMs?: number;
  maxEntries?: number;
}

export interface ToolDefinition<TIn = unknown, TOut = unknown> {
  readonly _tag: "ToolDefinition";
  id: string;
  name: string;
  description: string;
  kind: EffectKind;
  inputSchema: ZodSchema<TIn>;
  outputSchema: ZodSchema<TOut>;
}

export interface StepDefinition<TIn = unknown, TOut = unknown> {
  readonly _tag: "StepDefinition";
  id: string;
  name: string;
  toolId?: string;
  handler?: HandlerSpec<TIn, TOut>;
  inputSchema: ZodSchema<TIn>;
  outputSchema: ZodSchema<TOut>;
  retry?: RetryPolicy;
  timeoutMs?: number;
}

export interface FlowDefinition<TIn = unknown, TOut = unknown> {
  readonly _tag: "FlowDefinition";
  id: string;
  name: string;
  version: string;
  description?: string;
  inputSchema: ZodSchema<TIn>;
  outputSchema: ZodSchema<TOut>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps: StepDefinition<any, any>[];
  policies?: PolicyDefinition[];
}

export interface ProjectionDefinition<TState = unknown> {
  readonly _tag: "ProjectionDefinition";
  id: string;
  name: string;
  sourceFlowId?: string;
  initialState: TState;
  handlers: Record<string, (state: TState, payload: unknown) => TState>;
}

export interface AgentDefinition {
  readonly _tag: "AgentDefinition";
  id: string;
  name: string;
  description?: string;
  tools: ToolDefinition[];
  policies?: PolicyDefinition[];
  memoryId?: string;
}
