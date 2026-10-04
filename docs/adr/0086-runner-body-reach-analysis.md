# ADR 0086 — Runner-body reach analysis, and two rules that were wrong once they could fire

- Status: **Accepted — implemented** (2026-08-14)
- Date: 2026-08-14
- Builds on: runtime verification ([ADR 0028](0028-runtime-verification.md)), effect classes
  ([ADR 0084](0084-effect-classes-static-ceiling-k2-floor.md)), the step-identity rule
  ([ADR 0061](0061-step-identity-interpreter-guardrails.md))
- **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged.** A build-time analysis, two
  `FlowSpec` fields, and one read-only accessor that is not a syscall.

## Context

Three `@loom/verify` rules — `capability-compat`, `effect-class`, `suspension-safety` — answer a
question of the form *"does everything this flow reaches satisfy X"*. All three defined "reaches"
as the toolIds of the flow's **declared** `FlowDefinition.steps`.

A step invoked through `ctx.run` without being listed there was invisible to all of them, and
`FlowSpec.suspends` had **no producer at all** — suspend points live in the runner body by
construction, so two of `suspension-safety`'s three checks could never fire for any app.

Both holes have the same shape and the same fix: the runner body is a source region, which is
exactly what `analyzeNonDeterminism` already operates on.

## Decisions

### D1 — Analyze the region, and report what you could not resolve

`analyzeRunnerReach(source)` returns `{ steps, unresolved, suspends }`.

`ctx.run(chargeCard, …)` names a binding. A binding declared in the same region as
`step$({ toolId: "…" })` resolves; one imported from another module does not. Matching is on
**shape** — a call whose first argument is an object literal with a string-literal `toolId` —
rather than on the name `step$`, so a project wrapper or a locally curried factory resolves too.

**`unresolved` is the load-bearing half.** An unresolvable target — an import, a minted step
(`mcpInvoke$("hydrate#0")`, whose toolId is runtime data by design), an element access — is
*reported*, not dropped. Dropping it is what would let a partial analysis read as a complete one.

`ctx.sleep`/`sleepUntil` are deliberately not recorded: the kernel authors their condition
(`on: TIMER_FIRED`, `wakeAt` always set), so treating them as user-authored suspend points would
manufacture findings about code the developer never wrote.

### D2 — The bound is a finding, not a footnote

Each of the three rules emits a `warn` naming the unresolved targets. `warn`, not `error`: an
unresolved target is a limit of the *analysis*, not a defect in the *app*, and an app with no
compiler wired must stay usable. `FlowSpec.reachAnalyzed` distinguishes "analyzed and complete"
from "never analyzed", which `unresolvedReach: []` alone cannot — without it, an app that never
wired the compiler would look maximally verified.

This is the `effect-class` unclassified-effects warn, generalized. Silence about a hole in the
reachable set is what turns a green report into an overclaim.

### D3 — Two rules were wrong, and populating them is how we found out

This is the part worth remembering. **A check whose input nothing populates is also a check
nobody can see is wrong.** Both of `suspension-safety`'s dead checks turned out to be defective,
and both would have fired on correct code the moment the input arrived.

**The blanket `correlationKey` error is removed.** It read *"suspend() declares no
correlationKey; a resume event cannot be routed to it"*. But `WorkflowRuntime.resume(executionId,
event)` routes by **executionId**, and nothing in the runtime matches on `correlationKey` at all —
it is metadata for an external dispatcher that knows a business key instead of an execution id.
Every idiomatic `ctx.suspend({ on: "Approved" })` — including the ones in this repo's own tests —
would have become an error. A verifier that errors on the majority of correct code is a verifier
that gets switched off.

**The `wakeAt` check is now conditional on the timer store.** When a `TimerStore` is wired,
`WorkflowRuntime` **derives** `wakeAt` from a suspend's `timeout` at suspend time
(`WorkflowRuntime.ts:1336`). So `suspend({ on, timeout })` is correct there and silently broken
only without one. The rule now reads `VerifyInput.timerStoreWired`, derived in the adapter from
`runtime.hasTimerStore()` — read from the real wiring, never accepted from a caller, the same
discipline as `resumeAuthenticatorWired`.

That leaves `suspension-safety` with two checks, both of which describe real defects.

### D4 — The adapter merges, and never double-counts

`resolveVerifyInput({ runnerReachByFlow })` unions body-resolved steps with declared ones by
toolId. A step both declared and reached yields one effect, not two.

## Consequences

- **The `warn` count goes up for apps that wire the compiler.** That is the intended direction:
  they were previously getting silence about the same gap.
- **`suspension-safety` is live for the first time.** Its `suspends` array had no producer since
  the rule was written.
- **The analysis is opt-in.** Nothing changes for an app that does not pass `runnerReachByFlow`,
  except that `suspension-safety` no longer errors on a missing `correlationKey` — a check that
  could not fire anyway.
- **What it still cannot see.** A `ctx.run` target imported from another module resolves only as
  *unresolved*. Closing that needs cross-module binding resolution, which is a type-checker job,
  not a single-region syntactic one. The warn says so rather than implying otherwise.

## Amendment (2026-10-04, L31) — decider scopes are reach

`ctx.decide(id, (scope) => scope.invokeTransient(toolId, …))` (L30) runs effects the
`ctx.run` walk never sees, so a flow whose effects all ran inside deciders reached nothing
and passed every reach-bounded rule vacuously. No new ADR: this extends D1's analysis and
D2's reporting convention without a new decision, and a new ADR trips four guards for no
added information.

- **Counted.** A literal-toolId `scope.invokeTransient` inside a decider is a reached step
  (`RunnerStepRef.viaDecider`), merged into `FlowSpec.effects` so capability-compat,
  effect-class and `reaches` consistency consume it unchanged.
- **Tracked by binding.** The scope parameter may only be the receiver of a called
  `.invokeTransient`; a destructured `invokeTransient` (renamed or not) may only be called.
  Any other use (passed on, aliased, `scope["invokeTransient"]`, rest pattern), a
  non-literal toolId, and a decider passed by reference whose body is outside the region
  are **unresolved** — reported through the existing `unresolvedReach` path and its `warn`,
  not a new rule id (D2). A same-region named function is followed. Shadowing is matched
  textually, which over-reports.
- **Journaled effects.** The transient seam refuses a `journaled` effect
  (`EffectModeViolationError`). `FlowSpec.deciderEffects` carries each scope-reached tool
  with its mode, read by the adapter from the real registry (`WorkflowRuntime.effectModeOf`,
  a read-only accessor, not a syscall), and `replay-safety` errors on a journaled one. An
  effect not registered at verify time has no mode and is not flagged.
- KERNEL_ABI and EVENT_SCHEMA unchanged.

## Evidence

`tools/compiler/src/runnerReach.test.ts` (12) covers resolution, non-resolution, the generic
`ctx.suspend<T>` form, nesting inside loops/branches/closures, and the deliberate `sleep`
exclusion. `packages/verify/src/verify.test.ts` covers the corrected rules — including the two
tests asserting the *absence* of the removed correlationKey finding and the TimerStore-wired
case — plus the coverage warns.

`packages/app/src/verify.test.ts` drives it through `defineConfig` end to end, and leads with the
**control**: a flow whose ungranted step is invoked via `ctx.run` but not declared reports
`ok: true` without reach analysis, and errors with it. Without that case the rest could be passing
for reasons unrelated to the analysis.
