# @loomwork/middleware

Effect middleware: wrappers that run around every tool or model call. This package has the first-party
ones: retry with backoff, token and cost metering with budgets, behavioural safety validators, secret
redaction, rate limits, a scoped kill switch, claim-check offload of large results, and timing. Use it
when a policy belongs on the effect path (before a call runs or after it returns) rather than inside a
flow. Wire it through `defineConfig` or `new EffectRuntime(middleware)`.

```ts
import { defineConfig } from "@loomwork/app";
import {
  denyPatterns,
  llmUsageTokens,
  meteringMiddleware,
  retryMiddleware,
  safetyMiddleware,
} from "@loomwork/middleware";

const app = defineConfig({
  storage: { kind: "memory" },
  execution: {
    // The first entry is outermost: safety and quota refusals sit outside the retry loop.
    effectMiddleware: [
      safetyMiddleware({ validators: [denyPatterns([/ignore previous instructions/i])] }),
      meteringMiddleware({
        pricing: ({ result }) => ({ tokens: llmUsageTokens(result) }),
        budget: { maxTokens: 200_000 },
      }),
      retryMiddleware({ maxRetries: 2, baseDelayMs: 200 }),
    ],
  },
});
```

## Surface

- **Reliability.** `retryMiddleware`, `rateLimitMiddleware` (token bucket per execution, tenant,
  workflow or process), `effectTimingMiddleware` (measures what effects cost).
- **Cost.** `meteringMiddleware` (records `RESOURCE_METERED`, enforces a `Budget`),
  `nestedBudgetMiddleware` with `BudgetLedger` (tenant, workflow and execution ceilings together),
  `streamTokenBudget` (a mid-stream guard), `QuotaExceededError`.
- **Safety.** `safetyMiddleware` with `denyPatterns`, `piiValidator`, `schemaValidator`, `killSwitch`;
  `killSwitchMiddleware` with `InMemoryKillSwitch` (stop all, a tenant, or a workflow).
- **Data.** `redactionMiddleware` with `secretRef` and `SecretResolver`; `claimCheckMiddleware`
  with `resolveClaimCheck` and `previewDigest`.

## Behaviour that surprises people

- **Order is outermost first, and it matters.** `defineConfig` itself puts, from the outside in: kill
  switch, claim-check, redaction, the autonomy envelope (rate limit, budget), then your
  `effectMiddleware`. A retry wrapper placed outside a refusing middleware would re-attempt the refusal.
- **Retry is in-memory and quiet.** Retries inside one `execute` write no events; use `onRetry` to
  observe them. It never retries a `SuspendError` or an aborted execution. By default it also skips a
  `TypedFailure` and any error with `retryable: false` (safety, quota, rate limit and kill switch
  errors all set it). Defaults: 2 retries, 100 ms base, factor 2, 30 s cap, deterministic jitter.
- **A budget is checked before an effect, not during it.** Metering refuses the next effect once spend
  is at or over the budget, so the call that crosses it still runs and is metered. Use
  `streamTokenBudget` to cut a streamed call mid-flight.
- **Rate limits are per process.** Bucket state is local, wall-clock driven and never logged, so two
  nodes each enforce their own limit. Buckets are LRU-bounded (10,000 by default).
- **The kill switch refuses the next effect.** It does not interrupt one already running, and it fails
  closed if its registry throws.
- **Safety validators run on live execution only.** A replay serves completed steps from the log and
  does not call them. A block is recorded as `SAFETY_BLOCKED`. For a streamed call, an output
  validator without a delta form makes the runtime refuse streaming to every delta sink, and the delta
  check sees only a trailing window (4096 characters by default), so a pattern longer than that can
  slip through the live tail.
- **`piiValidator` is a few regular expressions** (email, US SSN, card-like digits), not a classifier.
- **Claim-check defaults differ.** The middleware's inline cap is 16 KiB; `defineConfig`'s
  `execution.claimCheck` defaults to 1 KiB. An offloaded blob is TTL-reclaimable unless `retain` is set.

## See also

- API reference: section "`@loomwork/middleware` — effect middleware" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guide: [quotas, supervision and cancellation](../../docs/user-guide/quotas-supervision-and-cancellation.md).
- ADRs: [0054 claim-check](../../docs/adr/0054-claim-check-middleware.md),
  [0119 streaming deltas](../../docs/adr/0119-decide-scope-streaming-deltas.md),
  [0140 claim-check for agent state](../../docs/adr/0140-agent-claim-check-opt-in.md).

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).
