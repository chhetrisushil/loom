import { SuspendError } from "@loom/core";
import type { Effect, EffectContext } from "../types";

export interface HumanEffectConfig {
  on: string;
  timeout?: number;
  correlationKey?: (input: unknown) => string;
}

export class HumanEffect<TIn = unknown, TOut = unknown> implements Effect<TIn, TOut> {
  readonly kind = "human" as const;

  constructor(private readonly config: HumanEffectConfig) {}

  execute(input: TIn, _ctx: EffectContext): Promise<TOut> {
    const correlationKey =
      this.config.correlationKey !== undefined ? this.config.correlationKey(input) : undefined;

    throw new SuspendError({
      on: this.config.on,
      ...(this.config.timeout !== undefined && { timeout: this.config.timeout }),
      ...(correlationKey !== undefined && { correlationKey }),
    });
  }
}
