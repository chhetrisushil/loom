# ADR 0119 — Streaming deltas from a decider's governed call

- Status: **Accepted** (2026-10-06)
- Date: 2026-10-06
- Builds on: [ADR 0066](0066-transient-effect-invocation-facade.md) (`invokeTransient`), L30 (`ctx.decide`'s scope runs AS the
  deciding execution), [ADR 0085](0085-untrusted-content-integrity-axis.md) (untrusted content),
  `createLlmEffect({ stream: true })` (R9).
- Consumer: loom-ui U1 (streaming planner, chhetrisushil/loom-ui#51).
- Placement: **additive 1P SPI extension of the decide scope.** Not a kernel change: no syscall, no event
  kind, no payload field. `EVENT_SCHEMA` and `KERNEL_ABI` are unchanged (the scope is a userspace handle over
  `EffectRuntime.invokeTransient`; the `abi.test.ts` syscall inventory is untouched).

## Context

`DecideScope.invokeTransient` returns a `Promise`, so a decider that wanted tokens as they arrive had to call
the model OUTSIDE the scope, skipping everything the scope exists for: K2 authorization and delegation, R9
middleware (rate limit, kill switch, envelope), `guardRequest` taint fencing, budget admission, the scope's
composed cancellation, and declared reach (L32). loom already streams INSIDE the effect ring
(`createLlmEffect({ stream: true, onDelta })`), but the sink is fixed when the effect is registered — one sink
for every caller — so it cannot say which decide call a delta belongs to.

## Decision

1. **A per-call sink.** `DecideScope.invokeTransient(toolId, input, { signal?, onDelta? })` where
   `onDelta: DeltaSink = (chunk: EffectDelta) => void`. The same option exists on
   `EffectRuntime.invokeTransient` (`TransientInvokeOptions.onDelta`); the scope only forwards it.
2. **It travels in the effect's context.** The runtime puts a wrapped sink on `EffectContext.onDelta`.
   The call otherwise takes the identical path — authorizer, middleware chain, effect-mode check, metering
   admission, kill switch, `signal` — so governance is the same **by construction**: there is no second
   code path to keep in step. A refused call never reaches the effect, so its sink is never called.
3. **Delta payload.** `EffectDelta = { delta: string; done?: true; usage?: { inputTokens; outputTokens } }`.
   Text deltas carry `delta` (non-empty); the **terminal** chunk is `{ delta: "", done: true, usage? }`, so a
   caller learns the spend (a transient call's `emit` is a no-op, so the charge is otherwise invisible).
   Plain strings were rejected: usage would need a second channel. The provider's `LlmStreamChunk` was
   rejected as the public type: it carries `toolCalls`/`stopReason`, which belong to the returned response,
   not to a live view.
4. **Precedence.** `createLlmEffect` calls its configured `onDelta` AND `ctx.onDelta`; neither replaces the
   other (the configured sink is the app's tail, the per-call sink is the caller's). The terminal chunk is
   sent on the streamed path only — a `complete` fallback produced no deltas to terminate.
   `createAgentModelEffect` is a thin wrapper over `createLlmEffect` and needs no change.
5. **Live-only.** Deltas are never journaled and are not called on replay (a recorded decision serves
   `choice` and the decider never runs). The decision records only the decider's return value.
6. **A sink cannot hurt the call.** The runtime hands the effect a wrapper that swallows a throw (reported
   through `EffectRuntimeOptions.onWarn`, default `console.warn`) and goes silent once the call settles, so
   a late write from an un-awaited provider cannot reach a caller who has moved on. The sink is synchronous
   and fire-and-forget; there is no backpressure — a slow sink slows only itself if it blocks, so it must
   not.
7. **Bounding is the effect's.** The runtime does not cap delta volume: it cannot know a token from a byte.
   `streamTokenBudget` (K8.4) already severs a generation mid-flight and is the intended bound.
8. **Cancellation composes.** The call's `signal` is the scope's composition (execution cancel + the
   decider's `signal` + the scope's lifetime), unchanged. An abort mid-stream rejects the call with the abort
   reason; nothing is recorded because the decider threw.
9. **Taint (ADR 0085).** Deltas are **untrusted model text**. They are not wrapped in the taint value (a
   sink is a UI tail, not a prompt position); a sink that feeds them into another prompt MUST treat them as
   untrusted content and go through `guardRequest`. The final return value remains the governed artifact.

## Consequences

- A streaming planner is expressible inside the scope with no governance bypass.
- `EffectContext` gains one optional field; effects that ignore it are unaffected.
- The terminal chunk's `usage` is advisory (what the provider reported), not a metering record.

## Rejected

- A loom-ui-side router re-implementing the call outside the scope (the bypass this closes).
- Journaling deltas, or making them an async iterable return (ST-R: fold economics).
- Replacing the effect's configured sink when a per-call sink is present (surprising to the app's tail).
