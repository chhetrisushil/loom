import type { Effect, EffectContext } from "../types";

export class LlmEffect<TIn = unknown, TOut = unknown> implements Effect<TIn, TOut> {
  readonly kind = "llm" as const;

  constructor(private readonly fn: (input: TIn, ctx: EffectContext) => Promise<TOut>) {}

  execute(input: TIn, ctx: EffectContext): Promise<TOut> {
    return this.fn(input, ctx);
  }
}
