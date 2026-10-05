# ADR 0118 — A conditional fence: acquire-if-parked

- Status: **Proposed** (2026-10-05) — design approved after 4 review rounds; Accepted per item at implementation
- Date: 2026-10-05
- Closes: R8k (the R8 review's residual TOCTOU, named in the `@loom/orchestration` README, "Restart safety (R8)")
- Builds on: K9.4 ([ADR 0021](0021-k9-effect-delivery-contract-idempotency-fencing.md), `acquireFence`),
  [ADR 0117](0117-approvals-bound-to-what-the-approver-saw.md) (`locatePark`, `viewDigest` on a park),
  [ADR 0055](0055-k10-6-pin-seam-content-gc.md) (the retention pin predicate),
  [ADR 0074](0074-storage-scale-out-decorators.md) (a decorator must decide every optional SPI method),
  [ADR 0111](0111-durable-principal.md) (`EXECUTION_STARTED.parent`).
- Placement: **EventStore SPI (optional method) + a `RunOptions` field in workflow-runtime + one optional `TimerRecord` field (D4);**
  the retention half is **1P** (`@loom/orchestration`) over the existing pin seam. **EVENT_STORE_SPI
  2.0.0 → 2.1.0** (additive MINOR). KERNEL_ABI and EVENT_SCHEMA are not touched by this ADR.
- Revision: round 3 — the conditional is now on the fence token AND on the park being unanswered, atomically
  (`{ fence, parkSeq }`): a retry on the returned token alone reopened window 2 (a live resumer's append does
  not move the token); `contended` is its own retryable class with a live re-driver (D4). Round 2 — D2's retry uses the store-returned current token (the envelope token is stranded by any
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
acquireFenceIf?(executionId: string, expect: { fence: number; parkSeq: number }):
  Promise<{ fence: number } | { stale: true; fence: number }>;
```

Atomically: if (a) the execution's **current fence token** equals `expect.fence` **and** (b) **no answering
event** exists with `sequence > expect.parkSeq`, bump and return the new token; otherwise return
`{ stale: true, fence: <current> }` and change nothing. (b) is what makes a retry on a re-read token safe
(D2): a token read from a stale view cannot be attributed to a dead acquirer or to a live resumer whose
body is already running, but "a resume for this park is already in the log" can be, and a resume's append
does not move the token.

**Answering events (an allow-list, fixed in `@loom/event-runtime` and shared by every backend and the
conformance kit).** Counts: `EXECUTION_RESUMED` (any payload, including the `null` status-only re-open of
ADR 0104: it still moves the state from parked to running, which is what a second resumer must not
override), `EXECUTION_SUSPENDED` (a later park supersedes this one), and the terminal kinds
`EXECUTION_COMPLETED`, `EXECUTION_FAILED`, `EXECUTION_CANCELLED` and `EXECUTION_CONTINUED` (ADR 0109).
Ignored, because they are audit appends that follow a park without answering it: `EXECUTION_DENIED`
(unfenced, `recordExecutionDenied`), `OUTCOME_RECORDED` (ADR 0116, terminal-only anyway), `STEP_FAILED`
while parked (ADR 0105), `MESSAGE_CONSUMED` (ADR 0110: it is written by the running owner, before a park or
after the `EXECUTION_RESUMED` that answers one, so it never answers by itself), `EXECUTION_MIGRATED`,
annotations and every other kind. The classification is a **required** `Record<EventKind, "answering" | "ignorable">`
in `@loom/event-runtime` (no default: an unclassified kind is a compile error, so adding one forces the
decision). At runtime a kind absent from the map (only possible in a mixed fleet, where a newer node wrote a
kind this node does not know) is treated as **answering**: fail-closed, it costs at worst a `contended`
(retried by D4), never a fenced-out body. The SQL scan therefore filters `kind NOT IN (<ignorable list>)`, not
`= ANY(<answering list>)`. The token is the right
condition because it is what every legitimate writer's append is checked against (`StaleFenceError`,
`event-runtime/src/fencing`), and it moves **only** when someone acquires, never when an unfenced audit
event is appended. The caller passes the token under which the park it is answering was written: events
carry it as `metadata.fence` (`ExecutionJournal`, `WorkflowRuntime` bootstrap), and `locatePark` already
yields the park envelope. A park written with no fence expects `0` (the token a never-acquired execution
has). Backends: **memory** (`InMemoryAsyncEventStore`) is one synchronous step, the `fences` compare-and-set plus
a binary search of the sorted log to `parkSeq` and a scan of the (short) tail for an answering kind.
**SQLite** runs it in one `BEGIN IMMEDIATE` transaction (single writer, so the check and the bump cannot
interleave with an append). **Postgres** cannot do it as one statement: its append guards the fence with a
subquery (`PostgresEventStore.ts:177`) and takes no lock on the `fences` row, so under READ COMMITTED an
append that passed the guard at token 6 could commit after a single-statement `NOT EXISTS` had already
looked, and the acquire would fence out a body that had just been answered. So (1) the append's fence guard
reads the row `FOR SHARE` **only when the appended batch contains an answering kind** (`EXECUTION_RESUMED`,
`EXECUTION_SUSPENDED`, or a terminal kind including `EXECUTION_CONTINUED`) and (2) `acquireFenceIf` is a transaction: `SELECT fence … FOR UPDATE` (waits for in-flight
appends, blocks new ones), then a **separate statement** scanning `events` for an answering kind past
`parkSeq` (a fresh snapshot, so it sees every committed append), then the `UPDATE`. Why only answering appends: `fences` rows are created on the first `acquireFence`
(`PostgresEventStore.ts:445-446`) and never deleted, so a `FOR SHARE` on every append of any ever-fenced
execution would add xmax/multixact writes and WAL to the hot path (ceiling ~5.7K exec/s, ADR 0074/0075). The
invariant (append lands implies the acquire is stale, or acquire wins implies the append is `StaleFenceError`)
only constrains answering appends; step, effect and audit appends keep today's plain guard. Both append paths
take it: the single-append guard (`:177`) and the `appendMany` JOIN path (`PostgresEventStore.ts:287`, `LEFT JOIN
fences f …` becomes a locking read, `FOR SHARE OF f`, when any batch row is answering). No deadlock: an append
locks the fence row `FOR SHARE` then inserts in one statement; the acquirer locks the fence row `FOR UPDATE`
then runs a read-only scan, so neither holds a lock the other waits on in the opposite order. **Acceptance:**
the R8k PR runs `tools/bench-throughput` on fenced and unfenced executions before and after, and records the
numbers in this ADR's acceptance. A conformance case
races a resume append against `acquireFenceIf` and requires "append lands and acquire is `stale`" or
"acquire wins and the append is `StaleFenceError`", never both succeeding. The sharded and tenant
decorators forward it. A store without it keeps today's behaviour (the caller falls back to `acquireFence` and the documented
residual), and the conformance kit's case runs only when the method exists (as `copyPrefix` and
`truncatePrefixKeeping` do).

**Why the token and not the head.** Winner and loser both read the same park at fence `F`. The winner's
conditional acquire moves the token to `F+1`; the loser's sees `F+1 ≠ F` → stale, whatever else was
appended to the log in the meantime (an `EXECUTION_DENIED` after the park does not move the token, so the
legitimate resume is not refused for it). **Why also `parkSeq`.** The token alone cannot see a *committed
resume*: the winner appends under its token without moving it. Once the winner has appended, a rival that
re-read the token still sees it match and would acquire, fencing out the winner's running body.
Condition (b) refuses it.

**Residual and its closure.** A park answered through a path that never acquired a fence leaves the token
at `F`; condition (b) sees that answer now, so the conditional itself refuses. The runtime still
**re-checks `assertResumable` under the acquired fence** (the existing check that the newest park is still
unanswered, `not-suspended` otherwise) as defence in depth for a store without the method.

### D2 — The runtime uses it on an answering resume

`RunOptions.fenceIfParkedAt?: number` (the park's sequence, as `locatePark` supplies) on `resume` /
`resumeAs`: the runtime reads the park envelope at that sequence, takes its `metadata.fence` (or 0), and
acquires with `acquireFenceIf(id, { fence, parkSeq })` instead of `acquireFence`. On `{ stale, fence: cur }`
it **re-reads the park** (`locatePark`): if the execution is still parked on the **same wait** (the park is
unanswered) the token moved only because someone acquired and never appended (a crashed supervisor,
`TimerService.ts:323` `runtime.acquireFence`, `orchestration.ts:987`; an acquire is never undone, so the
park envelope's `metadata.fence` is **stale forever**), so it retries with `{ fence: cur, parkSeq }` —
**the token the store just returned, not the envelope's, and the same `parkSeq`**. Window 2 stays closed
*by the store*, not by the re-read: the interleaving "A acquires 6 and runs; B re-reads the park before A's
resume lands; A appends its resume; B retries with `cur = 6`" is refused because an `EXECUTION_RESUMED`
past `parkSeq` now exists (D1 (b)), whatever the token says; B's next re-read shows the park answered
(`not-suspended`, nothing appended). If instead B's retry lands between A's acquire and A's append, B takes
token 7 and A's *append* fails stale (window 1, a clean refusal that A's own bounded retry re-reads); no
resume had been recorded, so no body was running. Bounded (3 attempts); **exhaustion raises
`ResumeContendedError`**, a distinct class (D4) from `ResumeRefusedError`: the park is still unanswered, so
"not suspended" would strand the parent. If the park is gone or is a different one it raises the existing
`ResumeRefusedError` reason `not-suspended` and appends nothing. `superviseChildren`, `TimerService` and
ADR 0110's inbox notify-resume (which "fences up front") pass it; the R8 supervisor's bounded-acquisition
loop collapses to one attempt.

**The inbox notify path appends `[MESSAGE_CONSUMED, EXECUTION_RESUMED]` as ONE atomic `appendMany` under the
acquired fence.** `EXECUTION_RESUMED` is the only answering event of the pair; `MESSAGE_CONSUMED` stays
ignorable (a consumed message with no resume cannot answer a park, and the two never land apart, so a crash
leaves either both or neither). The re-driver therefore re-derives from the log and delivers exactly once.

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

### D4 — `contended` is a retryable class with a live re-driver

`ResumeContendedError` is **not** a `ResumeRefusedError` (no `reason`): a caller that treats every
`ResumeRefusedError` as final must not mistake "retry me" for "refused". It carries `retryable: true`,
`executionId` and `attempts`, is exported from `@loom/workflow-runtime`, and is raised only by D2's
exhaustion. Retrying it by hand is allowed; nothing may depend on that.

It also needs a **live** re-driver, because `recover()` is app-called and a live path that merely reports
an error leaves a parked parent waiting for an operator (the R8 lesson). On `contended` the *caller of the
resume* (the supervisor's resume path; ADR 0110's park-time self-resume) writes a **due-later re-drive
row** to the existing `TimerStore` for the execution and returns. `TimerRecord` gains an optional
`redrive?: { attempt: number }` (additive, `TimerStore` is unversioned). **SQL migration, guarded for
both stores** (`CREATE TABLE IF NOT EXISTS` never adds a column, `SqliteTimerStore.ts:23-26`): SQLite runs
`ALTER TABLE timers ADD COLUMN redrive TEXT` only when `pragma table_info(timers)` lacks `redrive`; Postgres
runs `ALTER TABLE timers ADD COLUMN IF NOT EXISTS redrive JSONB` inside `migrate(pool)`
(`PostgresTimerStore.ts:27`). The timer conformance kit gains a round-trip case and a **migration case: open an
old-shape table, then write a redrive row**. `wakeAt` is the due time and the row is idempotent per
`(executionId, wakeAt)`. **Collision rule:** the primary key plus `ON CONFLICT DO NOTHING`
(`PostgresTimerStore.ts:33`, `INSERT OR IGNORE` in SQLite) would drop the `redrive` flag when a redrive row
lands on an existing plain row. Chosen: `schedule` **upserts `redrive` on conflict**
(`ON CONFLICT (execution_id, wake_at) DO UPDATE SET redrive = COALESCE(EXCLUDED.redrive, timers.redrive)`;
SQLite equivalent `ON CONFLICT … DO UPDATE`), so a flagged row is never downgraded and a plain schedule never
clears the flag; jitter is additionally applied but nothing relies on it. **Flag:** redrive rows are written
only when `kernel.features.redrive` is on (like `inbox`, off until the fleet is upgraded); flag off keeps the
old behaviour (the error is surfaced and `recover()` re-drives). Backoff is exponential with full jitter
(`base 200 ms`, doubling, capped at `30 s`, jitter from the injected rng so DST is deterministic), at most
`maxRedriveAttempts` (default 8) rows in succession, the attempt number carried in the row.
`TimerService.fire` is widened: a row with `redrive` set is **not** judged by `suspendedOn.wakeAt` (which
would retire it as obsolete); it calls the registered re-drivers (`TimerServiceOptions.redrivers`, which
`superviseChildren` and the inbox notify path register), each of which re-derives its resume from the log
and answers `done | noop | contended`; `contended` writes the next row with `attempt + 1`, `done`/`noop`
completes the row, and exhaustion reports `onError` once and leaves the execution to `recover()`. The
re-driver runs under the existing lease claim, so two nodes do not both drive it.

## Replay and migration

No event or fold change. A runtime on 2.1.0 with an older store falls back to `acquireFence`; an older
runtime ignores the optional method. The `acquireFenceIf` half is safe in both directions. The redrive rows
are **not**: an older node's `TimerService.fire` judges every row by `suspendedOn.wakeAt` and retires a redrive
row as obsolete, a silent loss of the re-drive. That is why redrive writes sit behind `kernel.features.redrive`
(D4) until every node runs 2.1.0; with the flag off nothing new is written.

## Tests

**Dead acquirer then a legitimate resume (conformance + DST)**: acquire fence on a parked execution and
never append, then resume with `fenceIfParkedAt` — the resume succeeds via the `{ fence: cur, parkSeq }`
retry; with three consecutive dead acquirers racing it surfaces `ResumeContendedError` (retryable), never
`not-suspended`. **Live re-drive: with no `recover()` call anywhere**, a `contended` resume leaves a re-drive
row, the `TimerService` fires it with backoff, and the execution still completes (and gives up exactly once
via `onError` after `maxRedriveAttempts`). **DST (round 3)**: a dead acquirer leaves token 5; resumers A and B
both read `cur = 5`; A acquires (6), B re-reads the park (unanswered), **A's resume commits between B's
re-read and B's acquire**, B acquires with `{ fence: 6, parkSeq }` — assert B is `stale`, B ends
`not-suspended`, A's running body is **never fenced out** and exactly one `EXECUTION_RESUMED` is recorded;
run it over every interleaving of the four steps with crashes. **DST: crash mid-notify** (between the
fence acquire and the `appendMany`, and after it) over the inbox path: the redrive completes the wake with
exactly one `MESSAGE_CONSUMED` and one `EXECUTION_RESUMED`, never two deliveries and never none. Conformance: `acquireFenceIf` is `stale`
when an `EXECUTION_RESUMED` / `EXECUTION_SUSPENDED` / terminal kind exists past `parkSeq` even though the
token matches, and is NOT stale for `EXECUTION_DENIED`, `OUTCOME_RECORDED`, `STEP_FAILED`,
`MESSAGE_CONSUMED`; plus the Postgres append-vs-acquire race case (D1; answering append vs `acquireFenceIf`, on both the single-append and the `appendMany` JOIN path), and an unclassified-kind case (a kind absent from the map is treated as answering).
Conformance case (token and `parkSeq` match → new token returned; token moved → `stale`, token unchanged; concurrent
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
- **Retrying on the returned token alone** (round 2): a token from a stale read cannot be attributed to a dead
  acquirer or to a live resumer; the retry reopened window 2 until the answered-park check moved into the
  store (D1 (b)).
- **A new LeaseStore-based "park lease"**: a second coordination primitive for a question the log head
  already answers.
- **Teaching `LogLifecycle` about children**: the kernel has no child relation; the pin seam exists
  exactly so policy stays outside it.
