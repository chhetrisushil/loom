# ADR 0021 — K9: effect delivery contract — idempotency & fencing

- Status: Accepted (implemented 2026-07-10 — K9.1 contract, K9.2 `idempotencyKey`,
  K9.3 `idempotent` declaration + `EFFECT_INDOUBT` parking/resolution, K9.5 `crashingEventStore`
  harness (event schema 1.3.0); K9.4 fencing tokens — `EventStore.acquireFence` +
  fence-guarded append (in-memory + Postgres; SQLite exempt), `WorkerLease.fence`,
  `RunOptions.fence`. Amendments below applied.)
- Date: 2026-07-10
- Requirements: [K9 in the kernel-hardening requirements](../requirements/2026-07-10-kernel-hardening-k7-k12-t1-t2.md#k9--effect-delivery-contract-idempotency--fencing) — priority **P0**

## Context

If a worker crashes *after* performing a side effect but *before* `STEP_COMPLETED` is
appended, recovery ([ADR 0004](0004-failure-recovery.md)) re-executes the effect. Effects
are therefore **at-least-once**, but the contract is undocumented and unsupported by any
kernel machinery. For mutating infrastructure operations this is the single most dangerous
ambiguity in the system — the reason K9 is sequenced first (P0): cheapest to specify, most
dangerous to leave ambiguous, and it blocks safe *mutating* autonomy.

## Decision

Make the delivery contract explicit and give tool authors and the recovery path the
machinery to honor it:

- Document the contract: *effects are at-least-once; steps are exactly-once only with
  respect to the log* (K9.1).
- The kernel supplies each effect invocation a deterministic **idempotency key** —
  **`executionId:stepId`**, with *no attempt component* (K9.2 as amended; the requirement's
  attempt-suffixed key is unimplementable — see Amendments) — via `EffectContext`, so tool
  authors can deduplicate at the provider. A new key is minted only by an explicit durable
  new-logical-attempt fact.
- Tools declare a semantic: `tool$({ idempotent: true | false })`. Recovery refuses to
  automatically re-run a non-idempotent mutating effect whose prior attempt is in an unknown
  state; instead it suspends the execution with a durable **`EFFECT_INDOUBT`** fact for
  operator resolution — safe-by-default (K9.3).
- Worker leases carry a monotonic **fencing token**; the journal rejects appends bearing a
  stale token, so a network-partitioned "zombie" worker cannot write after its execution was
  re-dispatched — extending the D3 single-writer invariant to the failure domain (K9.4).
- `@loom/testing` provides a crash-injection harness (kill between effect completion and
  event append) so applications can prove their tools' idempotency in CI (K9.5).

## Acceptance criteria

Under injected crashes, an idempotent tool converges to one logical mutation; a
non-idempotent tool never silently re-runs — the execution parks at `EFFECT_INDOUBT`; a
fenced zombie's append is rejected and logged.

## Consequences

- Mutating autonomy becomes safe-by-default: the dangerous case (unknown prior attempt of a
  non-idempotent effect) parks for a human instead of silently re-running.
- New durable fact `EFFECT_INDOUBT` enters the K5-governed schema (additive → MINOR); the
  fold reference must be updated.
- The journal append path grows fencing-token validation; the dispatch/lease seam must mint
  and thread tokens. Unwired (no `idempotent` declaration, single-node), behavior is
  byte-identical (G2).
- T1's idempotent cron-start semantics ([ADR 0025](0025-t1-durable-timers-and-scheduled-executions.md))
  reuse K9's *concept* (deterministic dedup keys), and K8 cancellation
  ([ADR 0020](0020-k8-cancellation-deadlines-bounded-effects.md)) produces exactly the
  in-doubt states K9 resolves — these three land as a unit of meaning.

## Amendments (code-grounded evaluation, 2026-07-10)

Adopted per the [K9 evaluation](../requirements/2026-07-10-kernel-hardening-evaluation.md#k9--effect-delivery-contract-idempotency--fencing--accept-with-amendments)
(verdict: **Accept with amendments**):

- **A1 — the key** (applied inline above): the folded `attempts` counter increments on
  *every* `STEP_STARTED` (`eventHandlers.ts:38`), including crash-recovery re-execution — so
  an attempt-suffixed key would change in precisely the crash case idempotency exists for.
  The key is `executionId:stepId`; in-memory middleware retries naturally share it
  (`ctx.attempt` is fixed for one `EffectRuntime.execute` call), which is the desired
  provider-dedup behavior; a fresh key requires an explicit durable new-logical-attempt fact
  (a produced `STEP_RETRYING`, or an in-doubt "retry-fresh" verdict).
- **A2 — the G2 default**: tools with **no** `idempotent` declaration keep today's recovery
  behavior (automatic re-run); `EFFECT_INDOUBT` parking applies only to explicit
  `idempotent: false`. The requirement's undifferentiated safe-by-default would park every
  existing app's crash recovery — a G2 violation. Forgotten-flag mitigation: `loom deploy
  check` advisory listing tool-kind effects with no declaration.
- **A3 — un-parking**: park = `EFFECT_INDOUBT` + `EXECUTION_SUSPENDED { reason:
  "effect-indoubt" }`; resolution is a standard `resume()` with a verdict payload
  (`completed-with-result` / `retry-fresh` / `fail`) — no new resume machinery. Parking on
  `STEP_STARTED`-without-completion includes crash-*before*-effect-ran (conservative,
  correct, documented); no pre-effect durable marker (extra append per effect = hot-path
  cost, negative ROI).
- **A4 — fencing enforcement point**: the fence is checked where writes converge — the
  **store append** (`append(envelope, { fence })` rejects stale tokens), following the
  optional-SPI precedent (`readRange?`/`copyPrefix?`). Postgres `UNIQUE(execution_id,
  sequence)` remains the same-sequence backstop; single-node SQLite is exempt (zero
  overhead, G2).
- **A5 — contract completeness**: the K9.1 documentation also states that *metered facts
  are at-least-once under recovery* — budgets may over-count after crashes (conservative
  direction; never under-counts).

## Amendment (2026-10-15) — A3: STEP_STARTED is the pre-effect marker

A3 rejected an EXTRA append per effect, and that still holds: no new event is added. The existing
`STEP_STARTED` is the pre-effect marker the in-doubt guard reads on recovery, but the journal is write-behind
(fold now, append later), so the effect could run before its `STEP_STARTED` was durable; a crash
in that gap left no "running" frame and the non-idempotent effect was silently re-run. Now
`executeLive` awaits the journal's durable tail after committing `STEP_STARTED` and before the
dispatch gate and effect dispatch, **only** when the tool is declared `idempotent: false`. Cost:
one awaited store round trip on those steps (a terminal-SEALED context never dispatches, so
if it was sealed during that await the call never starts; a park decided during the await does
not block it: the draining step counts as in flight, so the park barrier waits for it and it runs
to completion, journaling its result before `EXECUTION_SUSPENDED`, like any in-flight step). Undeclared (A2) and `idempotent: true` tools keep the
write-behind hot path unchanged. A refused write (stale fence, storage error) throws before
dispatch: the effect never runs and the run fails as any storage failure. When a non-terminal seal (a sealed-inbox refusal, a park-barrier give-up, a divergence) lands during the drain, the effect never starts but `STEP_STARTED` is already durable, so the frame stays running and a later recovery parks it `EFFECT_INDOUBT` (conservative; the operator's `retry-fresh` resolves it). A CANCEL seal instead settles the call (the abort throws), so the live handle and lease are released promptly rather than held for `parkDrainMs`. Replay never drains.
