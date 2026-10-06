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

import { BUILTIN_METER_DIMENSIONS, isVocabularyName } from "@loom/core";

export interface ResourceDelta {
  tokens?: number;
  costUsd?: number;
  ms?: number;
  // ADR 0032 (R1) — additional dimensions, metered only where an effect can measure
  // them (e.g. a K7 isolated child reports peak RSS). All optional and additive;
  // an effect that doesn't report a dimension leaves it undefined (no false zeros).
  /** Peak resident memory attributable to the effect, in bytes. */
  memBytes?: number;
  /** Wall-clock time, in ms (distinct from `ms` when the effect runs off-thread). */
  wallMs?: number;
  /** Network bytes transferred by the effect. */
  netBytes?: number;
  /**
   * ADR 0115 — open dimensions (`gpu_seconds`, `credits`), by name. Folded into
   * `_resources.custom`; the kernel assigns no unit and no price, so converting these to money
   * is this pricing function's job. At most 32 names, each matching `VOCABULARY_NAME_PATTERN`
   * (`@loom/core`), never a built-in name. A bad name (or value) makes `ctx.emit` throw AFTER the
   * effect ran, like a built-in ceiling breach.
   */
  custom?: Readonly<Record<string, number>>;
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
  // ADR 0032 (R1) — ceilings for the additional dimensions. Only enforced when set.
  maxMemBytes?: number;
  maxWallMs?: number;
  maxNetBytes?: number;
  /**
   * ADR 0115 — ceilings for open dimensions, by name (`{ gpu_seconds: 60 }`): an execution whose
   * `_resources.custom[name]` has reached the ceiling has its next effect denied, like every
   * other dimension. Only enforced where set.
   */
  maxCustom?: Readonly<Record<string, number>>;
}


/** True when `name` is a built-in metering dimension (never a custom one). */
export function isBuiltinDimension(name: string): boolean {
  return BUILTIN_METER_DIMENSIONS.has(name);
}

/** True when `name` is a valid custom dimension name (pattern shared with the fold's guard). */
export function isCustomDimensionName(name: string): boolean {
  return isVocabularyName(name) && !BUILTIN_METER_DIMENSIONS.has(name);
}

/**
 * Validate a `Budget.maxCustom` and return a FROZEN shallow copy to enforce against (so a later
 * mutation of the caller's object cannot smuggle in a built-in name or a bad ceiling). Refuses a
 * built-in dimension name (use `maxTokens` etc.: a custom ceiling on `tokens` would read
 * `_resources.custom.tokens`, which nothing meters) and a non-numeric ceiling.
 */
export function assertMaxCustom(
  maxCustom: Readonly<Record<string, number>> | undefined
): Readonly<Record<string, number>> | undefined {
  if (maxCustom === undefined) return undefined;
  for (const [name, max] of Object.entries(maxCustom)) {
    if (BUILTIN_METER_DIMENSIONS.has(name)) {
      throw new Error(
        `Budget.maxCustom."${name}" names a built-in dimension; use its own max field (e.g. maxTokens)`
      );
    }
    if (typeof max !== "number" || !Number.isFinite(max) || max < 0) {
      throw new Error(`Budget.maxCustom."${name}" must be a finite non-negative number`);
    }
  }
  return Object.freeze({ ...maxCustom });
}

/** The first custom ceiling the spend has reached, as a reason — own-property reads only. */
export function overCustomBudget(
  custom: Readonly<Record<string, number>> | undefined,
  maxCustom: Readonly<Record<string, number>> | undefined
): string | null {
  if (maxCustom === undefined) return null;
  for (const [name, max] of Object.entries(maxCustom)) {
    const spent =
      custom !== undefined && Object.hasOwn(custom, name) ? (custom[name] as number) : 0;
    if (spent >= max) return `${name} ${spent} >= budget ${max}`;
  }
  return null;
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
  /** A budget refusal is a decision; retrying repeats it (`retryMiddleware` honours this). */
  readonly retryable = false;
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
  if (b.maxMemBytes !== undefined && (r.memBytes ?? 0) >= b.maxMemBytes) {
    return `memBytes ${r.memBytes ?? 0} >= budget ${b.maxMemBytes}`;
  }
  if (b.maxWallMs !== undefined && (r.wallMs ?? 0) >= b.maxWallMs) {
    return `wallMs ${r.wallMs ?? 0} >= budget ${b.maxWallMs}`;
  }
  if (b.maxNetBytes !== undefined && (r.netBytes ?? 0) >= b.maxNetBytes) {
    return `netBytes ${r.netBytes ?? 0} >= budget ${b.maxNetBytes}`;
  }
  return overCustomBudget(r.custom, b.maxCustom);
}

/** The RESOURCE_METERED payload for a delta — only dimensions the pricing reported. */
export function meteredPayload(
  delta: ResourceDelta,
  ms: number
): Record<string, number | Readonly<Record<string, number>>> {
  return {
    ...(delta.tokens !== undefined && { tokens: delta.tokens }),
    ...(delta.costUsd !== undefined && { costUsd: delta.costUsd }),
    ...(delta.memBytes !== undefined && { memBytes: delta.memBytes }),
    ...(delta.wallMs !== undefined && { wallMs: delta.wallMs }),
    ...(delta.netBytes !== undefined && { netBytes: delta.netBytes }),
    ...(delta.custom !== undefined && { custom: delta.custom }),
    ms: delta.ms ?? ms,
  };
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
  const frozenMax = assertMaxCustom(options.budget?.maxCustom);
  const budget: Budget | undefined =
    options.budget === undefined
      ? undefined
      : { ...options.budget, ...(frozenMax !== undefined && { maxCustom: frozenMax }) };
  return async (ctx: EffectContext, input: unknown, next): Promise<unknown> => {
    // Admission control: refuse if the execution has already spent its budget.
    if (budget !== undefined && ctx.resources !== undefined) {
      const reason = overBudget(ctx.resources, budget);
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
        ctx.emit("RESOURCE_METERED", meteredPayload(delta, ms));
      }
      throw err;
    }
    const ms = now() - start;

    const delta = options.pricing({ stepId: ctx.stepId, input, result, ms });
    ctx.emit("RESOURCE_METERED", meteredPayload(delta, ms));
    return result;
  };
}
