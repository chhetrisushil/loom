import type { Effect, EffectContext } from "../types";

export interface ToolEffectOptions {
  /**
   * K9.3 — declared delivery semantic for this tool (see {@link Effect.idempotent}).
   * `false` = mutating & non-idempotent: recovery parks an unknown-state attempt at
   * EFFECT_INDOUBT instead of silently re-running it. Omit for the legacy
   * at-least-once re-run.
   */
  idempotent?: boolean;
}

export class ToolEffect<TIn = unknown, TOut = unknown> implements Effect<TIn, TOut> {
  readonly kind = "tool" as const;
  readonly idempotent?: boolean;

  constructor(
    private readonly fn: (input: TIn, ctx: EffectContext) => Promise<TOut>,
    options: ToolEffectOptions = {}
  ) {
    if (options.idempotent !== undefined) {
      this.idempotent = options.idempotent;
    }
  }

  execute(input: TIn, ctx: EffectContext): Promise<TOut> {
    return this.fn(input, ctx);
  }
}
