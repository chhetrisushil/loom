import type { EffectKind } from "@loom/core";

export type { EffectKind };

export interface EffectContext {
  executionId: string;
  stepId: string;
  workflowId: string;
  attempt: number;
  emit(eventType: string, payload: unknown): void;
}

export interface Effect<TIn = unknown, TOut = unknown> {
  kind: EffectKind;
  execute(input: TIn, ctx: EffectContext): Promise<TOut>;
}
