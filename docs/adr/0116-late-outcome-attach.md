# ADR 0116 — Attaching an outcome to a past decision of a finished execution

- Status: **Proposed** (2026-10-05) — design approved after 4 review rounds; Accepted per item at implementation
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
  fields onto the entry (`recordedBy` when a string, `late` when `true`), so they ride the fold.
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
