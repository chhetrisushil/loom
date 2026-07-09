import type { EffectContext, EffectMiddleware, ResourceSnapshot } from "@loom/effect-runtime";

// ── Resource accounting & quotas (Loom 2.0 K3) ───────────────────────────────
//
// The scarce resource for intelligent software is tokens / $ / latency, not CPU
// cycles. This middleware meters every effect it wraps as a durable RESOURCE_METERED
// fact (folded into `variables._resources`), and — given a budget — enforces a quota
// by admission control: once an execution has spent its budget, the next effect is
// refused (QUOTA_EXCEEDED + a thrown QuotaExceededError that fails the step). Both
// the accounting and the enforcement are replay-safe (metered facts live in the log;
// the running total is read from the deterministic fold via `ctx.resources`).

export interface ResourceDelta {
  tokens?: number;
  costUsd?: number;
  ms?: number;
}

export interface MeterInfo {
  stepId: string;
  input: unknown;
  /** The effect's result — `undefined` when metering an aborted effect (K8). */
  result: unknown;
  /** Measured wall-time of the effect, in ms. */
  ms: number;
  /**
   * K8 — true when the effect was severed mid-flight (cancellation/deadline).
   * The wall-time up to the abort is still metered so cancel-before-completion
   * cannot evade budgets; pricing may add provider-reported partial usage.
   */
  aborted?: boolean;
}

/** Compute the resource delta for one effect call — e.g. tokens×rate for an LLM. */
export type Pricing = (info: MeterInfo) => ResourceDelta;

export interface Budget {
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface MeteringOptions {
  pricing: Pricing;
  /** When set, an execution over budget has its next effect denied (admission control). */
  budget?: Budget;
  /** Injectable clock (defaults to Date.now); only affects the measured `ms`. */
  clock?: () => number;
}

export class QuotaExceededError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Quota exceeded: ${reason}`);
    this.name = "QuotaExceededError";
    this.reason = reason;
  }
}

function overBudget(r: ResourceSnapshot, b: Budget): string | null {
  if (b.maxCostUsd !== undefined && r.costUsd >= b.maxCostUsd) {
    return `cost ${r.costUsd} >= budget ${b.maxCostUsd} USD`;
  }
  if (b.maxTokens !== undefined && r.tokens >= b.maxTokens) {
    return `tokens ${r.tokens} >= budget ${b.maxTokens}`;
  }
  return null;
}

/** Read token usage from an LlmResponse-shaped result (`{ usage: { inputTokens, outputTokens } }`). */
export function llmUsageTokens(result: unknown): number {
  const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number } } | null)
    ?.usage;
  if (usage === undefined || usage === null) return 0;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

export function meteringMiddleware(options: MeteringOptions): EffectMiddleware {
  const now = options.clock ?? (() => Date.now());
  return async (ctx: EffectContext, input: unknown, next): Promise<unknown> => {
    // Admission control: refuse if the execution has already spent its budget.
    if (options.budget !== undefined && ctx.resources !== undefined) {
      const reason = overBudget(ctx.resources, options.budget);
      if (reason !== null) {
        ctx.emit("QUOTA_EXCEEDED", { stepId: ctx.stepId, reason });
        throw new QuotaExceededError(reason);
      }
    }

    const start = now();
    let result: unknown;
    try {
      result = await next();
    } catch (err) {
      // K8 — meter an aborted effect before rethrowing. Metering normally runs
      // after next(), so a severed call would never be seen and
      // start-expensive-effect → cancel → repeat could evade the budget forever.
      // Only aborts are metered here; an ordinary failure keeps today's
      // unmetered semantics.
      if (ctx.signal?.aborted === true) {
        const ms = now() - start;
        const delta = options.pricing({
          stepId: ctx.stepId,
          input,
          result: undefined,
          ms,
          aborted: true,
        });
        ctx.emit("RESOURCE_METERED", {
          ...(delta.tokens !== undefined && { tokens: delta.tokens }),
          ...(delta.costUsd !== undefined && { costUsd: delta.costUsd }),
          ms: delta.ms ?? ms,
        });
      }
      throw err;
    }
    const ms = now() - start;

    const delta = options.pricing({ stepId: ctx.stepId, input, result, ms });
    ctx.emit("RESOURCE_METERED", {
      ...(delta.tokens !== undefined && { tokens: delta.tokens }),
      ...(delta.costUsd !== undefined && { costUsd: delta.costUsd }),
      ms: delta.ms ?? ms,
    });
    return result;
  };
}
