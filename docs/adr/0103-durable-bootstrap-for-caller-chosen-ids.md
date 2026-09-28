# ADR 0103 — A caller-chosen execution id's bootstrap is durable before the body runs

- Status: **Accepted — implemented** (2026-09-27)
- Date: 2026-09-27
- Found by: the [Ambient Experience Projection evaluation](../requirements/2026-09-27-ambient-experience-projection-evaluation.md)
  §1.2, by running code: starting the same deterministic id twice invoked the flow's model
  effect twice before the store refused the second log.
- Builds on: [ADR 0051](0051-perpetual-agents-placement-schedule-remodel.md) (deterministic
  schedule-occurrence ids, whose dedup this closes), [ADR 0058](0058-read-model-plugin.md)
  (the catch-up read a durable-only consumer uses instead of `onEvent`),
  [ADR 0083](0083-second-consumer-rule.md) (why no `startOnce` helper is exported).
- Placement: **kernel (`@loom/workflow-runtime`)**, approved by the maintainer (2026-09-27).
  **KERNEL_ABI unchanged (1.1.0)**: no syscall added, removed or renamed. **EVENT_SCHEMA
  unchanged**: no event kind, payload or fold changes; the bytes written are the same, only
  WHEN sequence 0 is written moves. **No SPI change**: it relies on the uniqueness every
  `EventStore.append` already MUST enforce.

## Context — the defect

`start()` accepts a caller-chosen `executionId`. A caller chooses one precisely so a repeated
trigger maps to the same execution: a schedule occurrence (`<scheduleId>@<occurrence>`,
ADR 0051), a message id, an idempotency key. Nothing in `start()` checked it.

The bootstrap `EXECUTION_STARTED` went through `ExecutionJournal.commit`, which folds the
event, fires `onEvent`, and only ENQUEUES the append. The runner started on the next line. So
for a duplicate id:

1. the second run's `EXECUTION_STARTED` was folded and delivered to `onEvent`;
2. the body ran and invoked its first effect — a paid model call in the probe;
3. only then did the store reject sequence 0 with `DuplicateSequenceError`, failing the run at
   its next drain barrier.

The log was idempotent. The cost was not: every duplicate trigger paid for its effects once
more, and every `onEvent` subscriber saw events that never became durable.

`TimerService.startOccurrence` worked around it privately with a `loadState` pre-check. That is
racy across nodes: two nodes that both check before either writes both start, which a test in
this change reproduces (two services, one occurrence, the audit effect invoked twice).

## Decisions

### D1 — With a caller-chosen id, sequence 0 is durable before the body runs

When `options.executionId` is supplied, `start()`:

1. builds the bootstrap envelope with `ExecutionJournal.bootstrapEnvelope(...)`, the SAME builder
   `commit` now uses (one private `build`), so the envelope is byte-identical to the one the
   journal would have written: id `<executionId>-0`, timestamp from the injected clock, the
   caller's metadata (`computeTarget`) with `fence` merged over it;
2. `await`s `eventStore.append(envelope)`;
3. hands the stored envelope to `execute`, where `ExecutionJournal.adopt(envelope)` claims
   sequence 0, folds it, and fires `onEvent` and `onCommit` — everything `commit` does except the
   append, which has already happened. `adopt` refuses any sequence but the next one.

Only then does the runner start. The ordering is the whole fix, and only the kernel owns it:
`start()` is the one place that sits between "the id is chosen" and "the body runs".

### D2 — A conflict at sequence 0 is `ExecutionAlreadyExistsError`; nothing ran

If that append rejects with `DuplicateSequenceError` or `DuplicateEnvelopeIdError` — the two
conflicts every backend normalizes to (SQLite and Postgres from their unique constraints, the
in-memory store from an explicit check) — or with `StaleFenceError` (amended by L12: a fencing
store checks the token before the slot, so a duplicate of an execution that has since been
fenced is refused on the fence) — AND this execution's sequence 0 is then readable
through the same store, `start()` throws `ExecutionAlreadyExistsError(executionId)`, a new typed
error exported from `@loom/workflow-runtime` beside `InputValidationError`. At that point no
event has been folded, `onEvent` has seen nothing, and no effect has run. The existing execution
is untouched.

**The conflict is confirmed, not trusted.** A conflict error does not always describe the write
that received it. `CoalescingEventStore` (ADR 0074) rejects EVERY caller in a failed batch with
the batch's error, so a fresh id that shared a batch with a real duplicate receives the
duplicate's `DuplicateSequenceError` while nothing of its own was written (the batch is
all-or-nothing). Mapping that straight to "already exists" would drop a fresh start forever — a
`TimerService` occurrence would never run. Nor can the error's own `executionId` decide it: a
scoping decorator (`TenantScopedEventStore`) reports the id it wrote, tenant-prefixed, not the
caller's. So on a conflict or a stale fence `start()` reads `[0..0]` back through the same decorated
store:

- present → `ExecutionAlreadyExistsError`;
- absent → the rejection was someone else's (or, for a stale fence, a token acquired for an id
  nobody has written); retry the append ONCE, alone — as a one-envelope `appendBatch`
  (`appendBatchOf`), which a `CoalescingEventStore` flushes as its own batch, so two same-id
  starts that failed together cannot share a batch, and fail together, again (L12 review);
- a second conflict or stale fence with sequence 0 still absent (for example `<id>-0` taken as
  an envelope id by a different execution in a store-wide-id backend — a minted-twice bug, not
  an existing execution), or a failed read-back → `StorageWriteError`.

The conflict and the stale fence are matched by class and, as a fallback, by `name`, so a
bundle carrying a second copy of `@loom/event-runtime` cannot turn "already exists" into a
generic storage failure.

Any OTHER failure of the bootstrap append (a dead store) refuses the start with
`StorageWriteError` and is reported to `onStorageError`, the same pair a journal write failure
produces. Before this change such a start returned a handle whose run then failed; now it fails
before the body runs.

### D3 — The default (ulid) path is unchanged and byte-identical

A minted ULID cannot collide, so the default path pays no barrier: the journal still folds,
fires `onEvent` and enqueues sequence 0 exactly as before. A test pins today's interleaving of
appends and `onEvent` calls for a ulid start, and another asserts that a caller-chosen-id start
writes the same log and delivers the same `onEvent` sequence as a ulid start with the same
clock, fence and placement hint, ids aside.

The cost of D1 — one awaited append before the body starts — is paid only by a caller who chose
the id, which is the caller who asked for the guarantee. Behind a `CoalescingEventStore` with
`maxLingerMs > 0`, that wait includes the linger as well as the round-trip: the bootstrap is
held for company like any other append before its batch commits. (A confirmed-absent conflict
adds one indexed read and one more append.)

### D4 — `TimerService` treats the typed error as "already started"

`startOccurrence` keeps its cheap `loadState` fast path for an occurrence that is visibly started,
and catches `ExecutionAlreadyExistsError` as "another node won the race": it returns without
calling `onError`. The cross-node race becomes a clean refusal instead of a wasted run.

### D5 — No `startOnce` helper

After D1, `start()` IS start-once for a caller-chosen id; a caller catches the typed error:

```ts
try {
  await runtime.start(flow, input, { executionId });
} catch (err) {
  if (!(err instanceof ExecutionAlreadyExistsError)) throw err;
}
```

**Rejected alternative:** extract `startOnce(runtime, flow, input, { executionId })` from
`TimerService` as exported 1P vocabulary. ADR 0083 would admit it (`TimerService` and the
orchestration supervisor are two unrelated consumers), but it would be the three lines above
under a name, and a `loadState` pre-check inside it could narrow the window without closing it.
Only the kernel orders the bootstrap write relative to the body, so the guarantee lives there,
and `start()` itself stops being unsafe for every other caller.

### D6 — `onEvent` stays pre-durability for every later event (documented, not changed)

`onEvent` is the live tail: it fires as an event is folded, before its durable write completes.
That is deliberate — the journal keeps the in-memory fold independent of store latency, and a
failed durable write aborts the run and fails it at the next drain barrier. So an event seen by
`onEvent` can, on a storage failure, never become durable. D1 removes the one case where that
happened on a HEALTHY store (the doomed duplicate run); it does not make `onEvent` a durability
signal. The `WorkflowRuntimeDeps.onEvent` JSDoc now says so, and says what to do instead: a
consumer that must act only on durable facts reads them back with a catch-up read over the
store, the read-model plugin's shape (ADR 0058).

## Residuals

- **Fenced mode, the loser's fence. RESOLVED (L12, 2026-09-28).** `TimerService` with
  `fenced: true` acquired a fence before each occurrence start, and that caused two problems.
  If the loser acquired its fence FIRST, it was refused as STALE at its bootstrap and reported
  to `onError`. If it acquired its fence AFTER the winner's bootstrap was durable, it was
  refused as a duplicate, but its token had already superseded the winner's. The winner's
  first effect ran, its next write was refused as stale, the execution was left `running`,
  and `recoverAbandoned` re-drove the step, which paid for the effect a second time
  (at-least-once, not exactly-once).

  The fix: **a start does not acquire a fence.** `startOccurrence` no longer fences in either
  mode (fires still do; see the open residual below). A start's fence protected nothing that
  D1 and the fencing SPI do not already cover. D1 refuses a duplicate at sequence 0 before
  its body runs, and a fencing store MUST refuse a *missing* token once an execution has one
  (now a single-`append` conformance case), so the first later `acquireFence` (a fenced wake,
  a recovery pass, a cancel) fences out an unfenced starter exactly as it would a fenced one.
  Under `fenced: true` a scheduled execution therefore accepts unfenced writes until its
  first fence — the default mode's exposure, for that window only.

  The alternatives were rejected. A `loadState` check before the fence narrows the window
  without closing it, which is the race D4 already describes. An acquire-if-absent fence SPI
  would have to be atomic with the append in every store and decorator, which means SPI
  growth to protect a token the start does not need. Both orderings now refuse the loser as
  `ExecutionAlreadyExistsError` without calling `onError`, and deterministic tests
  (`t1-schedules.test.ts`) pin both orderings, the second with exactly one effect across the
  race and a recovery pass.

  D2 is amended to confirm a `StaleFenceError` at sequence 0 by read-back like a conflict, and
  to send its single retry out as its own batch. The `acquireFence` JSDoc no longer suggests
  fencing a start.

  **The dispatcher path does not have this hole.** `LocalWorkerRuntime.allocate` also fences
  every dispatch, including a first one, but it fences BEFORE `execute` checks whether the
  execution exists — the opposite order to the old `startOccurrence` (check, then fence). A
  loser that read "no such execution" took its token before the winner's bootstrap, and that
  bootstrap lands only if the winner's token is newer, so the loser is refused at sequence 0
  (stale fence, confirmed as `ExecutionAlreadyExistsError`) and has superseded nobody. A loser
  that allocates after the bootstrap reads it back and takes the execution over by ADR 0004's
  redispatch rule. A loser that allocates between the winner's fence and its bootstrap makes
  the winner's bootstrap stale, so the winner never starts and the loser does. In no ordering
  is a live runner fenced out while nobody drives the execution; `worker-runtime-local`'s
  `fencing.test.ts` pins the racing-first-dispatch case. That argument holds PER ATTEMPT: a
  retrying dispatcher (`LocalDispatcher` with `maxAttempts > 1`) counts a lost race
  (`ExecutionAlreadyExistsError`) or a fenced-out attempt as failed and redispatches, and the
  redispatch's new fence can still supersede a live holder (the two can ping-pong) — tracked
  as follow-up L20, outside this ADR.
- **Open: duplicate cross-node timer FIRES without `leases` supersede each other.** A fire is
  still fenced (`TimerService.fire` acquires a token before resuming), and a token acquired
  after another node's resume is durable fences that node out mid-body, after its effect —
  the L12 shape. The execution is left `running` for a recovery pass, which pays for the step
  again. Fencing a fire makes a duplicate fire's WRITES safe, not its effects exactly-once.
  The fix is ownership before the fire, which `TimerService({ leases })` already provides
  (#380, [durable leases](../requirements/2026-09-15-durable-lease.md) L5a): a node that
  cannot claim the lease skips the fire. Without `leases`, a multi-node fenced deployment is
  at-least-once per wake.
- **A duplicate bootstrap in a coalesced batch aborts innocent writers in that batch.** The
  batch rejection that D2 guards the fresh START against also reaches any live execution whose
  envelope shared the batch: its journal records the write error and the run aborts. That is
  existing `CoalescingEventStore` behaviour (all-or-nothing batches reject every caller), the
  same shape L1 documents in ADR 0074 for a stale-fence zombie; this ADR adds a new way to put a
  conflicting envelope into a batch, not the blast radius.
- **The conflict read-back on a store without `readRange`** falls back to `readFrom(id, 0)`, a
  whole-log read, but only on the conflict path; a successful bootstrap never reads.
- **Behind a read-lagging replica decorator** (reads served by a replica that has not caught up),
  a real duplicate's sequence 0 can read back as absent, so it surfaces as `StorageWriteError`
  after the single retry instead of `ExecutionAlreadyExistsError`. That is loud and safe (nothing
  ran), just less specific.
- **A crash between the bootstrap write and the body** leaves an execution whose log is
  `EXECUTION_STARTED` alone — `running` with nothing in flight. That was already possible on the
  default path (the append is enqueued before the first effect), and `recoverAbandoned` re-drives
  it the same way.

## Consequences

- A duplicate trigger with a deterministic id costs one refused append, not a run: no effect,
  no fold, no `onEvent`.
- `start()` with a caller-chosen id is slower by one store round-trip before the body. The
  default path is not.
- A consumer test that relied on a duplicate start "succeeding" (returning a handle) was a test
  of the defect; it now receives `ExecutionAlreadyExistsError` from `start()`.
