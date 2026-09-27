# ADR 0106 — Compaction integrity: identity, re-compaction, and pinned event kinds

- Status: **Accepted — implemented** (2026-09-28)
- Date: 2026-09-28
- Found by: backlog item L11 (P1). A probe started a flow with two gates, compacted it at the
  first, resumed `go1`, and read the log back: only sequence 0 was left. The resume's events
  had been written to execution `""`.
- Builds on: [ADR 0022](0022-k10-log-lifecycle-retention-redaction-encryption.md) (K10.4
  compaction, whose `fold(snapshot, suffix) === fold(events)` contract this makes true),
  [ADR 0055](0055-k10-6-pin-seam-content-gc.md) (D1 pinned retention, and the "known gap"
  D6 recorded as L11, which this closes), [ADR 0074](0074-storage-scale-out-decorators.md)
  (every decorator must decide every optional SPI method).
- Placement: **kernel (`@loom/workflow-runtime`, `@loom/event-runtime`)** for the defects,
  plus one additive SPI method. **KERNEL_ABI unchanged (1.1.0)**: no syscall changes.
  **EVENT_SCHEMA unchanged**: no event kind, payload or fold changes. **EventStore SPI
  1.4.0 → 1.5.0** (additive MINOR): optional `truncatePrefixKeeping`.

## Context — three defects in `LogLifecycle.compact`

**(b) The checkpoint had no identity.** `compact` folded the log as `new ReplayVM(events)`
with no seed. `foldEvents` defaults `executionId`, `workflowId` and `workflowVersion` to `""`,
and no event sets them: sequence 0 carries them on its envelope, not in its payload. So every
compaction checkpoint said it belonged to execution `""` of workflow `""`.

**(a) A resume after compaction lost its events.** Two readers trusted that identity:

- `ExecutionJournal.commit` built every envelope from `vm.getState()`'s identity. A resume
  folds onto the latest snapshot, which after a compaction is the blank checkpoint, so the
  resume's events (`go1`, `EXECUTION_RESUMED`, the next `EXECUTION_SUSPENDED`) were appended
  as `executionId: ""`, ids `-2`, `-3`, `-4`. The execution's own log never saw them.
  `loadState` still looked right, because the runtime's suspend checkpoint was saved under
  the correct key with the (blank) folded state. The next reader of the log did not.
- `cancel()` and `fork()` also took the workflowId from the snapshot state.

A second compaction had its own defect: it folded the surviving events `[0, suffix]` from
scratch, dropping everything the first compaction had folded into its checkpoint. A step
recorded before the first compaction would have re-run its effect on the next resume.

**(c) Compaction deleted pinned events.** `truncatePrefix` removes all of `(0..through]`
except sequence 0. The fold ignores an app's own event kinds (`FINDING_RECORDED`), so the
checkpoint did not carry them either: a compacted run lost its findings. That broke ADR 0055
D1 twice. `pinByEventKinds` scans the log for the pinned kinds, so a compacted run stopped
being pinned and retention could reclaim it. And the content sweep lost the only citation of a
finding's evidence (ADR 0055 D6 recorded this as the L11 known gap).

## Decisions

### D1 — Identity comes from the log and the caller, never from a snapshot's copy

- `compact` seeds the fold with `executionId` (the argument) and `workflowId` (sequence 0's
  envelope). `workflowVersion` is not an event fact: it is carried from the snapshot the
  runtime already took (every suspend checkpoints its tip) and is `""` only when no snapshot
  ever recorded one.
- `ExecutionJournal` takes the identity it writes under as a constructor argument, from
  `execute(executionId, workflowId, …)`. The folded state no longer decides whose log an event
  lands in.
- Blank checkpoints written before this fix are durable, so the runtime re-stamps identity
  when it seeds a fold from any snapshot (`resume`, `resumeAs`, `loadState`/`foldState`,
  `cancel`, `fork`). A blank version is filled from the registered flow, which is what the
  un-snapshotted path seeds, so both paths fold to the same state. A snapshot that already
  names its execution is used as-is.

### D2 — A compacted log is folded on its checkpoint

Compaction always removes its own checkpoint's slot and keeps every event above it. So in a
compacted log the checkpoint sits exactly at the **highest sequence missing below the tip**
(`gap`), or, when only kept events survive above `gap`, above the tip. `compact` folds a gapped
log from `loadLatestBefore(through)` plus the events up to `through`. If no snapshot at or
above `gap` exists, it throws `CompactionCheckpointMissingError` and touches nothing: folding
the survivors would checkpoint a state missing the whole earlier prefix, and truncating on top
of it would make that permanent. A runtime snapshot at exactly `through` is a valid base; the
truncation is then the whole of the work.

Retention's `foldForRetention` always consults the latest snapshot (one point read). A log
compacted past a kept event at its tip is contiguous (`[0, 1]` with the checkpoint at 2), so
"contiguous" no longer implies "never compacted".

### D3 — Pinned event kinds survive compaction in place

- `LogLifecycle` takes `pinnedEventTypes` (the same list the app gives `pinByEventKinds` and
  `sweepUnpinnedContent`; `defineConfig({ durability: { retention: { pinnedEventTypes } } })`
  wires it). Kernel kinds are refused at construction: the checkpoint already carries their
  fold, and kernel log readers (`inspectStrayPassthroughs`, the fold's readers) assume no
  kernel fact survives below a checkpoint. To keep a kernel fact, pin the execution.
- The checkpoint is the **highest non-kept event at or below the tip**, so its slot is always
  removed and D2's rule finds it. Kept events at the tip stay above it and fold normally.
- New optional SPI method `truncatePrefixKeeping(executionId, through, keepEventTypes)`: the
  `truncatePrefix` range minus the kept types, as ONE atomic operation (Postgres: one
  `DELETE … AND event_type <> ALL($3)`; SQLite: `… AND event_type NOT IN (SELECT value FROM
  json_each(?))`). A separate method rather than a third argument to
  `truncatePrefix`, because a store that predates it would silently ignore the argument and
  delete the evidence. Kept events sit below the checkpoint, where no fold reads (every fold
  reads from `snapshot.sequence + 1`).
- A store without it (SPI 1.4.0) still compacts, stopping below the first kept event. That
  is a shorter compaction, never a lost event.
- With a `pinned` predicate and no `pinnedEventTypes`, `compact` returns `null` for an
  execution the predicate pins. The kernel cannot tell which of its events carry the pin, so
  ADR 0055 D1's "leave it exactly where it is" applies.
- The hash-chained store refuses `truncatePrefixKeeping` for the same reason it refuses
  `truncatePrefix` (ADR 0037). Every in-repo decorator forwards it. The `DecoratorPlan` type
  made each one a compile error until it did.

### D4 — Readers that inferred "compacted" from `events[1]` were updated

- **Content sweep (ADR 0055 D6).** It found the checkpoint at `events[1].sequence − 1`. A kept
  finding at sequence 1 made a compacted log look uncompacted, so the checkpoint's refs went
  unpinned and the orphan pass could erase them. A kept finding below the checkpoint pointed
  the lookup at the wrong sequence, and the sweep refused. It now uses D2's rule: the snapshot
  at exactly `gap`, or the latest snapshot when it is above the tip and only pinned kinds
  survive above `gap`. A contiguous log with a non-pinned event after the bootstrap still costs
  no snapshot read. A contiguous log whose post-bootstrap events are all pinned kinds is
  treated like a bootstrap-only log: it may have been compacted at its tip, so its latest
  snapshot must cover it or the orphan pass refuses.
- **`liveQuery`.** It checked only that a delta's first event was `tip + 1`. With a kept event
  at `tip + 1`, the truncated range is inside the delta. It now also checks the delta's span
  (`last − tip === length`, O(1)) and falls back to a full load on a mismatch.

## Consequences

- A resume, a second compaction and a resume across it give the same log suffix, the same
  state and the same effect-call count as the same execution never compacted
  (`compactionIntegrity.test.ts`).
- `EVENT_STORE_SPI_VERSION` 1.4.0 → **1.5.0**. The conformance kit checks `truncatePrefix`
  and, when present, `truncatePrefixKeeping`: kept types survive in place, an empty keep list is
  exactly `truncatePrefix`, and freed slots can be re-appended. `InMemoryAsyncEventStore`,
  `SqliteEventStore` and `PostgresEventStore` implement it.
- Checkpoints written before this fix still carry blank identity. They resume correctly now
  (D1), and the next compaction writes a checkpoint with its identity filled in.
  Events already appended to execution `""` by the old bug are not recovered. An operator can
  find them with `read("")`.

### Not changed

- `fork()` at a sequence inside a compacted prefix is still wrong: the events it would copy
  and fold are gone. It predates this ADR and is not a compaction-integrity regression.
  Recorded as a residual.
