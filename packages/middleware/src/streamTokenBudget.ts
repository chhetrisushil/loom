import type { EffectContext } from "@loom/effect-runtime";
import type { Budget } from "./metering";
import { QuotaExceededError } from "./metering";

// ── K8.4 — sever a runaway generation WHILE it is generating ─────────────────
//
// Every other K3 enforcement point is admission control: it decides whether the
// NEXT effect runs. A model that decides to emit 100K tokens is billed in full
// and stopped afterwards, which is the gap ADR 0020 K8.4 named.
//
// ADR 0020 A5 said this cannot be middleware, and it is right: middleware wraps
// the effect and sees it once, at the end, which is exactly too late. A5 then
// proposed a usage-reporter hook on `EffectContext`, and that turned out to be
// the wrong half — both wired providers report usage ONCE, at the end (Anthropic
// in `message_delta`, OpenAI in a trailing usage-only chunk), so such a hook
// could only fire where metering already reads the number.
//
// The one thing a stream reports continuously is its own output. So the guard
// ESTIMATES from the text, and the estimate is named as an estimate everywhere it
// surfaces — in this type, in the QUOTA_EXCEEDED reason, and in the default. A
// budget guard that severs at roughly the right point is worth far more than
// exact accounting that arrives after the money is spent; it must not be sold as
// exact. Final metering is unchanged and still uses the provider's own numbers.

/**
 * Estimate output tokens from generated text. The default is the usual ~4
 * characters-per-token heuristic — deliberately crude and deliberately visible.
 * Pass a real tokenizer when the budget is tight enough for the difference to
 * matter.
 */
export type TokenEstimator = (text: string) => number;

export const estimateTokensByChars: TokenEstimator = (text) => Math.ceil(text.length / 4);

export interface StreamTokenBudgetOptions {
  /** Swap in a real tokenizer. Default {@link estimateTokensByChars}. */
  estimate?: TokenEstimator;
  /**
   * Check at most every N deltas. Estimation is O(text), so checking on every
   * token of a long generation is quadratic; the default of 8 keeps the guard
   * cheap while still severing within a few tokens of the ceiling.
   */
  checkEvery?: number;
}

/**
 * Build the `collectStream` guard that enforces a token {@link Budget} mid-flight.
 *
 * ```ts
 * createLlmEffect({
 *   provider,
 *   stream: true,
 *   buildRequest,
 *   guard: streamTokenBudget({ maxTokens: 50_000 }),
 * });
 * ```
 *
 * On breach it emits `QUOTA_EXCEEDED` — the same durable fact
 * `meteringMiddleware` writes, so an over-budget run looks the same to analytics
 * whichever gate caught it — and throws `QuotaExceededError`, which propagates
 * out of the `for await` and releases the HTTP call through K8.1's abort path.
 *
 * What is already spent comes from `ctx.resources` (K3's running totals from the
 * durable fold), so the ceiling covers the execution rather than this one call.
 * With no `ctx.resources` wired, only this generation's own output counts —
 * degraded, but never wrong in the dangerous direction.
 */
export function streamTokenBudget(
  budget: Budget,
  options: StreamTokenBudgetOptions = {}
): (ctx: EffectContext) => (progress: { text: string; deltas: number }) => void {
  const estimate = options.estimate ?? estimateTokensByChars;
  const checkEvery = Math.max(1, options.checkEvery ?? 8);

  return (ctx: EffectContext) => (progress) => {
    if (budget.maxTokens === undefined) return;
    if (progress.deltas % checkEvery !== 0) return;

    const alreadySpent = ctx.resources?.tokens ?? 0;
    const projected = alreadySpent + estimate(progress.text);
    if (projected < budget.maxTokens) return;

    const reason = `maxTokens ${budget.maxTokens} exceeded mid-stream (~${projected} estimated, ${alreadySpent} already metered)`;
    ctx.emit("QUOTA_EXCEEDED", { stepId: ctx.stepId, reason });
    throw new QuotaExceededError(reason);
  };
}
