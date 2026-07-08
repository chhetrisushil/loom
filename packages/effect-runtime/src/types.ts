import type { EffectKind } from "@loom/core";

export type { EffectKind };

/**
 * Running resource totals for the owning execution (Loom 2.0 K3). Threaded into
 * each effect's context so accounting/quota middleware can meter usage and enforce
 * budgets. Accumulated durably in `variables._resources` via RESOURCE_METERED, so
 * the snapshot is deterministic on replay.
 */
export interface ResourceSnapshot {
  tokens: number;
  costUsd: number;
  ms: number;
  count: number;
  /** Set once a quota has been exceeded. */
  exceeded?: boolean;
}

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
  /**
   * Running resource totals for this execution BEFORE this effect (K3). Undefined
   * when accounting is not wired, so effects/middleware that don't meter pay nothing.
   */
  readonly resources?: ResourceSnapshot;
  /**
   * Scheduling priority for this effect (M6), used when the EffectRuntime routes
   * effects through a Scheduler with a finite concurrency cap. A `@loom/scheduler`
   * Priority value (0 = Immediate … 3 = Idle). Undefined ⇒ Normal.
   */
  readonly priority?: number;
}

/**
 * Advisory pre-warm hook (M6). Called off the durable path before an effect runs so a
 * backend can keep a model/connection/cache hot. It is latency-only — it MUST NOT emit
 * events or influence outcomes (P10 advisory plane). A failed/absent warm just means a
 * cold call.
 */
export interface Warmer {
  warm(toolId: string): void;
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
