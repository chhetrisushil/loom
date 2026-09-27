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
  envelope). `workflowVersion` is not an event fact. It comes from the fold's base snapshot,
  and when that is blank (a pre-0106 checkpoint) from the latest snapshot (the runtime
  checkpoints every suspend). It is `""` only when no snapshot ever recorded one.
- `ExecutionJournal` takes the identity it writes under as a constructor argument, from
  `execute(executionId, workflowId, …)`. The folded state no longer decides whose log an event
  lands in. The constructor refuses a blank `executionId` or `workflowId`. That covers every
  path that builds one, including `restoreFromState` given a legacy blank state.
- Blank checkpoints written before this fix are durable, so the runtime checks identity when it
  seeds a fold from any snapshot (`resume`, `resumeAs`, `loadState`/`foldState`, `cancel`,
  `fork`). A **blank** field is filled: the id the caller read, the workflowId sequence 0
  records, and the registered flow's version. The version is what the un-snapshotted path seeds,
  so both paths fold to the same state. A **non-blank field that disagrees** is refused with
  `SnapshotIdentityMismatchError`: only a store or tenant-scoping defect produces one, and
  filling it over would hide that defect. `fork` passes an explicit retarget flag, because a
  parent's snapshot seeds a child and its executionId is replaced, never compared.

### D2 — The tip rule, and a compacted log folded on its checkpoint

**The tip rule.** When any kept event would survive a compaction, its checkpoint `c` is the
highest non-kept sequence **strictly below the tip**. So the tip is never removed and `c`'s own
slot always is. When nothing is kept, `c` is the tip, as before: the log becomes `[0]` with the
checkpoint above it. Every log then has one of three shapes:

- **Gap-free, more than the bootstrap:** never compacted.
- **Gapped:** its latest checkpoint sits at its **highest missing sequence** `gap`. That is the
  sequence the compaction chose, and nothing above it was removed.
- **Bootstrap-only (`[0]`):** compacted through its tip (or it never got past its bootstrap).
  The checkpoint is its latest snapshot.

A checkpoint could lie above a non-bootstrap tip only if compaction removed the tip. The tip
rule forbids that, so readers need no special case for it.

`compact` folds on the latest snapshot at or below `c` when one exists. That is the checkpoint
for a compacted log. For a gap-free log it is a defensive base (the runtime's own snapshot)
that the fold invariant allows. A gapped log whose base is below `gap`, or missing, throws
`CompactionCheckpointMissingError` and touches nothing: folding the survivors would checkpoint
a state missing the whole earlier prefix, and truncating on top of it would make that
permanent. A base **at or above** `gap` is accepted. That is the compaction's own checkpoint
(exactly `gap`) or a later runtime snapshot. A child forked from a compacted parent copies the
gap, and its lowest snapshot is its fork seed, above the gap.

Retention's cheap path is unchanged. A gap-free log with more than the bootstrap is folded
directly. Anything else costs one snapshot point read.

**A denial never writes into the checkpoint's slot.** `resume`'s authorization denial used to
record `EXECUTION_DENIED` at the log's last event + 1. On a log compacted through its tip
(`[0]`, checkpoint `c ≥ 1`), that is sequence 1, at or below the checkpoint. The log then
looked never-compacted (`[0, 1]`), and the next compaction folded it from scratch and lost the
suspension.
The denial is now recorded after the **folded** tip (`max` of the log tip and the snapshot's
sequence).

### D3 — Pinned event kinds survive compaction in place

- `LogLifecycle` takes `pinnedEventTypes`: the same list the app gives `pinByEventKinds` and
  `sweepUnpinnedContent`, wired by `defineConfig({ durability: { retention: { pinnedEventTypes }
  } })`. The list is validated at construction, and so at boot. Entries must be non-empty strings:
  a `null` would match nothing in SQL but still be compared in memory, so backends would
  disagree. **Every kernel-written kind** is refused: the fold's kinds plus the resume signals
  the runtime records itself (`EXECUTION_RECOVERED`, `EffectInDoubtResolved`). The checkpoint
  already carries their fold, and kernel log readers assume no kernel fact survives below a
  checkpoint.
- **A pinned execution is never compacted.** When the `pinned` predicate pins an execution,
  `compact` returns `null`, with or without `pinnedEventTypes`. This is ADR 0055 D1: "leave it
  exactly where it is". `pinnedEventTypes` governs the executions that are *not* pinned
  wholesale, and the error message and docs say the same.
- New optional SPI method `truncatePrefixKeeping(executionId, through, keepEventTypes)`. It
  deletes the `truncatePrefix` range minus the kept types as ONE atomic operation (Postgres: one
  `DELETE … AND event_type <> ALL($3)`; SQLite: `… AND event_type NOT IN (SELECT value FROM
  json_each(?))`). It is a separate method rather than a third argument to `truncatePrefix`,
  because a store that predates it would silently ignore the argument and delete the evidence.
  Kept events sit below the checkpoint, where no fold reads (every fold reads from
  `snapshot.sequence + 1`).
- **A store without it (SPI 1.4.0) cannot compact past the first kept event, ever.** `c` stops
  just below it on every pass. For a long-lived execution that records a finding early (a
  sentinel), that means the replay tail grows without bound. `compact` reports it through
  `onWarn` (default `console.warn`; `defineConfig` passes the app's) on every pass where it
  applies. The SPI docstring and CHANGELOG say so too. Use a store that implements the method.
- The hash-chained store refuses `truncatePrefixKeeping` for the same reason it refuses
  `truncatePrefix` (ADR 0037). Every in-repo decorator forwards it. The `DecoratorPlan` type
  made each one a compile error until it did.

### D4 — Readers that inferred "compacted" from `events[1]` were updated

- **Content sweep (ADR 0055 D6).** It looked for the checkpoint at `events[1].sequence − 1`.
  A kept finding at sequence 1 made a compacted log look uncompacted, so the checkpoint's refs
  went unpinned and the orphan pass could erase them. A kept finding below the checkpoint
  pointed the lookup at the wrong sequence, and the sweep refused. It now uses D2's shapes:
  - A gap-free log with more than the bootstrap is skipped (no snapshot read).
  - A gapped log is covered by the **lowest snapshot in `[gap, tip]`**. That is one read in
    the common case, where it sits exactly at `gap`. For a forked child it is a walk down to
    the fork seed.
  - A bootstrap-only log is covered by its latest snapshot.

  The sweep's own `pinnedEventTypes` no longer affects this decision. A sweep that pins fewer
  kinds than compaction keeps still finds the checkpoint.
- **`liveQuery`.** It checked only that a delta's first event was `tip + 1`. A kept event at
  `tip + 1` hides the truncated range inside the delta, so it also checks the delta's span
  (`last − tip === length`, O(1)) and falls back to a full load on a mismatch.
- **Replay inspector.** `reconstructMany` folded straight across a gap. At a kept event below
  the checkpoint, or anywhere in compacted history, it returned a plausible wrong state. A
  position at or above a gap is now re-anchored on its own nearest snapshot. If no snapshot at
  or above the gap anchors it, the position is refused with `CompactedHistoryError`. A gap that
  ends the read segment is found by probing the first event past it.

## Consequences

- A resume, a second compaction and a resume across it give the same log suffix, the same
  state and the same effect-call count as the same execution never compacted
  (`compactionIntegrity.test.ts`). The content sweep over what the real `compact()` wrote
  keeps every checkpoint-held and finding-cited blob and still reclaims a true orphan
  (`compactionSweep.e2e.test.ts`).
- `EVENT_STORE_SPI_VERSION` 1.4.0 → **1.5.0**. The conformance kit checks `truncatePrefix`
  and, when present, `truncatePrefixKeeping`: kept types survive in place, an empty keep list is
  exactly `truncatePrefix`, and freed slots can be re-appended. `InMemoryAsyncEventStore`,
  `SqliteEventStore` and `PostgresEventStore` implement it.
- Checkpoints written before this fix may carry a blank identity. They resume correctly now
  (D1). A later compaction folds on such a checkpoint and fills the blank `workflowVersion`
  from the latest snapshot. It stays `""` only if no snapshot ever recorded a version. Events
  already appended to execution `""` by the old bug are not recovered; `read("")` finds them.
- `compact` through a log's tip still leaves `[0]`. `fork()` cannot fork at a sequence above
  the surviving events (its range check is `0..head`). This was already the case before 0106.

### Not changed

- `fork()` at a sequence inside a compacted prefix is still wrong: the events it would copy
  and fold are gone. It predates this ADR and is recorded as a residual.
