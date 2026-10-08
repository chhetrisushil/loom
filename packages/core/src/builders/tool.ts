import type { z } from "zod";
import type { EffectKind, EffectMode, ToolDefinition } from "../types/definitions";

export interface ToolConfig<TIn, TOut> {
  id: string;
  name: string;
  description: string;
  kind?: EffectKind;
  inputSchema: z.ZodSchema<TIn>;
  outputSchema: z.ZodSchema<TOut>;
  /** R4b — see {@link ToolDefinition.jsonInputSchema}. */
  jsonInputSchema?: Readonly<Record<string, unknown>>;
  /** R4b — see {@link ToolDefinition.trustJsonSchemaText}. */
  trustJsonSchemaText?: boolean;
  /** R5 — see {@link ToolDefinition.returnsMedia}. */
  returnsMedia?: boolean;
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
  /**
   * DE-4 — declared failure channels (channel → payload schema). Like
   * `idempotent`, declaration metadata: pass the same map to the registered
   * effect (`Effect.errors`) — the effect registry is where the kernel reads it
   * when the invoking step doesn't declare its own.
   */
  errors?: Record<string, z.ZodSchema>;
  /**
   * ADR 0073 — which side of the determinism boundary this tool may be invoked
   * from: `"journaled"` (inside an execution, result recorded & replay-substituted) or
   * `"ambient"` (transient read/enrichment only, zero durable footprint). Like
   * `idempotent`, declaration metadata: pass the same value to the registered
   * effect (`new ToolEffect(fn, { mode })`), where the boundary check reads it.
   * Omit to keep today's behaviour on both paths.
   */
  mode?: EffectMode;
  /** R22 (ADR 0125 D7) — see {@link ToolDefinition.origin}. Plugins that build tools from remote declarations set `"remote"`. */
  origin?: "remote";
  /** R22 (ADR 0125) — declared tags for tool search. */
  tags?: readonly string[];
  /** R22 (ADR 0125) — user phrasings for tool search ("bill the customer"); see `ToolDefinition.aliases`. */
  aliases?: readonly string[];
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
    ...(config.jsonInputSchema !== undefined && { jsonInputSchema: config.jsonInputSchema }),
    ...(config.trustJsonSchemaText !== undefined && {
      trustJsonSchemaText: config.trustJsonSchemaText,
    }),
    ...(config.returnsMedia !== undefined && { returnsMedia: config.returnsMedia }),
    ...(config.idempotent !== undefined && { idempotent: config.idempotent }),
    ...(config.errors !== undefined && { errors: config.errors }),
    ...(config.mode !== undefined && { mode: config.mode }),
    ...(config.origin !== undefined && { origin: config.origin }),
    ...(config.tags !== undefined && { tags: config.tags }),
    ...(config.aliases !== undefined && { aliases: config.aliases }),
  };
}
