import type { EffectContext, EffectMiddleware } from "@loom/effect-runtime";

// ── Effect rate limiting (R9 — autonomy envelope) ────────────────────────────
//
// A runaway agent is not only expensive, it is FAST: a tool loop can issue thousands of
// effects a second long before a token budget notices (a cheap tool meters ~0 tokens).
// A token bucket bounds the RATE of effects per scope, which the cost budgets cannot.
//
// It lives at the EFFECT layer, not in the fold, so it is replay-safe: middleware runs only
// when an effect actually executes (completed steps are served from the log and never reach
// it), and a refusal is a thrown error that fails the step through the ordinary path. The
// bucket state is process-local and wall-clock driven by design — it is admission control,
// not a fact about the execution — so it never enters the log and two nodes each enforce
// their own bucket (the limit is per process; cluster-wide limits are a store-backed
// concern this middleware deliberately does not pretend to solve).

/** Which requests share one bucket. */
export type RateLimitScope = "execution" | "tenant" | "workflow" | "global";

export interface RateLimitOptions {
  /** Bucket size: the burst a scope may issue at once. Must be a positive integer. */
  capacity: number;
  /** Sustained rate: tokens added per second. Must be positive. */
  refillPerSecond: number;
  /**
   * Who shares a bucket. Default `"execution"` (one runaway execution cannot starve the
   * rest). `"tenant"` keys on `ctx.principal.tenant` — a request with no tenant shares ONE
   * `"(no-tenant)"` bucket rather than escaping the limit. `"workflow"` keys on the flow id
   * (the per-agent case); `"global"` is one bucket for the process.
   */
  scope?: RateLimitScope;
  /** Injectable clock in ms (tests); defaults to `Date.now`. */
  clock?: () => number;
  /**
   * Upper bound on live buckets. A fresh bucket is created per execution/tenant key, so an
   * unbounded map would be a leak; the least-recently-used bucket is evicted past this size
   * (an evicted key simply starts full again — it can only err toward permitting). Default 10_000.
   */
  maxBuckets?: number;
}

/**
 * The typed, NON-retryable refusal for a rate-limit trip. It is the control plane speaking,
 * not a transient fault: retrying immediately repeats it, so callers that classify errors by
 * `name` (loom-ui's `isControlPlaneError`) must treat `"RateLimitExceededError"` as a refusal.
 */
export class RateLimitExceededError extends Error {
  readonly scope: RateLimitScope;
  readonly key: string;
  /** Milliseconds until one token is available again (a hint, never a promise). */
  readonly retryAfterMs: number;
  /** Honoured by `retryMiddleware`'s default classifier: an immediate retry repeats the refusal. */
  readonly retryable = false;
  constructor(scope: RateLimitScope, key: string, retryAfterMs: number) {
    super(`Rate limit exceeded for ${scope} "${key}" — retry after ~${retryAfterMs}ms`);
    this.name = "RateLimitExceededError";
    this.scope = scope;
    this.key = key;
    this.retryAfterMs = retryAfterMs;
  }
}

interface Bucket {
  tokens: number;
  at: number;
}

function keyOf(scope: RateLimitScope, ctx: EffectContext): string {
  switch (scope) {
    case "execution":
      return ctx.executionId;
    case "workflow":
      return ctx.workflowId;
    case "tenant":
      return ctx.principal?.tenant ?? "(no-tenant)";
    case "global":
      return "*";
  }
}

export function rateLimitMiddleware(options: RateLimitOptions): EffectMiddleware {
  const { capacity, refillPerSecond } = options;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`rateLimitMiddleware: capacity must be a positive integer (got ${capacity})`);
  }
  if (!(refillPerSecond > 0) || !Number.isFinite(refillPerSecond)) {
    throw new Error(
      `rateLimitMiddleware: refillPerSecond must be a positive number (got ${refillPerSecond})`
    );
  }
  const scope = options.scope ?? "execution";
  const now = options.clock ?? (() => Date.now());
  const maxBuckets = options.maxBuckets ?? 10_000;
  // Map iteration order is insertion order, so delete+set on every touch keeps the OLDEST
  // key first — an O(1) LRU without a second structure.
  const buckets = new Map<string, Bucket>();

  return async (ctx, _input, next): Promise<unknown> => {
    const key = keyOf(scope, ctx);
    const t = now();
    const bucket = buckets.get(key) ?? { tokens: capacity, at: t };
    buckets.delete(key);
    const elapsedSec = Math.max(0, t - bucket.at) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSecond);
    bucket.at = t;
    const admitted = bucket.tokens >= 1;
    if (admitted) bucket.tokens -= 1;
    buckets.set(key, bucket);
    if (buckets.size > maxBuckets) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    if (!admitted) {
      const retryAfterMs = Math.ceil(((1 - bucket.tokens) / refillPerSecond) * 1000);
      ctx.emit("SAFETY_BLOCKED", {
        stepId: ctx.stepId,
        validatorId: "rate-limit",
        phase: "input",
        reason: `rate limit exceeded for ${scope} "${key}"`,
        category: "rate-limit",
      });
      throw new RateLimitExceededError(scope, key, retryAfterMs);
    }
    return next();
  };
}
