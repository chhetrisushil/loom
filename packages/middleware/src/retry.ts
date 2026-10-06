import { SuspendError, TypedFailure } from "@loom/core";
import type { EffectContext, EffectMiddleware } from "@loom/effect-runtime";

export interface RetryOptions {
  /** Max retries after the first attempt. Default 2 (⇒ up to 3 tries). */
  maxRetries?: number;
  /** Delay before the first retry, in ms. Default 100. */
  baseDelayMs?: number;
  /** Exponential growth factor between retries. Default 2. */
  factor?: number;
  /** Upper bound on any single delay, in ms. Default 30_000. */
  maxDelayMs?: number;
  /** Spread delays deterministically to avoid thundering herds. Default true. */
  jitter?: boolean;
  /**
   * Decide whether a given error is retryable. Default: all (non-control) errors
   * EXCEPT `TypedFailure` (DE-4) — a declared domain outcome is not transient, so
   * retrying it by default would just burn attempts on a deterministic result — and any
   * error that declares `retryable: false` (R9's `KillSwitchEngagedError`,
   * `RateLimitExceededError`, `SpawnLimitExceededError`, `SafetyViolationError`).
   * An explicit `isRetryable` retains full control (retrying a TypedFailure
   * in-memory is legal: no durable event has been emitted yet).
   */
  isRetryable?: (err: unknown) => boolean;
  /** Observability hook fired before each backoff wait. */
  onRetry?: (info: { ctx: EffectContext; attempt: number; delayMs: number; err: unknown }) => void;
  /** Injectable sleep (for tests). Must reject if `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Retry-with-backoff middleware — fills the gap where effect failures are
 * terminal today. Wraps a single `EffectRuntime.execute`; on a retryable error
 * it waits (exponential backoff + deterministic jitter) and re-invokes the
 * effect, up to `maxRetries` times.
 *
 * Correctness rules:
 *  - **Never retries `SuspendError`** (a control-flow signal, not a failure) or a
 *    **cancelled** execution (`ctx.signal.aborted`) — both rethrow immediately.
 *  - Retries happen **in-memory within one execute call** and emit no durable
 *    events, so the STEP_STARTED/COMPLETED envelope and the event log stay
 *    deterministic; use `onRetry` for logging/metrics. Exhaustion rethrows the
 *    last error into the existing `STEP_FAILED` path — behavior-preserving.
 *  - Jitter is a deterministic hash of `executionId:stepId:attempt` (no
 *    `Math.random`), so replay/behaviour stays stable.
 */
export function retryMiddleware(options: RetryOptions = {}): EffectMiddleware {
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const factor = options.factor ?? 2;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const useJitter = options.jitter ?? true;
  const isRetryable =
    options.isRetryable ??
    ((err: unknown) =>
      !(err instanceof TypedFailure) &&
      // R9 — a control-plane refusal (kill switch, rate limit, spawn cap) marks itself
      // `retryable: false`: it is a decision, and retrying repeats it.
      (err as { retryable?: unknown } | null)?.retryable !== false);
  const sleep = options.sleep ?? defaultSleep;

  return async (ctx, _input, next) => {
    for (let attemptIndex = 0; ; attemptIndex++) {
      try {
        return await next();
      } catch (err) {
        // Control-flow + cancellation are never "failures" to retry.
        if (err instanceof SuspendError) throw err;
        if (ctx.signal?.aborted === true) throw err;
        if (attemptIndex >= maxRetries || !isRetryable(err)) throw err;

        const delayMs = computeDelay(
          attemptIndex,
          { baseDelayMs, factor, maxDelayMs, useJitter },
          ctx
        );
        options.onRetry?.({ ctx, attempt: attemptIndex + 1, delayMs, err });
        await sleep(delayMs, ctx.signal);
      }
    }
  };
}

function computeDelay(
  attemptIndex: number,
  cfg: { baseDelayMs: number; factor: number; maxDelayMs: number; useJitter: boolean },
  ctx: EffectContext
): number {
  const base = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * cfg.factor ** attemptIndex);
  if (!cfg.useJitter) return Math.round(base);
  // Deterministic "full jitter" in [base/2, base] — stable across replay.
  const frac = hashFraction(`${ctx.executionId}:${ctx.stepId}:${attemptIndex}`);
  return Math.round(base / 2 + frac * (base / 2));
}

/** FNV-1a → [0, 1). Deterministic; no Math.random. */
function hashFraction(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 to unsigned, scale into [0,1)
  return (h >>> 0) / 0xffffffff;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error("aborted");
}
