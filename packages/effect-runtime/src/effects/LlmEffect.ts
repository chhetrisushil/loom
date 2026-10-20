import type { TaintedValue } from "@loom/classify";
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
  /** ADR 0133 D6 - the configured reasoning sink the runtime guards (see `Effect.reasoningSink`). */
  reasoningSink?: (delta: TaintedValue<string>, ctx: EffectContext) => void;
}

export class LlmEffect<TIn = unknown, TOut = unknown> implements Effect<TIn, TOut> {
  readonly kind = "llm" as const;
  readonly warm?: () => void | Promise<void>;
  readonly deltaSink?: (chunk: EffectDelta, ctx: EffectContext) => void;
  readonly reasoningSink?: (delta: TaintedValue<string>, ctx: EffectContext) => void;

  constructor(
    private readonly fn: (input: TIn, ctx: EffectContext) => Promise<TOut>,
    options: LlmEffectOptions = {}
  ) {
    if (options.warm !== undefined) this.warm = options.warm;
    if (options.deltaSink !== undefined) this.deltaSink = options.deltaSink;
    if (options.reasoningSink !== undefined) this.reasoningSink = options.reasoningSink;
  }

  execute(input: TIn, ctx: EffectContext): Promise<TOut> {
    return this.fn(input, ctx);
  }
}
