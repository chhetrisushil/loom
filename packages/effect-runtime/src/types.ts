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

/** Invokes the downstream middleware, or finally the effect itself. */
export type EffectNext = () => Promise<unknown>;

/**
 * Wraps a single effect execution — the cross-cutting seam (retries, logging,
 * tracing, idempotency) around every tool/LLM/human/a2a call.
 *
 * Replay-safety: middleware runs ONLY when an effect actually executes. Completed
 * steps short-circuit in `WorkflowContext.run` before `EffectRuntime.execute` is
 * called, so replayed/resumed runs never re-invoke middleware for work already in
 * the log. The one in-flight step that re-runs on crash-recovery re-runs its
 * middleware too, so any middleware with external side effects must tolerate
 * at-least-once (prefer emitting durable events via `ctx.emit`).
 *
 * Ordering is static (fixed at `EffectRuntime` construction) so it is
 * deterministic across replay: `middleware[0]` is outermost.
 */
export type EffectMiddleware = (
  ctx: EffectContext,
  input: unknown,
  next: EffectNext
) => Promise<unknown>;
