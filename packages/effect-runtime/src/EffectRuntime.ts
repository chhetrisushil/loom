import type { Effect, EffectContext, EffectMiddleware, EffectNext } from "./types";

export class EffectRuntime {
  private readonly registry = new Map<string, Effect>();
  private readonly middleware: readonly EffectMiddleware[];

  /**
   * @param middleware Cross-cutting middleware applied around every effect
   * execution, in order — `middleware[0]` is outermost. The list is fixed here
   * (static ⇒ deterministic across replay). An empty list (the default) makes
   * `execute` behave identically to a bare effect call.
   */
  constructor(middleware: readonly EffectMiddleware[] = []) {
    this.middleware = middleware;
  }

  register(toolId: string, effect: Effect): void {
    this.registry.set(toolId, effect);
  }

  async execute<TIn = unknown, TOut = unknown>(
    toolId: string,
    input: TIn,
    ctx: EffectContext
  ): Promise<TOut> {
    const effect = this.registry.get(toolId);
    if (!effect) {
      throw new Error(`No effect registered for toolId: "${toolId}"`);
    }

    if (this.middleware.length === 0) {
      return effect.execute(input, ctx) as Promise<TOut>;
    }

    // Fold the chain right-to-left over the base effect call so middleware[0]
    // ends up outermost (its `next` runs middleware[1], … the effect last).
    let next: EffectNext = () => effect.execute(input, ctx);
    for (let i = this.middleware.length - 1; i >= 0; i--) {
      const mw = this.middleware[i]!;
      const downstream = next;
      next = () => mw(ctx, input, downstream);
    }
    return next() as Promise<TOut>;
  }

  has(toolId: string): boolean {
    return this.registry.has(toolId);
  }
}
