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
  it with the default rule `"owner"` (amendment, Q2: a reward steers policy learning, so only the recorded owner writes one by default; a reward pipeline opts in with `rules: { annotate: "tenant" }`); the conformance kit gains the op), judged against the recorded
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
  compacted away. (Superseded by the amendment below: compaction never removes a terminal execution's
  terminal event, and it KEEPS `OUTCOME_RECORDED` and `DECISION_RECORDED` in place. The first draft's
  claim that `OUTCOME_RECORDED` "is a pinned kind for compaction (ADR 0106)" was wrong:
  `assertPinnedEventTypes` refuses kernel kinds, so nothing pinned it and compaction dropped it.)

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
- **A fenced execution.** (Superseded by the amendment below: the round-0 design re-appended under the
  store's current token taken from `StaleFenceError`; that adoption path is removed.)
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
  backwards. (The residual named here, the `updatedAt` fallback after compaction removed the terminal
  event, is closed by the amendment below.)
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

## Amendment — review round 2 (2026-10-07; user decisions Q1–Q4)

### Q1 — the conditional append: `EventStore.appendIfUnchanged` (EVENT_STORE_SPI 2.1.0 → 2.2.0)

Round 0 wrote the late outcome with a plain `append`, adopting the store's current fence token from a
`StaleFenceError`. Two defects followed. (1) A retention sweep that deleted the log between the fold and
the append left an **orphan**: an `OUTCOME_RECORDED` at sequence n+1 with no sequence 0. (2) A holder that
had acquired a fence but not yet appended (ADR 0104 `resumeAs` on a failed execution) lost its slot or its
run to the late outcome. Both are time-of-check/time-of-use gaps that no amount of retrying in the runtime
closes; they need one atomic step in the store.

```ts
appendIfUnchanged?(executionId, event: EventEnvelope | null, expect?: { head: number; fence: number }):
  Promise<{ appended: true } | { appended: false; reason: "moved" | "gone" | "observed"; head: number | null; fence: number }>;
```

Atomically: append `event` iff (a) the execution EXISTS (its sequence-0 event is stored), (b) the stored head
is exactly `expect.head`, and (c) the fence token is exactly `expect.fence` (0 = never fenced). Otherwise
nothing is written and the current tip is reported (`moved`, or `gone` with `head: null`). `event === null` is
a pure observation. It **never presents, bumps or adopts a token**: the caller observed the token, the store
proves it has not moved. `recordOutcome` observes (head, token), folds, validates, then appends conditionally;
`moved` re-observes and re-judges within the existing bound (`OutcomeContendedError`, retryable), `gone` is
"no such execution" with nothing written. A store without the method makes `recordOutcome` **refuse with a
clear error** (`OutcomeRefusedError` naming the method); there is no unsafe fallback to a plain append.

Why the token is in the condition. A token that moved since the observation means a holder acquired after the
caller looked; the write is refused rather than placed inside the holder's range. This closes holders that
acquire AFTER the observation. A holder that acquired BEFORE it and has not yet appended (the window in the
review's `p2_fence` probe) looks identical to a dead one, so `recordOutcome` adds a rule: on a fenced execution
(token > 0) the newest terminal event must have been written under the CURRENT token (the finishing holder's
own); a token acquired after the end is refused with a retryable `OutcomeContendedError` and nothing appended.
Residual: a holder that acquired and died leaves the execution refusing late outcomes until it is re-run (or
reopened and finished, which writes a new terminal event under the new token). A never-fenced execution, the
common case, pays nothing for this.

Locks, per backend (the same row ADR 0118's `acquireFenceIf` and answering appends use):
- Memory: one synchronous step after the tick (existence, head, token, commit).
- SQLite: one `BEGIN IMMEDIATE` transaction; SQLite does not fence, so the token is always 0.
- Postgres: a transaction that ensures the execution's fence row, takes it `FOR UPDATE` (waits for an in-flight
  acquire or answering append and blocks new ones), re-reads head and existence in a fresh statement and
  inserts. `deleteExecution` now takes the same row before deleting, so a delete and a conditional append are
  strictly ordered: **no orphan is possible**. When the execution is gone the token-0 row this call created is
  removed again; a real token (> 0) is KEPT, the tombstone that keeps a zombie writer of a re-created id fenced
  out (tested).
- Every decorator transforms the event exactly as for `append`: tenant scoping, encryption, content
  externalisation, the audit-chain stamp (chained onto the tail, the cached head dropped on refusal), a DST
  fault draw, the crash simulator's drop; sharding routes; coalescing and profiling forward (nothing of a
  finished execution is pending). The conformance kit gains cases (unchanged / moved / gone-no-orphan / fence
  acquired after observation / token compared not presented / concurrent callers exactly one wins). ADR 0118
  cross-references this method: it is the append-side twin of `acquireFenceIf` and shares its row lock.

### Q2 — `annotate` defaults to `"owner"`

`executionAccessPolicy` maps `annotate` to `"owner"`; `rules: { annotate: "tenant" }` widens it for a
tenant-wide reward pipeline.

### Q3 — compaction never removes the terminal event

`LogLifecycle.compact` caps the checkpoint just below a terminal execution's newest terminal event, so
retention always finds the end of the execution on the log and a late outcome (whose frozen handler moves
`updatedAt`) can never extend it. Tested: three late outcomes each inside a TTL window do not pin a compacted
log.

### Q4 — compaction keeps the learning evidence

`OUTCOME_RECORDED` is kept in place by compaction (kernel-side, in `compact` itself: `assertPinnedEventTypes`
refuses kernel kinds from policy). **`DECISION_RECORDED` is kept with it**, an addition the decision implies
and the review did not name: `@loom/learning`'s `trajectories` joins a reward to its decision (context,
propensity, action set) off the LOG, so keeping only the rewards would leave a compacted execution's rewards
orphaned and `trajectories` empty for it (the test asserts the trajectories of a compacted log equal those of
the full log, which fails with outcomes alone). Both sit below the checkpoint where no fold reads them. Cost:
a compacted log retains its decisions and rewards (bounded by the decisions an execution made).
