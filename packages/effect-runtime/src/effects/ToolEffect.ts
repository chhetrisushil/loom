import type { Effect, EffectContext, ErrorChannelSchema } from "../types";

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
}

export class ToolEffect<TIn = unknown, TOut = unknown> implements Effect<TIn, TOut> {
  readonly kind = "tool" as const;
  readonly idempotent?: boolean;
  readonly errors?: Record<string, ErrorChannelSchema>;

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
  }

  execute(input: TIn, ctx: EffectContext): Promise<TOut> {
    return this.fn(input, ctx);
  }
}
