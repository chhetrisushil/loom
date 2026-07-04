import type { Effect, EffectContext } from "./types";

export class EffectRuntime {
  private readonly registry = new Map<string, Effect>();

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
    return effect.execute(input, ctx) as Promise<TOut>;
  }

  has(toolId: string): boolean {
    return this.registry.has(toolId);
  }
}
