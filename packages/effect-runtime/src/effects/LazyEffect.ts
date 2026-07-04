import type { HandlerFn, HandlerLoader, HandlerRef, HandlerSpec } from "@loom/core";
import type { Effect, EffectContext } from "../types";

function isHandlerRef<TIn, TOut>(spec: HandlerSpec<TIn, TOut>): spec is HandlerRef<TIn, TOut> {
  return (spec as HandlerRef<TIn, TOut>)._loomHandlerRef === true;
}

export class LazyEffect<TIn = unknown, TOut = unknown> implements Effect<TIn, TOut> {
  readonly kind = "tool" as const;
  private resolved: HandlerFn<TIn, TOut> | undefined;

  constructor(private readonly spec: HandlerSpec<TIn, TOut>) {}

  async execute(input: TIn, ctx: EffectContext): Promise<TOut> {
    if (!this.resolved) {
      if (isHandlerRef(this.spec)) {
        this.resolved = this.spec.fn as HandlerFn<TIn, TOut>;
      } else {
        const mod = await (this.spec as HandlerLoader<TIn, TOut>)();
        this.resolved = mod.default;
      }
    }
    return this.resolved(input, ctx);
  }
}
