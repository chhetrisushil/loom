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

Round-1 review decisions are recorded as "Decided (user, 2026-10-06)" below.

1. **A per-call sink.** `DecideScope.invokeTransient(toolId, input, { signal?, onDelta? })` where
   `onDelta: DeltaSink = (chunk: EffectDelta) => void`. The same option exists on
   `EffectRuntime.invokeTransient` (`TransientInvokeOptions.onDelta`); the scope only forwards it.
2. **It travels in the effect's context.** The runtime puts a wrapped sink on `EffectContext.onDelta`.
   The call otherwise takes the identical path — authorizer, middleware chain, effect-mode check, metering
   admission, kill switch, `signal` — so governance is the same **by construction**: there is no second
   code path to keep in step. A refused call never reaches the effect, so its sink is never called.
3. **Delta payload.** `EffectDelta = { delta: TaintedValue<string>; done?: true; reset?: true; attempt?: number;
   usage?: { inputTokens; outputTokens } }`. A text chunk carries non-empty `delta`; a **reset** chunk
   (`reset: true, attempt: n`, empty `delta`) precedes attempt `n > 1`; the **terminal** chunk is
   `{ delta: "", done: true, usage? }`, so a caller learns the spend (a transient call's `emit` is a no-op,
   so the charge is otherwise invisible). Plain strings were rejected: usage would need a second channel. The
   provider's `LlmStreamChunk` was rejected as the public type: it carries `toolCalls`/`stopReason`, which
   belong to the returned response, not to a live view.
4. **Precedence.** `createLlmEffect` calls `ctx.onDelta` AND its configured `onDelta`, per-call sink FIRST;
   neither replaces the other (the configured sink is the app's own tail, the per-call sink is the caller's, and
   is the only one middleware governs). The effect's end-of-stream chunk is sent on the streamed path only — a
   `complete` fallback produced no deltas to terminate. `createAgentModelEffect` is a thin wrapper over
   `createLlmEffect` and needs no change.
5. **Live-only.** Deltas are never journaled and are not called on replay (a recorded decision serves
   `choice` and the decider never runs). The decision records only the decider's return value.
   `redactOutput` and claim-check do NOT apply to deltas: they act on what is journaled, and nothing here is.
6. **A sink cannot hurt the call, and is silent once it should be.** The runtime hands the effect a wrapper that
   swallows a throw of the caller's sink (reported through `EffectRuntimeOptions.onWarn`, default
   `console.warn`) and delivers nothing once the call has **settled** or its **signal has aborted** — so an
   effect that ignores the signal, or an un-awaited provider writing late, cannot reach a caller who has moved on.
   `collectStream` also checks the signal in its loop and severs at the next chunk. The sink is synchronous
   and fire-and-forget; there is no backpressure — a slow sink slows only itself if it blocks, so it must not.
   **The call's promise settlement is authoritative**: the terminal `done` chunk is sent by the RUNTIME only
   after the call has succeeded (middleware output phase and `parse` included). The effect's own end-of-stream
   chunk is held (its `usage` kept) and never forwarded on failure.
7. **Bounding is the effect's.** The runtime does not cap delta volume: it cannot know a token from a byte.
   `streamTokenBudget` (K8.4) already severs a generation mid-flight and is the intended bound. In
   `collectStream` a guard now runs BEFORE delivery, so the breaching delta is never handed to a sink.
8. **Cancellation composes.** The call's `signal` is the scope's composition (execution cancel + the
   decider's `signal` + the scope's lifetime), unchanged. An abort mid-stream rejects the call with the abort
   reason; nothing is recorded because the decider threw.
9. **Taint (ADR 0085) — deltas are tainted values.** Decided (user, 2026-10-06): `EffectDelta.delta` is a
   `TaintedValue<string>` (origin `llm:<toolId>`), so `guardRequest` REFUSES it at runtime if a sink feeds it
   into a prompt. A UI tail unwraps explicitly (`unwrapTainted`) to display it — the call site is the audit
   trail. The final return value remains the governed artifact.
10. **Delta validators, fail-closed.** Decided (user, 2026-10-06): `SafetyValidator` gains a `"delta"` phase and
    an optional `checkDelta` (the delta form of an output validator). `safetyMiddleware` exposes a per-attempt
    `EffectMiddleware.deltaGuard` that checks the RUNNING text (the last `deltaWindow` chars, default 4096, so a
    pattern split across deltas is seen whole) and THROWS to sever the stream BEFORE the offending delta is
    delivered (the same mechanism as `streamTokenBudget`'s guard). `piiValidator()`/`denyPatterns()` ship delta
    forms, so the default config protects streams. **Fail-closed:** a middleware marked
    `EffectMiddleware.inspectsOutput` (an output validator with NO delta form) makes the runtime REFUSE the
    per-call sink — warn via `onWarn`, the call completes non-streamed — so no configuration streams
    unvalidated text past an output validator. Limits, stated plainly: text before a match completes is
    delivered (a card number is severed at its last digit); a pattern wider than the window across deltas can
    evade the delta form (the output form still sees the whole result, after the tail has it); `redactOutput`
    does not run on deltas.
11. **Reset on retry.** Decided (user, 2026-10-06): the runtime counts `effect.execute` invocations of the call
    (a retry middleware re-enters it) and sends `{ delta: "", reset: true, attempt: n }` at the start of attempt
    `n > 1`, and resets the delta guards' running text. A consumer clears and re-renders; the reconstruction
    equals the recorded decision.
## Consequences

- A streaming planner is expressible inside the scope with no governance bypass.
- `EffectContext` gains one optional field; effects that ignore it are unaffected.
- The terminal chunk's `usage` is advisory (what the provider reported), not a metering record.
- `EffectContext.onDelta` is a sever channel: a middleware delta guard's throw propagates out of it, and an
  effect MUST NOT catch it around the call (`createLlmEffect` does not).
- `@loom/effect-runtime` now depends on `@loom/classify` (types and the taint wrapper; classify has no loom deps).

## Rejected

- A loom-ui-side router re-implementing the call outside the scope (the bypass this closes).
- Journaling deltas, or making them an async iterable return (ST-R: fold economics).
- Replacing the effect's configured sink when a per-call sink is present (surprising to the app's tail).
