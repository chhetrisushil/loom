import type { EffectMiddleware } from "@loom/effect-runtime";

/** Effect-side timings, in milliseconds. */
export interface EffectProfile {
  /** Effect invocations that completed (successfully or not). */
  calls: number;
  /** Summed wall time inside effects. */
  totalEffectMs: number;
  /** Longest single effect. */
  maxEffectMs: number;
  /** Greatest number of effects in flight at once. */
  peakConcurrentEffects: number;
  /** Per-tool breakdown, so a single slow tool is visible rather than averaged away. */
  byTool: Record<string, { calls: number; totalMs: number }>;
}

export interface EffectProfiler {
  middleware: EffectMiddleware;
  profile(): EffectProfile;
  reset(): void;
}

/**
 * Measures what effects actually cost, as the counterpart to `ProfilingEventStore`.
 *
 * Together they answer [ADR 0065](../../../docs/adr/0065-group-commit-deferred-evidence-gate.md)
 * gate 1: is **event-write throughput** the bottleneck for this workload, or is it effect
 * latency? The gate requires that question be settled by profiling rather than intuition,
 * and it is not rhetorical — `ExecutionJournal` queues appends on a serial tail, so the
 * interpreter is decoupled from write latency and a workload can write a great deal without
 * writes ever constraining it.
 *
 * Wire it as effect-runtime middleware in your own app, wrap your store in
 * `ProfilingEventStore`, run real traffic, and compare `totalEffectMs` against
 * `totalWriteMs`. Batching the write path can only help if the latter dominates.
 */
export function effectTimingMiddleware(): EffectProfiler {
  let calls = 0;
  let totalEffectMs = 0;
  let maxEffectMs = 0;
  let inFlight = 0;
  let peakConcurrentEffects = 0;
  const byTool = new Map<string, { calls: number; totalMs: number }>();

  const middleware: EffectMiddleware = async (ctx, input, next) => {
    const started = performance.now();
    inFlight++;
    if (inFlight > peakConcurrentEffects) peakConcurrentEffects = inFlight;
    try {
      return await next(input);
    } finally {
      const elapsed = performance.now() - started;
      inFlight--;
      calls++;
      totalEffectMs += elapsed;
      if (elapsed > maxEffectMs) maxEffectMs = elapsed;
      // `stepId` is the tool identity at this seam; fall back so an unnamed effect still
      // shows up rather than vanishing from the breakdown.
      const tool = ctx.stepId || "<unknown>";
      const entry = byTool.get(tool);
      if (entry === undefined) byTool.set(tool, { calls: 1, totalMs: elapsed });
      else {
        entry.calls++;
        entry.totalMs += elapsed;
      }
    }
  };

  return {
    middleware,
    profile: () => ({
      calls,
      totalEffectMs,
      maxEffectMs,
      peakConcurrentEffects,
      byTool: Object.fromEntries([...byTool].map(([k, v]) => [k, { ...v }])),
    }),
    reset: () => {
      calls = 0;
      totalEffectMs = 0;
      maxEffectMs = 0;
      peakConcurrentEffects = 0;
      byTool.clear();
    },
  };
}
