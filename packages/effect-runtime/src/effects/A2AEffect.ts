import type { Effect, EffectContext } from "../types";

/**
 * @deprecated ADR 0115 — the `a2a` effect belongs to `@loom/plugin-a2a`, which now defines and
 * exports its own `A2AEffect`. This copy stays for one minor so existing imports keep working
 * (a re-export would make this kernel-adjacent package depend on a plugin). `"a2a"` is just a
 * custom kind to the kernel.
 */
export class A2AEffect<TIn = unknown, TOut = unknown> implements Effect<TIn, TOut> {
  readonly kind = "a2a" as const;

  constructor(private readonly fn: (input: TIn, ctx: EffectContext) => Promise<TOut>) {}

  execute(input: TIn, ctx: EffectContext): Promise<TOut> {
    return this.fn(input, ctx);
  }
}
