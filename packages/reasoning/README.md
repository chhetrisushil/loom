# @loomwork/reasoning — model routing and elevation

`ReasoningRuntime` picks a model from a set of tiered routes, scores the answer, and moves to a stronger
tier when the score is below a threshold. The stages are separate and replaceable: a `Router` chooses the
first route, a `ConfidenceSignal` scores each answer, and `elevateThreshold` (default 0.5) decides whether
to climb to the next tier. Pass `ctx.decide` and each routing and elevation choice is recorded, so a replay
makes the same choices. Use it when cheap-first routing with escalation is worth the extra calls.
`IntentRuntime` and `PlannerRuntime` accept it as `reasoning`, and `agentLoop$` calls it through an
`invoke` that runs each model call as a journaled effect.

```ts
import type { LlmProvider, LlmResponse } from "@loomwork/llm";
import { ReasoningRuntime, validatorConfidence } from "@loomwork/reasoning";

// Stand-ins for real providers: the cheap model answers badly, the strong one answers well.
const provider = (content: string): LlmProvider => ({
  complete: async (): Promise<LlmResponse> => ({ content, stopReason: "end_turn" }),
});

const reasoning = new ReasoningRuntime({
  routes: [
    { id: "small", provider: provider("not json"), tier: 0 },
    { id: "large", provider: provider('{"ok":true}'), tier: 1 },
  ],
  // Elevate until the output validates, instead of trusting the model's stop reason.
  confidence: validatorConfidence((text) => {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }),
});

const result = await reasoning.reason({ messages: [{ role: "user", content: "Reply with JSON." }] });
console.log(result.modelId, result.elevated); // "large" true; result.trace has one entry per call
```

## Surface

- **Runtime.** `new ReasoningRuntime({ routes, router?, confidence?, elevateThreshold?, cache? })`,
  `reason(request, { decide?, invoke?, wrapCall?, decisionKey?, cacheScope?, signal? })` and
  `availableRoutes`. A `ReasoningResult` carries `content`, `toolCalls`, `stopReason`, `usage`, `modelId`,
  `confidence`, `elevated` and a `trace` of every call.
- **Routers.** `tagRouter` (default: the lowest tier whose `tags` include `strategy`, else the lowest
  tier), `fixedRouter(id)`, `rankedRouter(rankings, { minSamples?, fallback? })`, `ucb1(stats, ...)` and
  `epsilonGreedy(inner, { epsilon })`. The learned ones take per-route evidence such as
  `outcomeAnalytics(events)` from `@loomwork/analytics`.
- **Confidence.** `stopReasonConfidence` (default: 0.9 for `end_turn` and `tool_use`, 0.3 for
  `max_tokens`), `validatorConfidence(fn)` (1 or 0) and `constantConfidence(n)`.
- **Types.** `ModelRoute`, `ReasoningRequest` (with `strategy` and `maxTier`), `ModelInvoker`,
  `ReasoningCache`, and `DecideFn`, which has the same shape as `ctx.decide`.

## Behaviour that surprises people

- **The direct path is outside the effect ring.** Without `invoke`, the runtime calls
  `route.provider.complete` itself, so there is no authorization, metering or kill switch on that call. It
  still runs `guardRequest`, so tainted content in an instruction position is refused. To make each model
  call a journaled effect, supply an `invoke` (what `agentLoop$` does). With `invoke` the response cache is
  bypassed, so whether a durable frame exists does not depend on a process-local cache.
- **Routing is recorded only if you pass `decide`.** Without it the choices run inline and are not
  replay-stable.
- **Confidence is a pluggable signal, not a self-reported number.** The default reads only the stop
  reason. `maxTier` caps elevation as a budget.
- **Elevation climbs one strictly higher tier at a time** and stops at the top tier or `maxTier`. A cache
  is optional (`ReasoningCache` is just an interface) and, if you share one across tenants, scope it with
  `cacheScope`.
- **`rankedRouter` can collapse onto what it already chose**, because arms it stops picking stop
  generating outcomes. Wrap it in `epsilonGreedy` or use `ucb1`, which is deterministic (no RNG).
- **Captured reasoning is text-free here.** Reasoning parts leave this runtime in recorded form only;
  readable text goes to a sidecar through `@loomwork/llm` (ADR 0133).

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loomwork/reasoning` — model routing & elevation" in [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [user guide, section 15: reasoning runtime](../../docs/user-guide.md#15-reasoning-runtime--routing--elevation), [reasoning and memory](../../docs/loom-2.0/02-reasoning-and-memory.md).
- ADRs: [0016 execution runtime and decision seam](../../docs/adr/0016-loom-2.0-execution-runtime-and-decision-seam.md), [0121 one canonical agent loop](../../docs/adr/0121-one-canonical-agent-loop.md), [0133 model reasoning audit capture](../../docs/adr/0133-model-reasoning-audit-capture.md).
- Source: `packages/reasoning/src`.
