import type { Effect, EffectContext, EffectMode, ErrorChannelSchema } from "../types";

export interface ToolEffectOptions {
  /**
   * K9.3 — declared delivery semantic for this tool (see {@link Effect.idempotent}).
   * `false` = mutating & non-idempotent: recovery parks an unknown-state attempt at
   * EFFECT_INDOUBT instead of silently re-running it. Omit for the legacy
   * at-least-once re-run.
   */
  idempotent?: boolean;
  /**
   * DE-4 — declared failure channels for this tool (see {@link Effect.errors}).
   * Pass the same map declared on the `tool$` contract so the kernel's registry
   * fallback sees it. Omit for legacy untyped failure semantics.
   */
  errors?: Record<string, ErrorChannelSchema>;
  /**
   * ADR 0073 — which invocation seam this tool belongs to. Pass the same value
   * declared on the `tool$` contract; this registered copy is the enforced one.
   * Omit to keep today's behaviour on both seams.
   */
  mode?: EffectMode;
}

export class ToolEffect<TIn = unknown, TOut = unknown> implements Effect<TIn, TOut> {
  readonly kind = "tool" as const;
  readonly idempotent?: boolean;
  readonly errors?: Record<string, ErrorChannelSchema>;
  readonly mode?: EffectMode;

  constructor(
    private readonly fn: (input: TIn, ctx: EffectContext) => Promise<TOut>,
    options: ToolEffectOptions = {}
  ) {
    if (options.idempotent !== undefined) {
      this.idempotent = options.idempotent;
    }
    if (options.errors !== undefined) {
      this.errors = options.errors;
    }
    if (options.mode !== undefined) {
      this.mode = options.mode;
    }
  }

  execute(input: TIn, ctx: EffectContext): Promise<TOut> {
    return this.fn(input, ctx);
  }
}
