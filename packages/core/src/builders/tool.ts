import type { z } from "zod";
import type { EffectKind, ToolDefinition } from "../types/definitions";

export interface ToolConfig<TIn, TOut> {
  id: string;
  name: string;
  description: string;
  kind?: EffectKind;
  inputSchema: z.ZodSchema<TIn>;
  outputSchema: z.ZodSchema<TOut>;
  /**
   * K9 — declared delivery semantic (see {@link ToolDefinition.idempotent}).
   * `false` = mutating & non-idempotent: recovery parks an unknown-state attempt
   * at EFFECT_INDOUBT instead of silently re-running. Undeclared = legacy
   * at-least-once re-run. Pass the same value to the registered effect
   * (`new ToolEffect(fn, { idempotent })`) — the effect registry is where the
   * kernel reads it.
   */
  idempotent?: boolean;
  /**
   * K7.3 — static egress allowlist (`host:port` entries) for tools that run
   * ISOLATED (`@loom/isolate`'s IsolatedToolEffect). Declaration metadata, like
   * `idempotent`: the enforced copy lives on the registered IsolatedToolSpec;
   * the kernel-side broker denies anything else before connection with a
   * durable EGRESS_DENIED fact. In-process ToolEffects have ambient authority —
   * isolation is what turns this from convention into guarantee.
   */
  egress?: string[];
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
    ...(config.idempotent !== undefined && { idempotent: config.idempotent }),
  };
}
