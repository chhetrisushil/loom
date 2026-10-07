# ADR 0116 — Attaching an outcome to a past decision of a finished execution

- Status: **Accepted — implemented** (2026-10-07) — design approved after 4 review rounds; see "Implementation notes" for what the code does beyond the text
- Date: 2026-10-05
- Closes: R11 (agentic-readiness audit, kernel appendix §2i)
- Builds on: [ADR 0030](0030-decision-materialization.md), [ADR 0078](0078-exploration-in-the-routing-seam.md)–[0080](0080-learning-substrate.md)
  (decisions carry `policy.propensity`; `@loom/learning` evaluates off-policy),
  C.1 execution authz, K9.4 fencing.
- Placement: **a small runtime method, not a syscall and not a store.** No ABI change; no new event
  kind. The one schema-visible part is two additive optional payload fields on the existing
  `OUTCOME_RECORDED`, inside the shared Wave 2 EVENT_SCHEMA 1.23.0.
- Revision: round 1 (Opus review of PR #495). `recordOutcome` is **terminal-only and takes no fence** (a
  fence would kill a live run); retention is measured from the **terminal event**, not the last event (the
  first draft's claim that a late outcome "does not refresh retention" was false); and
  `guardUserspaceEmit` refuses `recordedBy` / `late`, which were forgeable by any `ctx.emit` caller.

## Context

Rewards arrive late: a user's thumbs-up days after the conversation, a business KPI at month end.
`OUTCOME_RECORDED { key, success, score, decisionId }` links a reward to a decision, but the only
writers are `ctx.emit` and `EffectContext.emit` of a **live** run (`analytics`' `OutcomeSink` is
`{ emit }`); `resume` refuses a non-suspended execution, and a terminal one is reopenable only via
`resumeAs`, a code-migration verb. So a reward has no first-class home, and learning needs rewards:
off-policy evaluation of a policy trained on propensity-logged decisions is useless if the reward never
joins.

## Decision — evaluated, and the answer is mostly "not 1P"

Two 1P options exist, and each fails on something the kernel alone holds.

1. **A side table keyed `(executionId, decisionId)`.** It is a new durable store: a new SPI, a
   conformance kit, and three backends (SQLite, Postgres, in-memory), plus a join in every consumer of
   outcomes (`trajectories`, analytics, read models) because `fold(log)` no longer contains the reward.
   That is far more surface than an append, and it forks the truth about a trajectory in two.
2. **A 1P function that appends to the terminal log through `EventStore`.** It works mechanically
   (the `OUTCOME_RECORDED` handler is already pure audit and status-neutral) but it bypasses
   everything the runtime owns: `ExecutionAuthorizer` (who may attach rewards: a reward steers
   policy learning, so an unauthenticated writer is a poisoning channel), fencing, tenant scoping and
   the denial audit trail. It would be a 1P package holding a security boundary it cannot enforce.

So the verdict is a **single runtime method**:

```ts
runtime.recordOutcome(executionId, {
  decisionId, key, success?, score?, idempotencyKey?
}, options?: { principal?, system? }): Promise<{ appended: boolean }>
```

It is not an `ExecutionContext` member (no ABI), it is not a state change, and it adds no event kind.

### D1 — Semantics

- Authorized as a new `ExecutionOp` `"annotate"` (an additive union member; `executionAccessPolicy` maps
  it with the default rule `"tenant"`; the conformance kit gains the op), judged against the recorded
  owner (ADR 0111 D5). Under `security.strict` a call without a principal is refused.
- **Terminal executions only** (`completed`, `failed`, `cancelled`, and ADR 0109's `continued`: the
  decision lives in that generation's log). A running or parked execution is refused with a typed
  `ExecutionNotTerminalError`: a live run uses `ctx.emit` (an `OutcomeSink`), which is the existing path.
  The first draft allowed all states and **acquired the fence first**, and `acquireFence` supersedes the
  current holder, so a reward arriving for a live run would have killed it. Not acquiring the fence is safe
  because a terminal execution has no live holder.
- **Append with a sequence compare-and-set, no fence.** The runtime reads the head, folds, validates and
  appends at `head + 1` (the store's `DuplicateSequenceError` is the CAS); on a collision (a concurrent
  `recordOutcome`, or the best-effort unfenced `EXECUTION_DENIED` audit append the runtime itself makes) it
  re-reads and retries a bounded number of times, so two identical concurrent calls resolve to one append
  and one `{ appended: false }`. Nothing a fenced writer owns is disturbed.
- The `decisionId` must exist in the fold's `_decisions` (an outcome for a decision that never happened
  is refused: reward poisoning by invented ids). `(decisionId, key)` is idempotent: a second identical
  call returns `{ appended: false }`; a different `score` for the same pair is refused, not overwritten
  (the log is append-only; a correction is a new `key`).
- The event is the existing `OUTCOME_RECORDED`, with two additive optional fields, `recordedBy` (the
  caller's actor, or `"system"`) and `late: true`. **They are forgeable unless the guard says otherwise**:
  `OUTCOME_RECORDED` is in `USERSPACE_KERNEL_EVENTS` (`userspaceEmit.ts`), so any flow's `ctx.emit` could
  stamp `recordedBy: "someone-else"` or `late: true` and a learning pipeline that trusts them would be
  fooled. `guardUserspaceEmit` therefore **refuses an `OUTCOME_RECORDED` carrying `recordedBy` or `late`**
  from userspace; only `recordOutcome` writes them (it appends through the runtime's own path, which does
  not pass the guard). The fold keeps appending to `_outcomes`; as of W2-0 (EVENT_SCHEMA 1.23.0) the handler copies the two
  fields onto the entry (`recordedBy` when a string, `late` when `true`) — only from an envelope with
  `metadata.kernel === true`, which the `recordOutcome` writer stamps, so a log the guard did not
  protect cannot make a pipeline trust a forged field.
- It does not change status and does not touch `_failedWhileParked`. **Retention is measured from the
  terminal event.** `LogLifecycle` today computes the end of an execution as
  `max(lastEvent.timestamp, state.updatedAt)` (`LogLifecycle.ts:320`), so a late outcome appended days after
  the terminal event *would* move the end forward and postpone reclamation; that is an unintended
  retention extension an outcome writer could use to pin a log forever. The change in this ADR's PR:
  the end is the timestamp of the newest **terminal** event (found by scanning the tail backwards, as
  `orchestration`'s `settle` does), falling back to the old formula only when the terminal event was
  compacted away. It is a pinned kind for compaction (the app's evidence, ADR 0106).

### D2 — What stays 1P

The reward *pipeline*: collecting feedback, mapping it to `(executionId, decisionId)`, batching.
`@loom/analytics` ships `attachOutcomes(runtime, rewards[])` as a thin loop with retry. Validation of
`propensity` range (the audit's second R11 point) is a separate tightening of `ctx.decide`, listed in
the design document's open questions, not bundled here.

## Replay and migration

No new kind. Existing logs fold identically; a log with late outcomes appended after
`EXECUTION_COMPLETED` folds the same status (the handler is status-neutral) and a snapshot older than
the tail is extended by folding the tail, as for any late event.

## Tests

Attach to a completed execution → `_outcomes` has it, status unchanged, `late` and `recordedBy`
present; **a running or parked execution is refused and its holder's next append still succeeds (the
negative: with a fence it would not)**; two concurrent identical calls append once; a userspace
`ctx.emit` of `OUTCOME_RECORDED { recordedBy }` / `{ late: true }` is refused by the guard; **a late
outcome does not move the retention end** (an execution terminal for longer than `terminalTtlMs` is still
reclaimed after an outcome is attached); unauthorized principal refused, no event appended (negative: log untouched); unknown
decisionId refused; duplicate idempotent; conflicting score refused; strict + no principal refused;
compaction keeps it;
`@loom/learning` `trajectories` picks the late reward up from the fold with no join.

## Rejected

- **Side table** and **unauthorized 1P append**: see above.
- **Reopening the execution (`resumeAs`)**: a code-migration verb that would also re-drive the flow.

## Implementation notes (2026-10-07)

- **Frozen at W2-0, unchanged.** `OUTCOME_RECORDED.{recordedBy, late}`, the stamp-gated fold and the
  `guardUserspaceEmit` refusal were reserved at W2-0; EVENT_SCHEMA stays 1.23.0 and KERNEL_ABI 1.3.0. R11 adds
  the writer (`WorkflowRuntime.recordOutcome`), the `"annotate"` op, three typed errors
  (`ExecutionNotTerminalError`, `OutcomeRefusedError`, `OutcomeContendedError`) and the retention-clock change.
- **No `idempotencyKey`.** The frozen payload has no field for one, and `(decisionId, key)` is already the
  idempotency identity (D1), so the option the first draft listed is dropped rather than accepted and ignored.
  The result gains `sequence` (where the outcome sits; absent on `{ appended: false }`).
- **Order of checks.** Not-found (judged first for an anonymous strict caller, as `send` does) → authorize
  `annotate` against the recorded owner → shape (`decisionId`, `key` of at most 256 characters, finite `score`,
  boolean `success`, at least one of them) → then, inside the CAS loop, terminal → decision exists →
  `(decisionId, key)` already present (same outcome: `{ appended: false }`; a different one:
  `OutcomeRefusedError`). A denial appends **nothing** (like `send`, unlike a denied `resume`): a finished
  execution's log is evidence and a denied writer leaves it untouched; the `onExecutionDenied` callback fires.
- **A fenced execution.** The first draft said "no fence", which is right for *acquiring* one, but a store
  that ever issued a fence (a worker, a fenced timer wake, a cancel) refuses an unfenced append for good. On a
  `StaleFenceError` the writer re-appends under the store's **current** token (the error names it). That
  supersedes nobody (a terminal execution has no live holder) and the sequence CAS still decides between
  writers. Tested on the in-memory store, which fences.
- **`continued` is refused** with `ExecutionNotTerminalError` until R1b ships and defines the chain head (the
  design's step 8 adds the clause); the retention clock already treats a kernel-stamped `EXECUTION_CONTINUED`
  as a terminal event.
- **`recordedBy`** is `"system"` for the runtime's own grant, otherwise what the principal record would write
  for the caller: the codec `ref` when one handles the chain, else the verbatim actor (`"anonymous"` with
  none); refused in `ref` mode with no codec, as a start is. The delegation token is never read. Under
  `security.crypto`, `defineConfig` registers `OUTCOME_RECORDED.recordedBy` (events) and
  `variables._outcomes[].recordedBy` (snapshots) with the crypto stores, so the actor is shredded with the
  subject like the start's identity subset. An actor literally named `"system"` is indistinguishable from the
  grant in `recordedBy`; the field is provenance, not authorization.
- **Retention.** `LogLifecycle` now measures the end from the newest terminal event, scanning the tail
  backwards. Residual: the frozen `OUTCOME_RECORDED` handler moves `updatedAt`, so when compaction has
  removed the terminal event the fallback (`max(last event, updatedAt)`) still counts a late outcome. It takes
  a compaction run after the end plus a late outcome after that; the terminal event is the tip at any earlier
  compaction, which keeps it.
- **D2.** `attachOutcomes(runtime, rewards, { retries?, options? })` in `@loom/analytics`: a structural
  `OutcomeAttacher` (no dependency on the runtime), retrying only errors that say `retryable`, reporting
  `{ appended, duplicates, failed }`.
- **Learning.** No change to `@loom/learning`: `trajectories` reads the log, so a late outcome is a `direct`
  reward exactly like an in-run one, the logged propensity is untouched, and the terminal outcome stays the
  execution's own result (a test pins the trajectories, the SNIPS estimate and the logged value equal to the
  on-time run).
- **Not done here.** `propensity` range validation (design §7 question 8) stays a separate PR.

## Review round 1 (2026-10-07)

- **Sequence after compaction.** A late outcome is appended at `max(stored head, folded sequence) + 1`:
  after a compaction the stored head can sit below the checkpoint, and an append there would be
  invisible to the fold (and break idempotency).
- **Score bound.** `|score| <= 1e9` and finite, in `recordOutcome` AND in a flow's own
  `OUTCOME_RECORDED` emit (`guardUserspaceEmit`): a finite `1.7e308` otherwise sums to `Infinity` in
  `trajectories`, making the lift `NaN`, and `NaN < minLift` is false. `@loom/learning`'s
  `evaluatePolicy` now throws when its reward accumulators are non-finite, and `promotionGate`
  fails on a non-finite `lift` / `estimatedValue` / `loggedValue` / `effectiveSampleSize`.
- **Per-execution cap.** At most 1024 late outcomes per execution (`OutcomeRefusedError`); the
  duplicate check and the fold are O(n), so the cap bounds the cost of a call.
- **Reward pipelines use their own keys.** The idempotency key is `(decisionId, key)` across in-run
  and late outcomes: an in-run outcome under the same pair makes a later late one a duplicate (same
  value) or a conflict (different value). A reward pipeline should namespace its keys (for example
  `csat:`, `thumbs:`) apart from the flow's own.
- **Existence oracle.** Like `send` and `resume`, an authorized caller learns whether an execution
  exists and whether it is terminal; an unauthorized caller is denied before either is revealed.
- Pending user decisions (not implemented): fencing (Q1), `annotate` default scope (Q2), retention
  residual (Q3), compaction vs `OUTCOME_RECORDED` (Q4).
