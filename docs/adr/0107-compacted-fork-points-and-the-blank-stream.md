# ADR 0107 — Fork points in compacted history, and the blank stream the pre-0106 bug wrote

- Status: **Accepted — implemented** (2026-09-28)
- Date: 2026-09-28
- Closes: the two residuals [ADR 0106](0106-compaction-integrity.md) recorded. `fork()` at a
  sequence inside a compacted prefix returned a wrong state, and could not fork above the
  surviving events of a `[0]` log. The events the pre-0106 bug wrote to execution `""` were
  "not recovered".
- Builds on: [ADR 0106](0106-compaction-integrity.md) (the tip rule and the three log shapes),
  [ADR 0071](0071-read-only-replay-inspector.md) (the inspector's `CompactedHistoryError`,
  whose exactness rule `fork` now shares), [ADR 0022](0022-k10-log-lifecycle-retention-redaction-encryption.md)
  (lifecycle facts on `__loom_lifecycle__`).
- Placement: **kernel (`@loom/workflow-runtime`, `@loom/replay-vm`, `@loom/event-runtime`)**
  plus one operator command (`loom repair blank-stream`). **KERNEL_ABI unchanged (1.1.0)**.
  **EVENT_SCHEMA 1.21.0 → 1.22.0** (additive MINOR): one new event kind, `EVENTS_REHOMED`.
  **No SPI change.** `isReservedStream("")` is now `true`.

## Context

### (A) `fork()` of a compacted parent

`fork(parent, at)` promises a child whose log is the parent's prefix `[0..at]` and whose state
is the fold at `at`. It folded from the nearest snapshot at or below `at` across whatever events
it found, and copied whatever survived. After a compaction, the events below the checkpoint are
gone (only the bootstrap and pinned kinds survive). A fork point inside that hole got the base
snapshot's state (or the fold of `[0, kept…]` with no base) plus the survivors: a plausible
state that was never the parent's, over a copied prefix missing the history the state claims.

Its range check was `0..head`. A log compacted through its tip is `[0]` with the checkpoint
above it, so the one fork point with an exact answer, the checkpoint, was refused.

### (B) The blank stream

Before ADR 0106, a compaction checkpoint named execution `""`, and a resume folded on it
journaled under that identity. A probe against the pre-fix build (`d625781`) shows what that
left, and what it did not:

- **The events** sit in execution `""` at the sequences their own execution would have used.
  The envelope carries no identity: `executionId: ""`, `workflowId: ""`, `id: "-<sequence>"`,
  and no metadata. Timestamps and payloads survive. A second execution resuming into the same
  slots failed with `DuplicateSequenceError` and wrote nothing, so slots never mix within one
  run's range. But runs of different executions interleave in `""` wherever their sequences do
  not collide.
- **The snapshots** were keyed correctly. The runtime saved its suspend checkpoint under the id
  it was driving (`e1`), and only the state inside was blank. The suspend checkpoint is taken
  after a drain barrier, so every event its run committed up to it was durable.
- **A run that completed** without a checkpoint (the default cadence takes none on completion)
  or crashed left nothing that names its writer. `loadState(e1)` still reads the last suspend
  snapshot, so e1 looks parked at a gate it has already passed.

## Decisions

### D1 — A fork point is served exactly or refused, by the inspector's rule

The state at `at` is exact iff every event in `(base, at]` survives, where `base` is the
nearest snapshot at or below `at` (or `-1` with none, when the whole prefix must survive). That
is the replay inspector's rule for a compacted position (ADR 0106 D4). `fork` checks it by
counting the window it already reads, so it needs no extra I/O. When it fails, `fork` throws
`CompactedForkPointError` (`reason: "compacted"`) before anything is written: no child events,
no seed snapshot, no lineage, no timer.

We chose refusal over approximation. The alternative, "fork at the nearest forkable point below",
silently hands back a different state than the one asked for. That is the defect itself, only
better hidden.

### D2 — A snapshot sitting exactly at the fork point serves it

When `base.sequence === at`, the state is the snapshot's, even if event `at` itself was
compacted away: the checkpoint of a `[0]` log, or an older suspend snapshot below a later
checkpoint. The child is seeded from it, exactly as any fork seeds its child. The range is
therefore the **folded tip**, `max(head, latest snapshot)`, rather than the log's head. Only a
point past every event and every snapshot is out of range.

### D3 — The child's copied prefix must have a shape readers accept

The child's log is the parent's survivors at or below `at`, with its seed at `at`. When event
`at` survives, that is an ordinary fork. When it does not, the child is `[0]` plus its seed if
only the bootstrap survives below `at`. That is ADR 0106's bootstrap-only shape, which every
reader handles. If pinned events survive below `at`, the child would carry its checkpoint above
a non-bootstrap tip. For example, a child `[0, 1:FINDING]` seeded at 2 is gap-free, so
retention's cheap path would fold it from scratch. The tip rule forbids exactly this shape, and
no reader handles it, so the fork is refused (`reason: "checkpoint-above-prefix"`).

We rejected dropping the kept events from such a child, which would make the shape legal: the
child's log would no longer be the parent's prefix, and its findings would silently disappear.

`CompactedForkPointError.forkableFrom` names the lowest sequence from which every position
through the tip is forkable. That is the parent's checkpoint when only the bootstrap survives
below it, otherwise the first event above it, and `null` when no snapshot anchors anything
above the hole. Sequence 0 is always forkable. Only the refusal path reads the whole parent,
and a compacted log is short by construction.

### D4 — The blank id is reserved

`isReservedStream("")` is `true`. Enumerators (retention, recovery, census, compliance, the
read model) therefore skip the stream instead of treating it as an execution. Every runtime
entry point refuses it: `start`, `resume`, `resumeAs`, `cancel`, `fork` (parent and child id)
and `restoreFromState` (the journal also refuses a blank identity). `loadState("")` returns
`null`, and `compact("")` throws. Before this change, `cancel("")` folded the stray events and
appended `EXECUTION_CANCELLED` into the stream, and `resume("")` would have tried to run it.

The remaining writers take a caller's id: `shredSubject`'s `executionIds`, and the raw
`EventStore.append`. They are unchanged, and a caller that names `""` there chooses to.

### D5 — Attribution: what is provable, and what is not

Execution X owns the blank-stream events in `(b, S]` when all four hold:

1. X has a snapshot at `S` whose state carries the blank identity. Only a run seeded from a
   pre-0106 checkpoint writes one, and that run's journal wrote to `""`.
2. The snapshot was taken at a drain barrier (status suspended or terminal, never the running
   cadence checkpoint), so every event the run committed through `S` is durable.
3. `b` is X's next snapshot below `S`, and the blank stream holds every sequence in `(b, S]`.
4. Folding those events onto the snapshot at `b` reproduces the snapshot at `S` exactly
   (canonical JSON, identity aside).

Slots are unique per stream. An event another execution had written first would have failed
X's append, and X's run could not then have reached its barrier at `S`. Condition 4 checks this
independently.

**Not provable:** events above X's last such snapshot. The census lists each such run with its
**candidates**: executions holding a blank snapshot just below it. It never picks one. Several
executions compacted at the same sequence are indistinguishable there. A tampered or re-folded
segment fails condition 4 and falls into this class too.

### D6 — The repair: re-home what is proven, refuse the rest, journal it

`LogLifecycle.blankStreamCensus()` reads. `LogLifecycle.rehomeBlankStream({ apply, assign })`
is a dry run unless `apply: true`. It is exposed as
`loom repair blank-stream <store> [--assign <id>:<from>-<through>,…] [--apply]`.

- A proven segment is appended to X's log **at its own sequences**, in one batch. Each event is
  re-stamped with X's `executionId`, sequence 0's `workflowId` and `id` `<X>-<sequence>`, and
  carries `metadata.rehomedFrom` (its blank-stream id). The result is the log X would have had
  without the bug: compacted at its original checkpoint, with the resumed history above it.
- The repair must leave a shape every reader interprets (ADR 0106 D2). The re-homed events and
  X's own events above them must form one contiguous block up to the tip, with a missing slot
  below it and no snapshot above the new tip. Anything else is refused with a status:
  - `occupied`: X's log already holds another event in the range, or the block would reach
    down to 0 and read as never compacted. A pre-0106 denial written into the checkpoint's slot
    does this.
  - `superseded`: X was compacted again after the fix, so a later checkpoint already folds
    these events, and the never-bugged log would not hold them either.
  - `conflict`: two executions prove the same slot.
- **Operator assignments** (`assign`, `--assign`) cover the unprovable tail when the
  application's own records name its owner. They are still checked. The range must be fully
  present and unclaimed. X must have a snapshot at exactly `from − 1` (the run's seed) and none
  above it, because an execution that moved past the seed abandoned that continuation. The range
  must fold onto the seed contiguously. A range that fails any of these is `invalid`, with the
  reason.
- Each re-homed segment is journaled as `EVENTS_REHOMED { executionId, fromSequence,
  throughSequence, proof, count }` on `__loom_lifecycle__` (EVENT_SCHEMA 1.22.0, pure audit into
  `_lifecycle`). The blank stream itself is left in place: append-only evidence (P9), and what
  makes a re-run idempotent. A slot already holding its `rehomedFrom` twin is done, so a repair
  that stopped halfway finishes the missing slots only.
- Cost: one read of `""`, one snapshot walk per execution bounded by the blank stream's sequence
  range (not the execution's lifetime), and one log read per affected execution.

### ADR 0083 disposition

No second consumer is claimed or needed. This repairs a kernel defect's durable output, adds no
seam and no SPI method, and its one vocabulary addition (`EVENTS_REHOMED`) is a kernel audit
fact beside `EXECUTION_ARCHIVED`/`_DELETED`.

## Consequences

- Every fork of a compacted parent is exact or refused (`compactedFork.test.ts`, run over both
  the native `copyPrefix` path and the event-by-event copy). Forks of a never-compacted parent
  are unchanged, including the no-read fast path at a snapshot on the tip (`fork-timers.test.ts`
  E5). A fork point below the tip that sits exactly on a snapshot now pays one point read of
  that event.
- The blank-stream repair was checked against the real pre-fix build (`d625781`): three
  executions compacted, one resumed three times. It proved and re-homed both suspend-anchored
  segments and listed the completion run as unattributed with its one candidate. The fixed
  runtime then read the execution from its own log.
- `isReservedStream("")` changes what enumerators return for a store holding the blank stream:
  it is no longer listed as an execution.

### Residuals

- An unattributable tail stays in `""` until an operator assigns it. Nothing the bug left
  proves its owner, and the design refuses to guess. Until then its execution reads as parked
  at the gate it passed. Resuming that gate again under the fixed runtime continues the
  execution in its own log (re-running the effects of that stretch), after which the
  assignment is refused as `occupied`.
- Pre-0106 `cancel()` recorded `EXECUTION_CANCELLED` in the right execution but with the blank
  `workflowId` of the folded state. That envelope is not rewritten (there is no update SPI).
  Every reader takes the workflow from sequence 0.
