import type { Effect, EffectContext } from "@loom/effect-runtime";

/**
 * The effect that fronts a call to an agent-to-agent peer. Its kind, `"a2a"`, names this
 * plugin's protocol; the kernel treats it as an ordinary custom kind (advisory metadata only,
 * ADR 0115). Moved here from `@loom/effect-runtime`, which keeps a deprecated copy for one minor.
 */
export class A2AEffect<TIn = unknown, TOut = unknown> implements Effect<TIn, TOut> {
  readonly kind = "a2a" as const;

  constructor(private readonly fn: (input: TIn, ctx: EffectContext) => Promise<TOut>) {}

  execute(input: TIn, ctx: EffectContext): Promise<TOut> {
    return this.fn(input, ctx);
  }
}
