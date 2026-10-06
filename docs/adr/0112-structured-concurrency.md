# ADR 0112 — Structured concurrency: cancellation scopes, a park barrier, and the cancel cascade

- Status: **Accepted — implemented** (2026-10-06; proposed 2026-10-05, design approved after 4 review rounds). See "Implementation (as built)" for where the code differs from the text above.
- Date: 2026-10-05
- Closes: R6 (agentic-readiness audit, kernel appendix §2d, risk R6) and the R9 cancel-cascade item
- Builds on: [ADR 0105](0105-a-caught-step-failure-is-not-the-executions.md) (`_failedWhileParked`,
  the fold's existing admission that a sibling can write after a park), K8 cancellation (ADR 0020),
  K9.4 fencing, [ADR 0110](0110-durable-inbox-and-receive-select.md) (scope identity keys waits).
- Placement: **kernel** for scopes and the park barrier (`WorkflowContext`, `ExecutionJournal`).
  **1P** (`@loom/orchestration`) for the cascade to child executions: the kernel does not know
  children, and the supervisor can already see its parent's terminal events. Shares the Wave 2 bump.
  The scope id is schema-visible through ADR 0110's `waitId`, and (round 1) the scope's outcome is
  journaled as `PARALLEL_COMPLETED` (D2), an EXISTING reserved kind that gains its first writer and a
  payload; no new kind.
- Revision: **review round 1 of PR #499 (2026-10-06, user decisions Q1-Q3)** amends the frozen `PARALLEL_COMPLETED` shape
  additively, rehydrates the thrown error, gates the scope writer behind `kernel.features.scopes` and seals the journal after
  every park/terminal (see "Review round 1 (as built)"). Earlier: round 1 (Opus review of PR #495): the fail-fast outcome is journaled so replay does not depend
  on timing (D2); a park is not a failure and freezes new step starts (D2/D3); `scopePath` carries the
  ordinal of the `parallel` call (D1). **R6 lands before R2 and R1b** (both need the barrier).

## Context

`ctx.parallel` runs `[step, input][]` through `parallelLimit` and passes it only the *execution's*
signal (`WorkflowContext.parallel`); a comment records the choice not to forward the per-task
abort. `parallelLimit` implements `failFast` with a task-scoped controller, but `run(step, input)`
never receives that signal, so a failing branch cannot cancel its siblings. Measured (`exp3.cjs`):

- a branch that parks (`ctx.suspend`) while a sibling step is running commits `EXECUTION_SUSPENDED`
  and resolves the suspend handle; the sibling's `STEP_COMPLETED` is appended AFTER the park
  (log: `…EXECUTION_SUSPENDED, STEP_COMPLETED`). The fold has a reserved flag for the failure
  flavour of this (`_failedWhileParked`, ADR 0105). The write after a park is only safe because a
  fence rejects a *zombie*; a live holder's own late sibling has no such protection.
- a flow built from `Promise.all([ctx.execute(a), ctx.execute(b)])` has no scope at all.
- `STEP_CANCELLED` has a fold handler and readers (`analytics`) but no writer in the runtime.
- Cancelling a parent does not cancel the children it supervises.

## Decision

### D1 — A cancellation scope per `parallel`, with deterministic identity

`ctx.parallel` creates a child `AbortController` linked to the execution signal. Each branch runs with
a **branch context**: the same `ExecutionContext`, but its steps receive the *scope's* signal (the
execution signal ∧ the scope's), and it carries a `scopePath` — `"<parent path>/<k>.<branch>"`,
`""` at the root, where `k` is the ordinal of this `parallel` call among the `parallel` calls made in the
parent scope and `branch` is the branch index. (Without `k`, two **sequential** `parallel` calls in one
scope would both mint `"0/2"` for their branch 2 and collide in ADR 0110's `waitId`.) The path is a pure
function of the flow's control flow, so it is identical on every re-run; ADR 0110 uses it to key waits.
Branch functions are accepted with a parallel ordinal in the path (design document §7 question 11). `ctx.parallel` accepts, besides `[StepDefinition, input]`
tuples, a branch function `(b: BranchContext) => Promise<T>`, which is what lets arbitrary sub-flows
(not only single steps) be scoped and finishes the "hand-rolled `Promise.all`" gap the audit named.
Options: `{ limit?, failFast?: boolean (default true), onPark?: "drain" | "abort" (default "drain") }`.

### D2 — fail-fast actually cancels, and its outcome is journaled

On the first branch rejection (and `failFast`), the scope aborts. An in-flight step observes it through
its `EffectContext.signal` like any cancellation (K8). A step that is aborted by its scope and unwinds
records `STEP_CANCELLED` (the missing writer), so the frame is `cancelled`, not stuck `running`; the
branch rejects with the scope's reason, and the `parallel` call rethrows the first (by input order) real
error, not the abort noise. A step that completes despite the abort is recorded `STEP_COMPLETED` as
usual: cancellation is cooperative and the log never lies about a step that finished.

**A `SuspendError` is not a failure.** A branch that parks unwinds with the kernel's `SuspendError` /
the quiescence park (ADR 0110); neither counts as the "first real error" for `failFast`, neither aborts
the scope as a failure, and a park never rewrites a sibling's outcome. A park is a barrier (D3), not a
cancellation.

**The scope outcome is a journaled fact (a replay-determinism fix).** `execute()` serves only completed
frames and recorded typed failures on replay (`WorkflowContext.execute`, the completed short-circuit and
the typed-failure substitution); a `STEP_CANCELLED` or an untyped `STEP_FAILED` frame **re-executes**. So
which siblings were cancelled by a fail-fast depended on timing, and a re-run could start a branch the
first run had cancelled, take a different path, or succeed where the first run failed. Now the scope
appends, exactly once and before it rethrows,

```
PARALLEL_COMPLETED { scopePath, failedBranch, error, cancelled: [stepId...] }
```

(an existing reserved kind whose handler was a no-op; it now folds `_scopes[scopePath]`, a small
fold-owned map with one entry per fail-fast scope, ≤ 1 KiB each, and gives the kind its first writer).
The fold records `_scopes[scopePath] = { failedBranch, error, cancelled }` (`cancelled` keeps only string
step ids) and, like every Wave 2 handler, only from a **kernel-stamped** envelope (`metadata.kernel:
true`, stamped by the journal); an unstamped `PARALLEL_COMPLETED` keeps the pre-1.23.0 handler, which
changes nothing but `updatedAt`.
On a re-run, a scope whose path is in `_scopes` is **served from the record**: it rethrows the recorded
error (the typed failure where there was one) and **does not start** any branch listed in `cancelled`;
branches that completed before the failure are served by their frames as today. A scope that completed
without failure writes nothing (the frames are the record), so the common path adds no event.
`PARALLEL_STARTED` stays reserved with no writer (the analytics parallel-window feature may revisit it).

### D3 — The park barrier

A park (a `SuspendError`, or ADR 0110's quiescence) is committed only after every step the
execution has *in flight* has settled. **Once a park is decided, the execution freezes new step starts**:
a branch that is still running flow code cannot begin a new `ctx.execute` between the decision and the
commit (it would re-enter the in-flight set and the drain would never converge); such a call waits for the
park and re-issues on resume, where the step-identity rule makes it idempotent. The journal already serialises writes, and `WorkflowContext`
already knows which steps it started; it keeps an in-flight set. On a park:

1. with `onPark: "drain"` (default) siblings run to completion, and their `STEP_COMPLETED` /
   `STEP_FAILED` events are committed **before** `EXECUTION_SUSPENDED`;
2. with `onPark: "abort"` the scope aborts first, then the same wait;
3. in both cases the wait is bounded by `parkDrainMs` (default 30 s). Past it, remaining siblings
   are aborted and, if they still have not settled, the journal is **sealed**: appends from the
   still-running work are dropped (the step's effect ran, its result is not recorded, it re-runs on
   resume under the same idempotency key, K9). A sealed append is a typed, logged warning, never a
   write after the park.

Result: no event follows `EXECUTION_SUSPENDED` from this execution's own siblings, and
`_failedWhileParked` can only be set by a zombie of a *different* writer (which the fence already
rejects). The flag stays in the fold for old logs.

### D4 — Replay

The one new writer, `PARALLEL_COMPLETED` (D2), adds a fold key `_scopes`, absent in every existing log.
Scopes and the barrier change what is written (siblings' completions land before the park), not how a
log folds. A log written by an older kernel, with a sibling completion after the park, folds exactly
as before (the handlers are unchanged). The reserved `parallelLimit` result ordering is unchanged
(input order). Because completion order inside a scope is not recorded, determinism rests on the
step-identity rule exactly as today; the barrier makes the *recorded* order more regular, not less.

### D5 — The cancel cascade is 1P

The kernel contributes the signal: an effect that starts a child execution (the supervisor's spawn
effect) receives the execution's abort signal and must forward it. In `@loom/orchestration`:

- `superviseChildren` observes its parent's `EXECUTION_CANCELLED` (live `onEvent`, and the R8
  `recover()` sweep for a parent cancelled while no supervisor was up) and cancels every child it
  spawned for that parent that is not terminal, with `reason: { kind: "cascade", parent }`;
- the child list comes from the parent's spawn decisions (already journaled and rebuilt by R8), and
  the child's own `EXECUTION_STARTED.parent` (ADR 0111 D1) lets the sweep find orphans whose parent
  record is gone. That orphan scan is a **full scan of the child side**, so it is not a live property:
  the guarantee is *a scheduled `recover()`* bounds the lifetime of an orphan, and the live path covers
  the common case from the supervisor's rebuilt state;
- the same sweep runs on the parent's `EXECUTION_CONTINUED` (ADR 0109 D5): a non-`detached` child cannot
  outlive the rotation of the execution it was parked on;
- cancelling a child never cancels its parent, and a child may opt out (`detached: true` at spawn)
  for work that must outlive the parent.

This overrides the plan's "kernel cancel cascade" wording: the kernel lacks the child relation, and
putting a lineage table in it would be a new SPI for a policy the supervisor already holds.

## Tests

`exp3.cjs` inverted: no event after `EXECUTION_SUSPENDED` from a sibling; fail-fast cancels a running
sibling (its signal fires, `STEP_CANCELLED` recorded); `onPark: "abort"` vs `"drain"`; `parkDrainMs`
expiry seals the journal and the dropped step re-runs once on resume (idempotency key stable);
scope paths identical across a re-run, and distinct for two sequential `parallel` calls; **fail-fast
replay**: kill and re-run a failed scope with a different timing and assert the same branches are not
started and the same error is rethrown (the negative on `main`: a cancelled branch re-executes); a
`SuspendError` in one branch does not fail the scope; a new `ctx.execute` after the park decision waits
for resume; a branch function with a nested `parallel`; fold equality on
every pre-existing log including one with a post-park completion. DST: crash between a sibling's
completion and the park commit. Cascade: parent cancelled → children cancelled (live and via
`recover()`), a detached child survives, a child's cancel does not reach the parent.

## Rejected

- **Cancelling siblings by default on park**: wastes completed-in-progress work and re-runs
  non-idempotent effects into `EFFECT_INDOUBT`; `"drain"` is the safe default.
- **A kernel `children` table for the cascade**: see D5.
- **Making `Promise.all` scoped**: JavaScript owns that combinator; the answer is the branch function.

## Implementation (as built)

Accepted with R6 (kernel: `WorkflowContext`, `WorkflowRuntime`; 1P: `@loom/orchestration`). The `_scopes` fold key and the
`metadata.kernel` marker (stamped by the journal) are used as reserved; the `PARALLEL_COMPLETED` payload was extended
additively by the review round below. What the code does, and where it differs from the text above:

- **Identity.** A `parallel` call is `"<parent path>/<k>"` (the root path is `""`, so the first call is `"/0"`); its
  branches are `"<parent path>/<k>.<i>"`. `PARALLEL_COMPLETED.scopePath` is the CALL's path, `failedBranch` the index of the
  error that is rethrown. `k` counts `parallel` calls per scope node, so sequential calls cannot collide and a nested call
  inside branch `/0.1` is `"/0.1/0"`. A branch function receives a `BranchContext` (the execution context with the
  branch's scope bound in, plus `scopePath`); `ctx.parallel` still accepts `[step, input]` pairs.
- **Step ids are unchanged.** No step id derivation changed (a scope path never enters a step id), so a mixed fleet derives the
  same ids for every step; the design's rollout question is answered "byte-identical". (Superseded by the review round: the
  scope writer IS behind `kernel.features.scopes`, default off, because a mixed fleet where one node failed fast and an
  older one re-runs the scope live is a divergence, not "never worse".) The `STEP_CANCELLED` writer already existed for an execution
  cancel; it now also fires when the scope's (or the park-drain's) signal aborts a step.
- **Fail-fast.** The first REAL branch failure (not a `SuspendError`, not cancellation noise, and not while the execution
  itself is being cancelled) aborts the scope. The call waits for its branches to settle (work that ignores the signal gets
  `min(parkDrainMs, 1000)` ms of grace), appends `PARALLEL_COMPLETED` once, and rethrows the first real error by input order.
  Queued branches (with `limit`) never start. `failFast: false` runs every branch and journals nothing. An inner scope that
  is aborted by an OUTER scope's failure records nothing of its own; the outer record's `cancelled` includes the inner step
  ids. `error` is `String(err)` capped at 512 chars and `cancelled` at 32 ids, so a record stays about 1 KiB.
- **Served scope (stronger than "does not start cancelled branches").** A scope found in `_scopes` runs its branches in
  SERVED-ONLY mode: a step already completed (or with a recorded typed failure) is served from its frame, and every other
  step throws before `STEP_STARTED`, so nothing is started, whatever the first run's timing. The recorded failure is rethrown:
  as the `TypedFailure` when the failed branch's frame holds one, else a `ParallelScopeFailedError` whose `message` is the
  original error's message (the class name is not preserved: the record carries the text, not the class).
- **Park barrier.** `SuspendError` is never a failure. A branch's park marks its scope chain parked (no sibling branch and no
  queued branch starts new work; a step start in a parked scope, or after the runner decided the park, returns a promise that
  does not settle: the resume re-runs the flow, and the step-identity rule re-issues it). The park itself is committed by the
  runner only after every step and decider in flight in the execution has settled (`WorkflowContext.parkBarrier`), bounded by
  `parkDrainMs` (`WorkflowRuntimeDeps.parkDrainMs`, default 30 000; NOT yet in `defineConfig`). With `onPark: "abort"` the
  scope aborts first. Past the bound the stragglers are aborted (the context's park signal is part of every step's signal),
  given `min(parkDrainMs, 1000)` ms, and then the journal is SEALED for that context: a later append from the flow side is
  dropped with one `onWarn`, never written. A seal exists only in that case; a zombie that is not in flight (a step whose
  deadline already raced it) still appends as before. A hand-rolled `Promise.all([ctx.run(...), ctx.suspend(...)])` is drained
  too (the in-flight set is per execution, not per scope). Cancelled while draining: `EXECUTION_CANCELLED` wins, no park is
  written.
- **`_failedWhileParked`** can no longer be produced by this kernel's own siblings; the fold keeps the flag for older logs
  (the ADR 0105 tests that produced it live now append the late `STEP_FAILED` by hand).
- **Cascade (`@loom/orchestration`).** `awaitChild` / `awaitChildren` accept `detached` (per member for a group), recorded in the
  spawn decision. `superviseChildren.onEvent`, on a parent's `EXECUTION_CANCELLED` (or kernel-stamped `EXECUTION_CONTINUED`),
  cancels every non-detached child named by the parent's recorded spawn decisions (read from its log) and by the supervisor's
  in-memory view, through `runtime.cancel(child, JSON.stringify({ kind: "cascade", parent }), systemOptions())` (the recorded
  reason is a string: the kernel records `String(reason)`). A child never started is skipped; cancelling a child cancels its
  own children the same way and never its parent. `recover()` additionally cancels any live execution whose RECORDED parent
  (`_parent`, written only through the lineage grant, so a pre-R3k child without one is not swept) folds `cancelled` or
  `continued` and whose spawn was not detached; `RecoverSummary.cascaded` counts them. The sweep is a scan of the child side:
  the guarantee is that a scheduled `recover()` bounds an orphan's lifetime.
- **Not done here (named).** `parkDrainMs` in `defineConfig`; DST over every interleaving (the tests vary timing
  explicitly instead); R2's `waitId` consumes `scopePath` in its own PR; `PARALLEL_STARTED` and `STEP_RETRYING` stay reserved.

## Review round 1 (as built)

Review of PR #499 (an Opus adversarial review) found three P1s, three P2s and a P3. The user decided the three design
questions on 2026-10-06; this is what was built.

- **Q1 — the frozen shape is AMENDED, additively (P1-A, P1-B).** *Frozen shape amended by user decision 2026-10-06 (R6 P1-A/B).*
  A served scope launched every branch (a `limit` leaves branches the first run never started, whose live
  `decide`/`suspend`/`emit` then ran) and took gate answers by position (a served branch whose first-run gate never opened
  consumed the answer of a LATER gate, which then re-parked). `PARALLEL_COMPLETED` / `_scopes[scopePath]` gains optional
  `launched` (the count: branches launch in input order, so `0..launched-1`), `consumed` (`[branchScopePath, startIdx, count][]` runs of contiguous answer indices,
  descendants included, within a 16 KiB serialized budget; past it the field is omitted and a warning says so — nest `parallel`
  per chunk for very large scopes; round 2 replaced the unreleased `[path, index]` pair form, so the fold reads runs only) and `cursor` (the gate-answer cursor
  after the scope). A served scope launches exactly `launched` branches; a served branch takes exactly the answers `consumed`
  lists for its path (none listed: `ScopeServedError`, nothing consumed) and the cursor is set to `cursor` at the end, so the
  gate after the scope receives the answer it received on the first run. A suspend or sleep inside an ABORTED scope throws the
  scope's noise without consuming. A record without the fields (written before this amendment) serves as before. EVENT_SCHEMA
  stays 1.23.0 (unreleased; an additive payload field needs no bump, and an older fold ignores it); the wire-abi vectors,
  the fold handler, the `_scopes` shape and the design document's "Frozen at W2-0" table carry the amendment.
- **Q2 — one thrown value (P1-C).** The scope records the failing error's `errorName` (and, for a `TypedFailure`, its
  `errorChannel` and a JSON-bounded `errorPayload`) beside `error` (`"Name: message"`, the double `TypedFailure:` prefix is
  gone). BOTH the first run and every served re-run throw the value built from that record: a `TypedFailure` stays typed; a
  class named in the registry (`WorkflowRuntimeDeps.errorClasses` / `defineConfig({ execution: { errorClasses } })`, plus the
  built-in `Error`/`TypeError`/`RangeError`/`ReferenceError`/`SyntaxError`/`EvalError`/`URIError`) is rebuilt
  `new ctor(message)` (no `cause`; a constructor that throws or returns a non-`Error` falls back); anything else is
  `ParallelScopeFailedError(message, scopePath, failedBranch, errorName)`. Consequence, documented: the first run no longer
  throws the ORIGINAL object (its `cause` and extra fields are gone), and inside a branch, user code that catches a step's
  error sees the effect's error on the first run but `ScopeServedError` on a replay, so it must rethrow or use typed failures.
  `failFast: false` and an execution cancel record nothing and throw the original error as before.
- **Q3 — `kernel.features.scopes` (P2-B).** Default OFF, like `redrive`. Off, `ctx.parallel` is the pre-R6 bounded
  `Promise.all` (`parallelLimit` over the execution's signal): no scope abort, no `STEP_CANCELLED` for a sibling, no
  `PARALLEL_COMPLETED`, no consultation of a record found in the log, no park-drain abort. The park barrier (ordering) and the
  seal below are always on: they write no new kind and make the log more regular, not less. Wired
  `defineConfig.kernel.features.scopes` -> `WorkflowRuntimeDeps.scopes`.
- **P2-A — nothing follows the park or the terminal.** The context is SEALED the instant `EXECUTION_SUSPENDED`,
  `EXECUTION_COMPLETED` or `EXECUTION_FAILED` is enqueued (previously only after a drain timeout), so user code that runs after
  a branch settled (an `emit`, a `decide`) cannot append behind it, and an abandoned task cannot append after the terminal.
  `decide` gained the frozen/parked guard (it waits for the resume, like a step start), throws `ScopeServedError` in a served
  scope when the decision is not already recorded, and throws the scope's noise in an aborted one. Tightening of ADR 0102's
  note on a zombie effect's late emit: it is now DROPPED with a warning instead of appended after the park; the timed-out step
  re-executes on the resume, which emits it again.
- **P2-C — a branch that closes over the ROOT `ctx`.** Each branch runs inside an `AsyncLocalStorage` bound to its scope, and
  every root-`ctx` call (`run`, `execute`, `decide`, `parallel`, `suspend`, `sleep`) resolves to the scope of the CALLING async
  context: the abort cancels it, and the `parallel` calls it makes are numbered per scope, not by timing. (`node:async_hooks`
  is available: the package already imports `node:crypto`.) Only calls made inside a branch's async context are bound: work
  detached from it by a non-async-context-propagating mechanism is not.
- **P3.** `recover()` reads a gone parent's log once per pass (a bounded cache), not once per orphan. First `recover()` after
  upgrading to this version cancels the live children of parents that were cancelled or continued before it (the sweep is new).

## Review round 2 (as built)

- **`consumed` is run-length encoded** (`[branchScopePath, startIdx, count]`, 16 KiB budget instead of a 128-entry cap), so a
  big scope with contiguous answers per branch stays exact. Overflow keeps the old behaviour: field omitted, `onWarn`, and a
  re-run takes answers by position. The pair form never shipped (EVENT_SCHEMA 1.23.0 is unreleased), so the fold, the
  wire-abi vectors and this ADR were updated in place.
- **First-run `cause`.** The first run throws the error rebuilt from the record with `cause` = the original (and `onWarn`
  logs the original's stack). A served re-run has no original: `cause` is absent. The record is unchanged, so determinism
  holds; never branch control flow on `cause`.
- **Rolling upgrade.** The always-on journal seal drops late appends after `EXECUTION_SUSPENDED` / terminal /
  `EXECUTION_CANCELLED` that an old node would have written. Those were never fold-relevant, are regenerated on re-run, and
  dropping them is strictly safer.
- **Cancel seals the context** too: a zombie cannot append after `EXECUTION_CANCELLED` (only the `STEP_CANCELLED` of steps the abort interrupts still lands).
