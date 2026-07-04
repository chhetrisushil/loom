import type { Effect, EffectContext } from "../types";

export class A2AEffect<TIn = unknown, TOut = unknown> implements Effect<TIn, TOut> {
  readonly kind = "a2a" as const;

  constructor(private readonly fn: (input: TIn, ctx: EffectContext) => Promise<TOut>) {}

  execute(input: TIn, ctx: EffectContext): Promise<TOut> {
    return this.fn(input, ctx);
  }
}
