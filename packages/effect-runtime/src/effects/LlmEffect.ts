import type { Effect, EffectContext, EffectDelta } from "../types";

export interface LlmEffectOptions {
  /**
   * Advisory pre-warm — invoked by the kernel ahead of use to keep the
   * provider's connection/model cache hot (see {@link Effect.warm}). Wired by
   * `createLlmEffect` to the provider's `warm()`. Latency-only.
   */
  warm?: () => void | Promise<void>;
  /** ADR 0119 — the configured delta sink the runtime guards (see `Effect.deltaSink`). */
  deltaSink?: (chunk: EffectDelta, ctx: EffectContext) => void;
}

export class LlmEffect<TIn = unknown, TOut = unknown> implements Effect<TIn, TOut> {
  readonly kind = "llm" as const;
  readonly warm?: () => void | Promise<void>;
  readonly deltaSink?: (chunk: EffectDelta, ctx: EffectContext) => void;

  constructor(
    private readonly fn: (input: TIn, ctx: EffectContext) => Promise<TOut>,
    options: LlmEffectOptions = {}
  ) {
    if (options.warm !== undefined) this.warm = options.warm;
    if (options.deltaSink !== undefined) this.deltaSink = options.deltaSink;
  }

  execute(input: TIn, ctx: EffectContext): Promise<TOut> {
    return this.fn(input, ctx);
  }
}
