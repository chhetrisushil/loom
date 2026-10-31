# ADR 0134 — Snapshot pruning: dropping superseded snapshots without losing a checkpoint or a fork point

- Status: **Proposed** (2026-10-31) — implemented in the PR that carries it; accepted on merge
- Date: 2026-10-31
- Found by: GitHub issue #706 (fix 1 of 3). `SnapshotStore` only deletes via `deleteExecution`, so a
  long-lived execution keeps every snapshot it ever took (suspend, fork, and every `snapshotEvery`
  events) until the whole execution is deleted. Storage grows as snapshots × state size.
- Builds on: [ADR 0106](0106-compaction-integrity.md) (the tip rule, the three log shapes, the
  compaction checkpoint), [ADR 0107](0107-compacted-fork-points-and-the-blank-stream.md) (the fork
  exactness rule), [ADR 0055](0055-k10-6-pin-seam-content-gc.md) D6 (the content sweep's snapshot
  coverage), [ADR 0074](0074-storage-scale-out-decorators.md) (every decorator must decide every
  optional SPI method), [ADR 0083](0083-second-consumer-rule.md).
- Placement: **kernel (`@loom/workflow-runtime` `LogLifecycle`)** for the safety rule, plus one
  additive SPI method. **KERNEL_ABI unchanged (1.3.0)**: no syscall changes. **EVENT_SCHEMA
  unchanged**: no event kind, payload or fold changes. **SnapshotStore SPI 1.1.0 → 1.2.0** (additive
  MINOR): optional `pruneSnapshots`. Default OFF: nothing prunes unless an operator or an app's own
  schedule calls `LogLifecycle.pruneSnapshots`.

## Context

A snapshot is a cache over the log: the log is the truth, and a lost snapshot only means a longer
replay. So a superseded snapshot is prunable. Not every snapshot is superseded, and three readers
depend on specific ones:

1. **A compaction checkpoint** (ADR 0106). The events below it were truncated, so it is the ONLY
   record of that state. `compact` itself refuses to run on a gapped log without a snapshot at or
   above the gap (`CompactionCheckpointMissingError`).
2. **A fork point** (ADR 0107). `fork(parent, at)` folds from the nearest snapshot at or below `at`;
   the result is exact iff every event in `(base, at]` survives. Where the log is compacted, an old
   snapshot sitting exactly at `at` is the only thing that serves that point (D2).
3. **The latest snapshot**, which every resume folds on.

Deleting a snapshot changes which one is "nearest" for the fork points it served. That is harmless
only when the next-older base still has a whole event window.

## Decisions

### D1 — One optional SPI method, with exclusive bounds and an explicit keep-set

```ts
pruneSnapshots?(
  executionId: string,
  range: { readonly after: number; readonly before: number },
  keep?: readonly number[]
): Promise<number>; // how many were deleted
```

It deletes the execution's snapshots with `after < sequence < before`, except those whose sequence is in
`keep`. One bounded statement per backend: SQLite `DELETE … AND sequence NOT IN (SELECT value FROM
json_each(?))`, Postgres `DELETE … AND sequence <> ALL($4::bigint[])` over `idx_snapshots_exec`, and a
single slice of the sorted list in memory.

Why this shape:

- **The store applies, the caller decides.** What is safe depends on the LOG (its gap, its shape), which a
  snapshot store cannot see. A store that tried to decide would need an event store. So the method takes
  literal bounds, like `truncatePrefix(executionId, through)` does.
- **Exclusive bounds.** A caller passes the sequence of a snapshot it must keep (the anchor, the K-th
  newest) as the bound itself; an off-by-one cannot delete it. `after: -1` reaches sequence 0.
- **A keep-set** for what the caller pins by sequence (`keepSequences`), instead of splitting a range into
  many calls. It is what the issue asked for, and it costs one bound parameter.
- **Rejected: `pruneBelow(executionId, sequence)`.** It cannot express "keep the checkpoint but delete the
  snapshots above it", which is the common case for a compacted log.
- **Rejected: `listSnapshots` plus a per-id delete.** A per-row loop, and a new enumeration surface (the
  doctor already notes the SPI cannot enumerate) for one consumer.
- Several snapshots can share a sequence (a cadence save and a suspend save); they are deleted or kept
  together. Idempotent; an empty or inverted range deletes nothing.

ADR 0083: the consumer is `LogLifecycle.pruneSnapshots`; the seam is driven by storage growth, which every
long-lived execution has, not by one workload.

### D2 — The operation: `LogLifecycle.pruneSnapshots(executionId, { keepLatest?, keepSequences? })`

An explicit operation beside `compact`, called by an operator or the app's own schedule. **Default off:
the runtime never prunes on its own**, so there is no option to forget and no behaviour change when unused.
We chose this over a `WorkflowRuntimeDeps` cadence option because an automatic prune after a cadence save
would need the log's gap on the hot path (a log read per save, or state about compaction the runtime does
not hold), and because the safety rule needs a full-log view that `compact` already takes. An automatic
policy can call this operation later; nothing in it needs to change. Resolves with the number deleted.

It reads the log once (as `compact` does) and a bounded number of snapshot points: `keepLatest` reads to
find the cutoff, and for a gapped log one read at the gap (a compaction's own checkpoint), or one exact read
of a branch's fork seed, or else a walk down from the tip, which is **O(snapshots above the gap)**, not
bounded by a constant (it runs only when the log has neither). It reads the log twice (the second read,
just before the delete, is D6's guard) and the blank stream's head once. The delete is one statement.
Future work: with no `pinnedEventTypes` configured a gap could be detected from a two-row `readRange`
instead of a full read; not done, because it is not proven equivalent for every log shape ADR 0106
describes (gap-free, gapped, `[0]`).
Over `EncryptingEventStore`/`SealGuardedSnapshotStore` stacks the log read needs the subject's key, so
pruning a shredded execution is expected to fail at that read (a refusal, never a wrong delete).

### D3 — The safety invariant

Let `gap` be the log's highest missing sequence (`highestMissing`, ADR 0106 D2; `-1` when gap-free), and let
the **anchor** be the lowest snapshot at or above `gap` (the compaction checkpoint, or for a branch of a
compacted parent its fork seed). Let `cutoff` be the sequence of the `keepLatest`-th newest snapshot.

**`pruneSnapshots` deletes exactly the snapshots `s` with `anchor < s.sequence < cutoff` (any `s.sequence <
cutoff` for a gap-free log), minus `keepSequences`.** It never deletes:

1. the latest `keepLatest` snapshots (`keepLatest ≥ 1`, so at least the latest);
2. the anchor, and every snapshot at or below it;
3. anything, when the log is `[0]` alone (compacted through its tip: the checkpoint is the latest, the older
   ones are exact fork points below it) or when the log has a gap but no snapshot at or above it (a state
   `compact` itself refuses);
4. anything for a `compactionExempt` execution (a hold also holds its snapshots), or on a store without the
   method.

**Why this preserves every fork point and every fold.**

- *Gap-free log.* Every event survives, so any base gives the same state: `fold(snapshot, suffix) ==
  fold(events)` is the contract of ADR 0022 K10.4. Forking at `at` from an older base, or from nothing,
  returns the same state as before. It is slower, never wrong.
- *Gapped log, `at` at or above the anchor.* Pruned snapshots lie strictly above the anchor, so the new
  nearest base is at or above the anchor, hence at or above `gap`. The window `(base', at]` lies above
  `gap` and every event there survives (the tip rule), so ADR 0107 D1's exactness test passes and the fold
  is the same state.
- *Gapped log, `at` below the anchor.* Nothing at or below the anchor changes, so a fork point that was
  served exactly (a snapshot at `at`, D2 of ADR 0107) or refused is served or refused identically.
- *Resume* folds on the latest snapshot, which is kept, so it is unchanged. The replay inspector re-anchors
  on the nearest snapshot at or above the gap (ADR 0106 D4); the anchor is kept.
- *Compaction after pruning* needs a base at or above the gap (`CompactionCheckpointMissingError`); the
  anchor is kept, and the next checkpoint is saved by `compact` itself.

The tests assert fork equivalence at every point of the folded range before and after pruning (gap-free and
compacted), that a resume after pruning re-runs no step (effect call counts), that the checkpoint survives,
and a negative control: the same delete WITHOUT the anchor bound makes forks differ, so the guard is shown
to fire. Further tests cover a branch of a compacted parent (the fork seed above the gap is the anchor,
not the gap) and a gapped log with no snapshot at its gap (the walk-down); both fail under the mutation
`after = gap`.

**Exception: `workflowVersion`.** A snapshot carries the flow version it was taken under; no event records
it (sequence 0's envelope has `workflowId` only, and the start payload carries `flowHash`/`codeHash`, not
the version; the fold takes it from its seed). A fork with no snapshot at or below `at` folds from 0 with the
version registered NOW. So if a flow was re-registered at a new version after the snapshots were taken,
pruning can change a fork's `state.workflowVersion` (never any other field) from the old version to the
current one, at fork points that used to be served by a pruned snapshot. The same already happens without
pruning wherever no snapshot exists at or below `at`. We did not fix it here: recording the version needs an
event or payload change (EVENT_SCHEMA), and keeping "the oldest snapshot of each version" needs an
enumeration the SPI does not have. The kept snapshots (latest, anchor and below) still carry their version.
A test pins this exactly.

### D4 — Decorators

`TenantScopedSnapshotStore` scopes the id (a tenant prunes only its own). `EncryptingSnapshotStore`,
`ContentTouchingSnapshotStore` and the kernel's `SealGuardedSnapshotStore` **forward**: a range delete reads
and returns no state, so there is no key to open, no plaintext to produce and nothing to guard. The
`DecoratorPlan` type made each a compile error until it decided, and the decorator conformance kit's
`OPTIONAL_SNAPSHOT_STORE_METHODS` now lists the method.

### D5 — Content refs cited only by a pruned snapshot

`sweepUnpinnedContent` (ADR 0055 D6) reads, per execution, only (a) the **latest** snapshot and (b) for a
compacted log the **checkpoint**: the lowest snapshot in `[gap, tip]`, or the latest for a `[0]` log. Those
are exactly what D3 never prunes. Every other snapshot's refs were never pinned by the sweep, so deleting
such a snapshot changes no sweep decision: a blob cited only by it is unreferenced before and after, and
reclaimable only after the sweep's `olderThanMs` margin, exactly as before. `ContentTouchingSnapshotStore`
therefore does not touch on a prune (a delete cites nothing). The same holds for the snapshots below the gap
that D3 keeps: they stay, though the sweep does not count their refs (an existing property, not changed here).

### D6 — Accepted residuals

- **A fork after pruning may fold more events** (a longer replay), by design; the cost moves from storage to
  the rare old-point fork.
- **A concurrent `fork` racing the prune** reads whichever snapshot set it sees; either is correct (a missing
  older base only widens the window the fold reads).
- **A concurrent `compact` racing the prune is NOT harmless** (found in review). Prune reads a gap-free log
  and decides `after = -1`; `compact` then saves a checkpoint `C < before` and truncates through `C`; the
  delete removes `C`. State is not lost (the log is the truth for what survives and the latest snapshot is
  kept) but forks at `1..C`, which a sequential order serves from snapshots, now throw
  `CompactedForkPointError`. A completed execution triggers it (latest snapshot at the terminal `T`, compact
  checkpoint at `T-1`, ADR 0116 Q3). So: (a) `compact` and `pruneSnapshots` are serialized per execution
  inside `LogLifecycle` (an in-process promise chain per execution id; the entry is removed when the chain
  drains, so the map is bounded by the executions in flight); (b) after the snapshot reads, prune re-reads the
  log and **deletes nothing (resolves `0`) if the gap moved**, which narrows the cross-process window to the
  re-read-to-delete gap. It does not close it. **Operators must not run `compact` and `pruneSnapshots` on one
  execution from different processes at once**; a retry after an aborted prune is always safe.
- **The pre-0106 blank stream.** Pruning refuses, with `BlankStreamUnrepairedError` and before any delete,
  while `loom repair blank-stream` still has work: the blank-identity snapshots of an execution are the proof of
  whose the stray events in `""` are (ADR 0107 D5). "Repaired" is not "the stream is empty": the repair leaves
  `""` in place as evidence (ADR 0107), so the check is a `head` read of `""` (nothing there: proceed, one read)
  and only if there is a stream the census, refusing while any segment is `rehomable` or any run is
  unattributed. Segments in a terminal state (`rehomed`, `occupied`, `superseded`, `conflict`, `invalid`) do
  not block. The census enumerates every execution, but only a store that still has a blank stream pays it.
- **Bounds are safe integers.** `keepSequences` entries and the computed bounds must be safe integers
  (backends disagree otherwise); `pruneSnapshots` throws `RangeError` before any delete.

### D7 — Deferred: delta snapshots (fix 2) and Merkle state (fix 3)

Issue #706 lists delta snapshots (a base plus JSON patches re-based every K) and Merkle-ized state with
structural sharing as later work. Both **deferred**, each needing its own decision:

- **Deltas** change what a `Snapshot` IS: `loadAt` would have to reconstruct, a pruned base would orphan its
  patches, and the decorators that seal or touch a snapshot (`EncryptingSnapshotStore` with `sealState`,
  `ContentTouchingSnapshotStore`) would each need a rule for a patch. That is a SnapshotStore SPI MAJOR or a
  new store kind, plus an AAD/crypto decision. Pruning (this ADR) is a prerequisite either way: a delta chain
  still needs a way to drop what is superseded.
- **Merkle state** changes the serialized state and the hash-chain interplay (ADR 0037) and needs a canonical
  node format. It is a larger bet than the storage problem warrants until pruning has been measured.

Pruning alone bounds retained snapshots to `keepLatest` plus the compaction anchor and below, which removes
the quadratic term the issue describes. Revisit deltas only if the per-snapshot size itself, not the count,
becomes the cost.

## Consequences

- `SNAPSHOT_STORE_SPI_VERSION` 1.1.0 → **1.2.0**. `InMemoryAsyncSnapshotStore`, `SqliteSnapshotStore` and
  `PostgresSnapshotStore` implement it; the conformance kit checks the exclusive range, the keep-set,
  per-execution isolation, idempotence and the empty/inverted range (and `PostgresSnapshotStore` is held to
  the same cases in its own suite).
- Existing deployments change nothing until something calls `LogLifecycle.pruneSnapshots`. A store written
  against SPI 1.1.0 keeps working: `pruneSnapshots` returns `0` for it.
- No automatic cadence is shipped. If one is wanted it is a thin scheduler over the same operation; if it
  runs after a cadence save it must be fire-and-forget and report through `onStorageError`.
