import type { EffectKind } from "@loom/core";

export type { EffectKind };

export interface EffectContext {
  executionId: string;
  stepId: string;
  workflowId: string;
  attempt: number;
  emit(eventType: string, payload: unknown): void;
  /**
   * Cooperative cancellation for this effect. Aborts when the owning execution is
   * cancelled. Long-running/I/O effects (LLM, tool, A2A) should forward it to
   * `fetch`/providers and check it at await points. Optional and undefined by
   * default, so non-cancellable effects pay nothing.
   */
  readonly signal?: AbortSignal;
}

export interface Effect<TIn = unknown, TOut = unknown> {
  kind: EffectKind;
  execute(input: TIn, ctx: EffectContext): Promise<TOut>;
}
