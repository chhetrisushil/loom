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
counting the window it already reads, so a fork point at or below the log's tip whose window
is whole costs no extra read. The added reads are all off that path. A fork point above the
tip reads the latest snapshot, to bound the range. A fork point below the tip that sits
exactly on a snapshot reads that one event, to check the child's shape (D3). A refusal reads
the parent's log, to name what is forkable. When it fails, `fork` throws
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

`CompactedForkPointError.forkableFrom..forkableThrough` names the span of forkable positions.
It runs from the parent's checkpoint (when only the bootstrap survives below it, otherwise the
first event above it) to its folded tip. For a branch of a compacted parent, which copied the
gap but not the parent's checkpoint, it starts at the branch's lowest snapshot above the gap:
its fork seed, which sequence 0's `metadata.forkSequence` names in one point read. Both are
`null` when no snapshot anchors anything above the hole. Sequence 0 is always forkable. A
compacted log is short by construction, so reading it whole on the refusal path is cheap.

### D4 — The blank id is reserved

`isReservedStream("")` is `true`. Enumerators (retention, recovery, census, compliance, the
read model) therefore skip the stream instead of treating it as an execution. Every runtime
entry point refuses it: `start`, `resume`, `resumeAs`, `cancel`, `fork` (parent and child id)
and `restoreFromState` (the journal also refuses a blank identity). `loadState("")` returns
`null`, and `compact("")` throws. Before this change, `cancel("")` folded the stray events and
appended `EXECUTION_CANCELLED` into the stream, and `resume("")` would have tried to run it.

`shredSubject` refuses a reserved id (`""` or `__loom_*`) among the executions to tombstone.
The SUBJECT may still be `""`: `shredSubject(keys, raw, "", { executionIds: [] })` destroys
the key the blank stream was encrypted under (see D6). The raw `EventStore.append` stays open.
It is the SPI the kernel's own control writers use, so it takes any id.

### D5 — Attribution: what is provable, and what is not

Execution X owns the blank-stream events in `(b, S]` when all four hold:

1. X has snapshots at `b` and at `S` whose states **both** carry the blank identity. Only a run
   seeded from a pre-0106 checkpoint writes one, and that run's journal wrote to `""`. A pre-0106
   **compaction** checkpoint is blank too, but its base is the runtime's own named snapshot. So
   a blank base keeps a checkpoint from claiming a stretch of `""` that another execution wrote
   (review round 1: an execution compacted at gate 2 would otherwise have been handed another
   execution's gate-1→gate-2 run).
2. The snapshot at `S` is suspended or terminal. That is what the runtime's suspend and settle
   checkpoints record, and it keeps a mid-run checkpoint from ending a segment. It is a filter,
   not a proof. A pre-0106 cadence checkpoint fired when its event was COMMITTED, before it was
   durable, and one landing on a suspend has the same status.
3. The blank stream holds every sequence in `(b, S]`.
4. Folding those events onto `b` reproduces `S` exactly (canonical JSON, identity aside). **This
   is the proof**: it covers every timestamp and payload the fold records. When a blank running
   snapshot (a cadence checkpoint, `snapshotEvery`) sits between two such snapshots, the base
   walks down across it, but only while the stream stays contiguous and the fold reproduces
   that snapshot too. Otherwise a cadence checkpoint inside a resumed run would strand the
   events below it forever.

Two executions proving one slot are a `conflict`, and neither is touched. What the proof cannot
separate: two executions whose events are identical in every field the fold reads, one of them
without a snapshot of its own. Re-homing then gives X exactly the history its snapshot already
claims.

**Not provable:** events above X's last such snapshot. The census lists each such run with its
**candidates**: executions holding a blank snapshot just below it. It never picks one. Several
executions compacted at the same sequence are indistinguishable there. A tampered or re-folded
segment fails condition 4 and falls into this class too.

### D6 — The repair: re-home what is proven, refuse the rest, journal it

`LogLifecycle.blankStreamCensus()` reads. `LogLifecycle.rehomeBlankStream({ apply, assign })`
is a dry run unless `apply: true`. It is exposed as
`loom repair blank-stream <store> [--assign <id>:<from>-<through>,…] [--apply]`.

- **Placement.** A proven segment is appended to X's log at its own sequences. Each event is
  re-stamped with X's `executionId`, sequence 0's `workflowId` and `id` `<X>-<sequence>`, and
  carries `metadata.rehomedFrom` (its blank-stream id). The result is the log X would have had
  without the bug: compacted at its original checkpoint, with the resumed history above it.
- **Shape.** The repair must leave a shape every reader interprets (ADR 0106 D2). The re-homed
  events and X's own events above them must form one contiguous block up to the tip, with a
  missing slot below it and no snapshot above the new tip. Anything else is refused with a
  status:
  - `occupied`: X's log already holds another event in the range, or the block would reach
    down to 0 and read as never compacted. A pre-0106 denial in the checkpoint's slot does this.
  - `superseded`: X was compacted again after the fix, so a later checkpoint already folds
    these events, and the never-bugged log would not hold them either.
  - `conflict`: two executions prove the same slot.
- **Operator assignments** (`assign`, `--assign`) cover the unprovable tail when the
  application's own records name its owner. The operator names the execution, and the repair
  checks everything else:
  - the range is fully present in `""` and unclaimed;
  - X holds a **blank** (pre-0106) snapshot at exactly `from − 1`, the run's seed. A healthy
    execution, even one compacted after the fix, has none, so an assignment can never graft a
    stray run onto it (review round 1);
  - nothing of X's sits above that seed, because an execution that moved past it abandoned that
    continuation;
  - the seed is parked at a gate, and the range opens with the resume answering it;
  - the range folds onto the seed contiguously.

  A range that fails any check is `invalid`, with the reason.
- **Applying.** Per execution, **one batch** (`appendBatchOf`) carries every slot its segments
  lack, so a crash never leaves a snapshot above a half-re-homed tip. Before it, the
  execution's tip is re-read and must equal what the census saw, and its sequence 0 must exist.
  **Fencing:** an execution that was ever fenced (a worker, a fenced `TimerService`,
  `recoverAbandoned({ fenced })`, `cancel`) refuses an unfenced append. The repair then takes a
  new fence and writes under it, which also fences out a runner still holding the old one. An
  execution that was never fenced is not given a fence, because every later unfenced write to
  it (the default `TimerService`, say) would then be refused. One failing execution is reported
  in `failed` and does not stop the others.
- **Journaling.** Each re-homed segment is journaled as `EVENTS_REHOMED { executionId,
  fromSequence, throughSequence, proof, count }` on `__loom_lifecycle__` (EVENT_SCHEMA 1.22.0,
  pure audit into `_lifecycle`). Facts are written after the events. A segment whose fact did
  not land (a concurrent lifecycle writer took its slot, the store failed) gets it on the next
  run: one read of the lifecycle stream says which exist. A write conflict is re-read and
  retried, which now covers the retention facts too.
- **Idempotence.** The blank stream itself is left in place: append-only evidence (P9), and
  what makes a re-run idempotent. A slot already holding its `rehomedFrom` twin is done, so a
  repair that stopped halfway finishes the missing slots only.
- **Encryption.** A pre-0106 `EncryptingEventStore` encrypted the stray events under the key
  of subject `""`. Read through the app's stores (`--config`) they decrypt, and re-homing
  re-encrypts them under X's key. Read raw (`--db`), their payloads are ciphertext: the census
  reports `ciphertext: true`, and applying is refused before anything is written.
- **What the repair does not do**, which the command prints after an apply:
  - Read models and projections never saw the re-homed events (the repair has no `onEvent`,
    and a caught-up watermark sits above them), and rows indexed under `""` remain. Purge the
    `""` rows and rebuild them.
  - The blank stream kept as evidence still holds the payloads under subject `""`'s key, which
    outlives X's own erasure. Once nothing is left to re-home, destroy that key:
    `shredSubject(keys, raw, "", { executionIds: [] })` or `keys.destroy("")`.
- **Operating it.** Quiesce the affected executions and pause retention and compaction while it
  runs. The census and the apply are separate reads, and the tip check refuses what moved in
  between rather than racing it.
- **Cost:** one read of `""`, one snapshot walk per execution bounded by the blank stream's
  sequence range (not the execution's lifetime), and one log read per affected execution.

### ADR 0083 disposition

No second consumer is claimed. This repairs a kernel defect's durable output and adds no seam
and no SPI method. Every new or changed public name:

- `CompactedForkPointError` (`reason`, `forkableFrom`, `forkableThrough`), from
  `@loom/workflow-runtime`;
- `LogLifecycle.blankStreamCensus()` and `LogLifecycle.rehomeBlankStream()`;
- `REHOMED_FROM_KEY` and the types `BlankStreamCensus`, `BlankStreamSegment`,
  `BlankSegmentStatus`, `RehomeAssignment`, `RehomeProof`, `UnattributedRun`;
- the `EVENTS_REHOMED` event kind, a kernel audit fact beside `EXECUTION_ARCHIVED`/`_DELETED`;
- the `loom repair blank-stream` command;
- a changed meaning: `isReservedStream("")` is now `true` (`@loom/event-runtime`), and
  `shredSubject` refuses reserved ids among its `executionIds`.

Each one is the operator surface of the repair or the error of the fix. None is vocabulary a
workload asked for.

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
  execution in its own log (re-running the effects of that stretch), after which an assignment
  of the old tail is refused (the execution has moved past its seed).
- An assignment needs the seed to be parked at a gate. A tail a crash re-drive wrote
  (`EXECUTION_RECOVERED` onto a running seed) cannot be assigned. It stays listed.
- Until an operator destroys subject `""`'s key, an encrypted deployment keeps re-homed payloads
  readable under it, even after the owning execution's own erasure (D6).
- Pre-0106 `cancel()` recorded `EXECUTION_CANCELLED` in the right execution but with the blank
  `workflowId` of the folded state. That envelope is not rewritten (there is no update SPI).
  Every reader takes the workflow from sequence 0.
