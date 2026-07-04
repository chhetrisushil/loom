import type { Effect, EffectContext } from "../types";

export class ToolEffect<TIn = unknown, TOut = unknown> implements Effect<TIn, TOut> {
  readonly kind = "tool" as const;

  constructor(private readonly fn: (input: TIn, ctx: EffectContext) => Promise<TOut>) {}

  execute(input: TIn, ctx: EffectContext): Promise<TOut> {
    return this.fn(input, ctx);
  }
}
