# ADR 0020 — K8: cancellation, deadlines & bounded effects

- Status: Accepted (implemented 2026-07-10 — K8.1 provider signal forwarding + pre-flight
  abort check, K8.2 `ExecutionRuntime.cancel(executionId)` with fence-then-cancel for
  detached executions and resume-refusal of cancelled ones, K8.3 step `timeoutMs`
  enforcement anchored to `frame.firstStartedAt` + execution `deadlineMs` (flow$/RunOptions)
  anchored to the logged `EXECUTION_STARTED`, metering-on-abort (A2), retry×abort (A3),
  K8.5 cross-seam propagation (`WorkerRuntime.cancel?` SPI, worker-server `POST /cancel`,
  `RemoteWorkerRuntime.cancel`, dispatcher forwarding — best-effort delivery, durable-fact
  settlement). **K8.4 landed 2026-08-18** — see A8; the original "no streaming effects exist"
  condition was met by ADR 0087's series and the enforcement now ships. Amendments
  below applied.)
- Date: 2026-07-10
- Requirements: [K8 in the kernel-hardening requirements](../requirements/2026-07-10-kernel-hardening-k7-k12-t1-t2.md#k8--cancellation-deadlines--bounded-effects) — priority **P0**

## Context

Every existing enforcement point is admission control: the scheduler gates *entry*, K3
budgets deny the *next* effect, K4 circuit-breaks a *target* for future dispatches.
**Correction to the requirement's premise** (code-grounded evaluation): a local kill path
partially exists — `ExecutionHandle.cancel(reason)` emits `EXECUTION_CANCELLED`
(`WorkflowRuntime.ts:464-472`), `STEP_CANCELLED` is emitted when the abort signal trips, and
`EffectContext` already carries `signal?: AbortSignal`. What is actually missing: built-in
effects do not forward the signal to providers (provider interfaces accept none),
cancellation is not addressable by `executionId` across processes, declared deadlines
(`step$` already has a `timeoutMs` field) are not enforced, budgets have no mid-flight hook,
and cancellation does not propagate across the dispatch seam. A kernel must be able to
reclaim a running process wherever it runs; autonomy without a complete kill path is not
deployable.

## Decision

Give the kernel a real kill path, end to end:

- Every effect invocation carries an `AbortSignal` (or equivalent) through `EffectContext`;
  the built-in effects (`LlmEffect`, `ToolEffect`, `A2AEffect`) honor it (K8.1).
- `ExecutionRuntime.cancel(executionId, reason)` aborts the in-flight effect, appends a
  durable `EXECUTION_CANCELLED` fact, and transitions the PCB to a terminal `cancelled`
  status; replay of a cancelled run reconstructs the cancellation at the same sequence,
  preserving G1 (K8.2).
- Declarative deadlines (`ExecutionPolicy.deadlineMs`, per-step `timeoutMs`) are enforced
  *by the kernel* via the same abort/cancel machinery, not by convention in userland (K8.3).
- K3 gains a mid-flight enforcement hook: a streaming LLM effect that crosses its token
  budget is aborted mid-stream with a `QUOTA_EXCEEDED` fact, not merely denied its successor
  (K8.4).
- Cancellation propagates across the dispatch seam: cancelling on the orchestrator cancels
  the effect on a remote `WorkerRuntime` — best-effort delivery, durable-fact settlement
  (K8.5).

## Acceptance criteria

A test effect that sleeps 10 min is cancelled in <1 s locally and across an HTTP worker; the
log shows `EXECUTION_CANCELLED`; replay reproduces the cancelled state bit-for-bit; an
over-budget streaming call is severed mid-stream with a `QUOTA_EXCEEDED` fact.

## Consequences

- The kernel can reclaim running work — the prerequisite for deploying autonomous executions
  at all, and a prerequisite for K3's mid-flight budget enforcement.
- `EffectContext` grows an abort surface; existing effects must be audited for signal
  handling. Unwired (no cancel called, no deadline set), behavior is byte-identical (G2).
- Sequenced **P0** together with K9 ([ADR 0021](0021-k9-effect-delivery-contract-idempotency-fencing.md)):
  cancellation creates exactly the "effect in unknown state" cases K9's in-doubt semantics
  resolve.

## Amendments (code-grounded evaluation, 2026-07-10)

Adopted per the [K8 evaluation](../requirements/2026-07-10-kernel-hardening-evaluation.md#k8--cancellation-deadlines--bounded-effects--accept-with-amendments)
(verdict: **Accept with amendments**):

- **A1 — scope corrected** (applied in Context above): K8 *completes* an existing seam —
  provider signal forwarding (additive optional `{ signal }` argument), cross-process
  `cancel(executionId)`, kernel-enforced deadlines, mid-flight budget, cross-seam
  propagation.
- **A2 — metering on abort (closes a K3 loophole)**: metering emits after `next()`, so an
  aborted effect is never metered — start-expensive-call → cancel → repeat evades budgets
  forever. On abort/deadline the kernel meters partial or estimated cost (at minimum
  wall-time) before rethrowing.
- **A3 — retry × abort**: the retry middleware treats abort as terminally non-retryable and
  checks `signal.aborted` before re-attempts and during backoff — else an app-configured
  `isRetryable` makes cancel a no-op.
- **A4 — deadline base time**: remaining time after recovery is computed from the *logged*
  `STEP_STARTED` timestamp, never wall clock at re-run (else every crash resets the
  deadline). *(Amended L26: the remaining time is measured with the runtime's own clock, the
  injectable `now` that stamped the anchor, not raw `Date.now()`. Mixing the two made any
  non-wall clock fail every `timeoutMs` step and cancel every `deadlineMs` execution at once,
  or arm a clamped 1ms timer. The `setTimeout` still waits real milliseconds, so `now` must
  advance in real time for a deadline to fire on time. Caveats: a FIXED clock silently
  disables A4 (elapsed is always 0, so every crash or resume re-grants the full budget); an
  OFFSET is safe only if every runtime touching the log uses the same offset, else a recovering
  node eats into the budget or steps the clock backwards. The remaining time is capped at the
  declared budget, and waits above 2^31-1 ms are armed in chunks, since Node clamps a longer
  `setTimeout` to 1ms. Under a FIXED clock a budget above 2^31-1 ms never fires within a single
  run (elapsed stays 0, so each chunk re-arms). The re-arm timers are deliberately NOT
  `unref`'d: a deadline is not a background task, and the timer of a hung step keeps the
  process alive for up to the budget, as it always did. `timeoutMs`/`deadlineMs` must be
  finite numbers > 0: NaN, 0, negatives and Infinity are rejected at `step$`/`flow$` and again
  at `registerFlow`/`start`/`ctx.run`; omit the field for no deadline.)*
  *(Amended L27: the same holds for timer wake times. `ctx.sleep`/`suspend({timeout})`
  compute `wakeAt` with the runtime's `now`, and `TimerService` defaults its `now` to
  `runtime.clock`, so an offset or simulated clock given to the runtime alone wakes timers
  correctly. An explicit `TimerService` `now` that disagrees with the runtime's fires timers
  early (ahead) or never (behind). Caveat (3): under a FIXED clock, sleeps,
  `suspend({timeout})` and cron schedules never fire (`wakeAt = FIXED + ms` is judged at FIXED;
  they used to fire on wall time, including via `defineConfig`): advance the clock or drive
  `tick(now)` yourself. The OFFSET caveat covers wake times and cron too and applies across an
  upgrade: timers parked before it carry wall-clock `wakeAt`, so an offset runtime fires them
  |offset| early or late (never under a fixed clock), and old (wall) and new (offset) nodes
  disagree during a rolling upgrade; the default wall clock is unaffected. `sleepUntil(absolute)`
  targets and cron occurrences are measured on the runtime clock, not wall time. Lease expiry is
  judged by the lease store on the clock that stamped it (L28, LeaseStore SPI 2.0.0).)*
- **A5 — K8.4 is conditional**: no streaming effects exist today; mid-stream budget
  enforcement binds when they land and cannot be middleware (middleware can't observe
  stream progress) — it needs a usage-reporter hook on `EffectContext` or the provider
  stream adapter. *(Superseded by A8 — the condition was met and the second half of this
  sentence turned out to be half right: not middleware, but not an `EffectContext` hook
  either.)*
- **A6 — ordering**: K8.5 lands after K9.4 — fence the lease, *then* append
  `EXECUTION_CANCELLED`, or a zombie's late `STEP_COMPLETED` races the cancel fact.
- **A7 — settlement truth**: provider forwarding is best-effort; the kernel guarantee is
  durable-fact settlement. The "<1 s" acceptance criterion binds for built-in effects, not
  arbitrary third-party providers that ignore the signal.
- **A8 — K8.4, implemented 2026-08-18.** The condition ("no streaming effects exist") was met
  by the agent-runtime series: `createLlmEffect({ stream: true })` consumes `provider.stream`
  internally ([ADR 0087](0087-durable-agent-loop.md) and the R8/R9 items of
  [the evaluation](../requirements/2026-08-18-agent-runtime-placement-evaluation.md)).

  A5 was right that this cannot be middleware, and wrong about the alternative. An
  `EffectContext` usage-reporter hook was designed and then **dropped**: both wired providers
  report usage exactly ONCE, at the end (Anthropic in `message_delta` before `message_stop`,
  OpenAI in a trailing usage-only chunk), so such a hook could only ever fire where metering
  middleware already reads the number. A hook that cannot fire mid-flight is not a mid-flight
  mechanism.

  What ships instead observes the only thing a stream *does* report continuously — its own
  output. `streamTokenBudget(budget)` (`@loom/middleware`) builds a guard that
  `collectStream` calls after every delta; it ESTIMATES output tokens from the text so far,
  adds what `ctx.resources` says the execution already spent, and on breach emits
  `QUOTA_EXCEEDED` and throws `QuotaExceededError` — severing the HTTP call through the same
  abort path K8.1 established.

  **The estimate is named as an estimate**, in the type, in the `QUOTA_EXCEEDED` reason, and
  in the default (`chars / 4`, swappable for a real tokenizer). That is the honest shape: a
  budget guard that severs at roughly the right point is worth far more than exact accounting
  that arrives after the money is spent, but it must not be reported as exact. Final metering
  is unchanged and still uses the provider's reported usage.

  Consequence worth stating: enforcement is only as fine-grained as the delta rate, and a
  provider that streams one enormous chunk gets one check. The floor is unchanged from before
  K8.4 (admission control still denies the successor), so this strictly improves on it.

  One thing the implementation found, worth recording because it is the kind of
  confusion that survives review: a guard that severs typically aborts the execution
  too, so by the time the stream's catch runs, `signal.aborted` is already true — and
  the budget error was being rewritten into an "interrupted" typed failure, losing the
  reason. A caller has to be able to tell *a human stopped this* from *this cost too
  much*. The guard's own error is now remembered and rethrown untouched.