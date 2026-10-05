# ADR 0118 — A conditional fence: acquire-if-parked

- Status: **Proposed** (2026-10-05)
- Date: 2026-10-05
- Closes: R8k (the R8 review's residual TOCTOU, named in the `@loom/orchestration` README, "Restart safety (R8)")
- Builds on: K9.4 ([ADR 0021](0021-k9-effect-delivery-contract-idempotency-fencing.md), `acquireFence`),
  [ADR 0117](0117-approvals-bound-to-what-the-approver-saw.md) (`locatePark`, `viewDigest` on a park),
  [ADR 0055](0055-k10-6-pin-seam-content-gc.md) (the retention pin predicate),
  [ADR 0074](0074-storage-scale-out-decorators.md) (a decorator must decide every optional SPI method),
  [ADR 0111](0111-durable-principal.md) (`EXECUTION_STARTED.parent`).
- Placement: **EventStore SPI (optional method) + a `RunOptions` field in workflow-runtime;**
  the retention half is **1P** (`@loom/orchestration`) over the existing pin seam. **EVENT_STORE_SPI
  2.0.0 → 2.1.0** (additive MINOR). KERNEL_ABI and EVENT_SCHEMA are not touched by this ADR.
- Revision: round 2 — D2's retry uses the store-returned current token (the envelope token is stranded by any
  dead acquire) and exhaustion is a retryable `contended`, not `not-suspended`. Round 1 (Opus review of PR #495). The first draft compared the **log head**, premised on "the
  park is by construction the last event". That is false: the runtime appends an unfenced
  `EXECUTION_DENIED` after a park (`recordExecutionDenied`, `WorkflowRuntime.ts` ~664–700, "appends WITHOUT
  a fence"), `recordOutcome` (ADR 0116) and audit events do too, so a head comparison would strand parents
  that merely had a denial recorded, and window 1 would not close. The condition is now the **fence
  token** (D1). **This ADR no longer depends on R3k for the fence half and lands before R2** (ADR 0110's
  notify-resume uses it).

## Context

`EventStore.acquireFence(executionId)` is unconditional: it bumps the execution's fence token and
returns it, and from then on a store that fences rejects any append with a lower token. The child
supervisor (R8) resumes a *parked parent* when its children settle, from any number of nodes. It reads
the park, acquires a fence, appends the resume. Two windows remain that no amount of retrying in 1P
closes:

1. **Between acquire and append** a rival supervisor fences too; the first one's resume fails stale.
   Harmless but noisy (bounded to two acquisitions, then `onError`, retried by `recover()`).
2. **Between the durable resume and the read-back** a rival's `acquireFence` supersedes the holder of
   the *already running* parent body: the legitimate runner's next append is rejected. This is the
   dangerous one: a live execution is fenced out by a supervisor whose resume had already lost.

Both exist because "fence the parent" and "the parent is still parked on the thing I am answering" are
two operations. What is needed is one atomic one.

A separate, smaller gap sits beside it: `LogLifecycle.applyRetention` can archive or delete a **child**
that has finished while its parent is still parked on it, so the parent's later `awaitChild` reads a
missing log. R8 treats a deleted member as a typed failure, which is correct, but retention should not
create that failure.

## Decision

### D1 — `acquireFenceIf`: a conditional acquire on the fence token

An optional `EventStore` method:

```ts
acquireFenceIf?(executionId: string, expect: { fence: number }):
  Promise<{ fence: number } | { stale: true; fence: number }>;
```

Atomically: if the execution's **current fence token** equals `expect.fence`, bump and return the new
token; otherwise return `{ stale: true, fence: <current> }` and change nothing. The token is the right
condition because it is what every legitimate writer's append is checked against (`StaleFenceError`,
`event-runtime/src/fencing`), and it moves **only** when someone acquires, never when an unfenced audit
event is appended. The caller passes the token under which the park it is answering was written: events
carry it as `metadata.fence` (`ExecutionJournal`, `WorkflowRuntime` bootstrap), and `locatePark` already
yields the park envelope. A park written with no fence expects `0` (the token a never-acquired execution
has). In SQL stores it is one statement guarded by the token (`UPDATE … SET fence = fence + 1 WHERE
fence = $n`), in memory a compare-and-set on the `fences` map; the sharded and tenant decorators forward
it. A store without it keeps today's behaviour (the caller falls back to `acquireFence` and the documented
residual), and the conformance kit's case runs only when the method exists (as `copyPrefix` and
`truncatePrefixKeeping` do).

**Why the token and not the head.** Winner and loser both read the same park at fence `F`. The winner's
conditional acquire moves the token to `F+1`; the loser's sees `F+1 ≠ F` → stale, whatever else was
appended to the log in the meantime (an `EXECUTION_DENIED` after the park does not move the token, so the
legitimate resume is not refused for it).

**Residual and its closure.** A park answered through a path that never acquired a fence leaves the token
at `F`, so the token alone would let a second resume pass the conditional. The runtime therefore **re-checks
`assertResumable` under the acquired fence** (the existing check that the newest park is still unanswered,
`not-suspended` otherwise), which is the very check that makes the append safe; the token handles the
race, the re-check handles the legacy path.

### D2 — The runtime uses it on an answering resume

`RunOptions.fenceIfParkedAt?: number` (the park's sequence, as `locatePark` supplies) on `resume` /
`resumeAs`: the runtime reads the park envelope at that sequence, takes its `metadata.fence` (or 0), and
acquires with `acquireFenceIf(id, { fence })` instead of `acquireFence`. On `{ stale, fence: cur }` it
**re-reads the park** (`locatePark`): if the execution is still parked on the **same wait** (the park
is unanswered) the token moved only because someone acquired and never appended (a crashed supervisor,
`TimerService.ts:323` `runtime.acquireFence`, `orchestration.ts:987`; an acquire is never undone, so the
park envelope's `metadata.fence` is **stale forever**), so it retries with `expect: cur` — **the token the
store just returned, not the envelope's**. Window 2 stays closed: a rival whose resume committed leaves
the re-read showing the park **answered** (→ `not-suspended`, nothing appended), and one that is mid-flight
moves the token again, so this attempt's conditional fails `stale` and re-reads. Bounded (3 attempts);
**exhaustion is a distinct retryable outcome, `ResumeContendedError` reason `contended`** (never
`not-suspended`: the park is still unanswered, so reporting "not suspended" would strand the parent), which
R8 `recover()` and the timer backoff treat as "re-drive later". If the park is gone or is a different one
it raises the existing `ResumeRefusedError` reason `not-suspended` and appends nothing. Window 1 becomes a
clean refusal; window 2 disappears. `superviseChildren`,
`TimerService` and ADR 0110's inbox notify-resume (which "fences up front") pass it; the R8 supervisor's
bounded-acquisition loop collapses to one attempt.

### D3 — Retention does not delete a child its parent is parked on

`LogLifecycle` is unchanged. `@loom/orchestration` exports `pinParkedChildren(supervisor)`, a
`PinPredicate` (ADR 0055 D1) for `retention.pinned` that answers `true` for a child id while its parent
is non-terminal and parked on `CHILD_DONE` for it. The child → parent edge comes from the child's own
`EXECUTION_STARTED.parent` (ADR 0111 D1; for logs written before it, from the supervisor's rebuilt state,
so **the pin half works before R3k lands and sharpens after it**), and
the park from the parent's fold via `locatePark`. `defineConfig` composes it automatically when
`superviseChildren` is wired, so an app does not hold the rule in its head. A pinned execution is
"left exactly where it is" (ADR 0055), which is the required behaviour; the predicate reads two
folds per candidate, so it is consulted only for executions that are otherwise retention-eligible.

## Replay and migration

No event or fold change. A runtime on 2.1.0 with an older store falls back to `acquireFence`; an older
runtime ignores the optional method. Mixed fleets are safe in both directions.

## Tests

**Dead acquirer then a legitimate resume (conformance + DST)**: acquire fence on a parked execution and
never append, then resume with `fenceIfParkedAt` — the resume succeeds via the `expect: cur` retry; with
three consecutive dead acquirers racing it surfaces `contended` (retryable), never `not-suspended`, and a
later `recover()` pass completes it.
Conformance case (token matches → new token returned; token moved → `stale`, token unchanged; concurrent
callers → exactly one wins; **an unfenced append after the park (an `EXECUTION_DENIED`) does NOT make the
acquire stale — the negative for the head-based design**); DST: two supervisors race a park with crashes between acquire and append
and between append and read-back, assert the running parent is never fenced out and exactly one
resume is recorded; `fenceIfParkedAt` on an already-answered park → `ResumeRefusedError`
`not-suspended`, log untouched; sharded/tenant decorator forward and the decorator conformance kit lists
the method; retention: a finished child whose parent is parked on it is `"pinned"`, and is
archivable again once the parent is answered or terminal.

## Rejected

- **Fixing it in `@loom/orchestration` with more retries**: the two windows are properties of an
  unconditional acquire, which only the store can make conditional.
- **Comparing the log head** (the first draft): unfenced audit appends follow a park, so the head moves
  without the park being answered.
- **A new LeaseStore-based "park lease"**: a second coordination primitive for a question the log head
  already answers.
- **Teaching `LogLifecycle` about children**: the kernel has no child relation; the pin seam exists
  exactly so policy stays outside it.
