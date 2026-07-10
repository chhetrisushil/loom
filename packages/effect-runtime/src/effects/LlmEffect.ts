import type { Effect, EffectContext } from "../types";

export interface LlmEffectOptions {
  /**
   * Advisory pre-warm — invoked by the kernel ahead of use to keep the
   * provider's connection/model cache hot (see {@link Effect.warm}). Wired by
   * `createLlmEffect` to the provider's `warm()`. Latency-only.
   */
  warm?: () => void | Promise<void>;
}

export class LlmEffect<TIn = unknown, TOut = unknown> implements Effect<TIn, TOut> {
  readonly kind = "llm" as const;
  readonly warm?: () => void | Promise<void>;

  constructor(
    private readonly fn: (input: TIn, ctx: EffectContext) => Promise<TOut>,
    options: LlmEffectOptions = {}
  ) {
    if (options.warm !== undefined) this.warm = options.warm;
  }

  execute(input: TIn, ctx: EffectContext): Promise<TOut> {
    return this.fn(input, ctx);
  }
}
