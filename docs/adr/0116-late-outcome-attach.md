# ADR 0116 — Attaching an outcome to a past decision of a finished execution

- Status: **Proposed** (2026-10-05)
- Date: 2026-10-05
- Closes: R11 (agentic-readiness audit, kernel appendix §2i)
- Builds on: [ADR 0030](0030-decision-materialization.md), [ADR 0078](0078-exploration-in-the-routing-seam.md)–[0080](0080-learning-substrate.md)
  (decisions carry `policy.propensity`; `@loom/learning` evaluates off-policy),
  C.1 execution authz, K9.4 fencing.
- Placement: **a small runtime method, not a syscall and not a store.** No ABI change; no new event
  kind. The one schema-visible part is two additive optional payload fields on the existing
  `OUTCOME_RECORDED`, inside the shared Wave 2 EVENT_SCHEMA 1.23.0.

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
}, options?: { principal?, system?, fence? }): Promise<{ appended: boolean }>
```

It is not an `ExecutionContext` member (no ABI), it is not a state change, and it adds no event kind.

### D1 — Semantics

- Authorized as a new `ExecutionOp` `"annotate"` (an additive union member; `executionAccessPolicy`
  maps it with the default rule `"tenant"`; the conformance kit gains the op). Under `security.strict`
  a call without a principal is refused.
- Legal on a **terminal or running or parked** execution; not on a nonexistent one (judged by the
  authorizer before "not found" is revealed, the existing order). It acquires the fence first
  (K9.4), so it can never race a live holder: the holder's next append is rejected or this call is
  (documented: a live execution should use `ctx.emit`; `recordOutcome` is for the finished ones).
- The `decisionId` must exist in the fold's `_decisions` (an outcome for a decision that never happened
  is refused: reward poisoning by invented ids). `(decisionId, key)` is idempotent: a second identical
  call returns `{ appended: false }`; a different `score` for the same pair is refused, not
  overwritten (the log is append-only; a correction is a new `key`).
- The event is the existing `OUTCOME_RECORDED`, with two additive optional fields, `recordedBy`
  (the caller's actor, or `"system"`) and `late: true`, so a learning pipeline can tell a delayed
  reward from an in-run one and audit who attached it. The fold keeps appending to `_outcomes`
  (unchanged handler; the new fields ride verbatim).
- It does not change status, does not touch `_failedWhileParked`, does not refresh retention clocks
  that key off terminal time (`LogLifecycle` measures from the terminal event), and is a pinned kind
  for compaction (the app's evidence, ADR 0106).

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
present; unauthorized principal refused, no event appended (negative: log untouched); unknown
decisionId refused; duplicate idempotent; conflicting score refused; strict + no principal refused;
a live holder's next append still succeeds or this call fails cleanly (fence); compaction keeps it;
`@loom/learning` `trajectories` picks the late reward up from the fold with no join.

## Rejected

- **Side table** and **unauthorized 1P append**: see above.
- **Reopening the execution (`resumeAs`)**: a code-migration verb that would also re-drive the flow.
