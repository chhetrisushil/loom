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
in-memory store from an explicit check) and every decorator passes through —
`start()` throws `ExecutionAlreadyExistsError(executionId)`, a new typed error exported from
`@loom/workflow-runtime` beside `InputValidationError`. At that point no event has been folded,
`onEvent` has seen nothing, and no effect has run. The existing execution is untouched.

The conflict is matched by class and, as a fallback, by `name`, so a bundle carrying a second
copy of `@loom/event-runtime` cannot turn "already exists" into a generic storage failure.

Any OTHER failure of the bootstrap append (a dead store, a stale fence) refuses the start with
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
the id, which is the caller who asked for the guarantee.

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

- **Fenced mode, the loser's fence.** `TimerService` with `fenced: true` acquires a fence before
  each start. In a race, the loser may be refused as STALE (the winner holds a newer token)
  instead of as a duplicate. That refusal also happens at sequence 0, before the body — no second
  effect, which a test pins — but it surfaces as a `StorageWriteError` wrapping `StaleFenceError`,
  and the service still reports it to `onError`: it cannot tell a live winner from a newer holder
  that died before writing. In the other order — the loser acquires its fence AFTER the winner's
  bootstrap is durable — the loser gets `ExecutionAlreadyExistsError`, but its `acquireFence`
  has already superseded the winner, whose next write is refused as stale. That execution is
  left `running`, which is what `recoverAbandoned` is for. Both are properties of acquiring a
  fence per start attempt, unchanged by this ADR.
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
