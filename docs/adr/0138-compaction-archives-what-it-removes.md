# ADR 0138 — Compaction archives what it removes, and the fold stops copying settled steps' inputs

- Status: **Proposed** (2026-10-31) — implemented in the PR that carries it; accepted on merge
- Date: 2026-10-31
- Found by: GitHub issue #725, from the item 4 investigation of #721 (an uncompacted `agentLoop$` keeps every
  turn's full model input in the folded state: 3.54 MB at 50 turns, 54.9 MB at 200).
- Builds on: [ADR 0106](0106-compaction-integrity.md) (compaction, the tip rule), [ADR 0107](0107-compacted-fork-points-and-the-blank-stream.md)
  (fork points), [ADR 0130](0130-sealed-payload-delivery-guard.md) D8 (a checkpoint must be sealed under the
  log's KeyStore), [ADR 0055](0055-k10-6-pin-seam-content-gc.md) (the content sweep), and the snapshot-growth work
  of #706 ([ADR 0134](0134-snapshot-pruning.md), [ADR 0136](0136-snapshot-lz4-compression.md)).
- Owner rulings (2026-10-31): auditability stays intact (every fact the log held stays recoverable, byte-exact);
  nothing may slow resume; **nothing in loom is pruned or deleted** (compaction MOVES events); compaction
  REFUSES without an archive; the archive is a DEDICATED SPI (not content-store refs); the audit read is an
  explicit `readArchived` and `readRange` never touches the archive.
- Version impact: **new SPI** `ARCHIVE_STORE_SPI_VERSION` **1.0.0** (`@loom/event-runtime`). Part A changes no
  `EVENT_SCHEMA`, `KERNEL_ABI`, `WIRE_ABI`, `EVENT_STORE_SPI` or `SNAPSHOT_STORE_SPI`. Part B (the fold) bumps
  `EVENT_SCHEMA` MINOR (folded bytes change, payloads do not; see D8).
- Placement: kernel half (`LogLifecycle`, the fold) + a new storage SPI with three 1P backends and a sealing
  decorator. Reviewed as kernel + storage + schema migration + security boundary.

## Context

Two facts met in #721.

1. **The fold keeps what nothing reads.** `STEP_STARTED` copies `input` into the frame and every later
   transition copies it forward. Replay, divergence checks, forks, sealed replay, the in-doubt guard and the CLI
   read `status`, `output`, `attempts`, `firstSeq` and `scope`; auditors read inputs from the LOG. A completed
   frame's `input` is dead weight, and it makes state O(turns^2).
2. **Compaction already loses events.** K10.4 truncates the prefix `(0..c]` after a checkpoint. The checkpoint
   keeps the FOLD, not the events: envelopes, timestamps, metadata and unpinned app events are gone. A
   compacted step's `input` survives only as the fold's incidental copy, so dropping it from the fold
   (fact 1) would lose the last copy. That is an audit gap today, independent of the fold change, and the fold
   change would widen it.

The owner's rulings close both: make the fold linear AND make compaction non-lossy.

## Part A — Decisions (archive)

### D1 — A dedicated `ArchiveStore` SPI; compaction moves, never deletes

```ts
interface ArchiveSegment { from; through; count; digest; envelopes; sealed? }
interface ArchiveStore {
  append(executionId, segment): Promise<void>;
  headers(executionId): Promise<{from, through, count, digest}[]>;   // cheap, no bodies
  read(executionId, range?: {from?, through?}): Promise<ArchiveSegment[]>; // whole overlapping segments
  deleteExecution?(executionId): Promise<void>;                      // only the existing whole-execution delete
  close(): Promise<void>;
}
```

A segment is the exact envelopes one compaction removed (as `EventStore.read` returned them), `[from, through]`
being its range (`through` is the checkpoint's sequence) and `digest` the SHA-256 of their canonical JSON
(sorted keys, so a backend that reorders object keys, as Postgres `jsonb` would, still agrees; the Postgres
column is `TEXT` anyway, so the bytes stored are the bytes written). `append` is append-only: a segment must
start after the last one's `through`, an EXACT repeat (same `from`, `through`, `digest`) is a no-op, anything
else rejects with `ArchiveConflictError` and writes nothing. There is no per-segment delete.

Backends: in-memory (`InMemoryArchiveStore`, browser-safe subpath), SQLite (`archive_segments`, primary key
`(execution_id, from_seq)`, its own `archive.db` in the preset), Postgres (the same table in the shared
schema, `CREATE TABLE IF NOT EXISTS` in the advisory-locked migration: a new table, no lock on later boots, no
ALTER). `runArchiveStoreConformance` is the kit.

*Why not content-store refs.* The content store dedupes by hash across owners (ADR 0120), which defeats
per-subject erasure, and its sweeps (`sweepUnpinnedContent`) are exactly what the archive must never be
subject to. A dedicated SPI has no sweep and one erasure story.

### D2 — `LogLifecycle.compact` archives before it truncates, and the crash order is archive-first

Order inside `compact`: guards, fold, **archive the removed envelopes**, save the checkpoint, truncate.

The removed set is every event with `1 <= sequence <= through` that `truncatePrefix(Keeping)` removes (events of
a kept kind stay in the log and are not archived). The segment starts right after the archive's last `through`
(or at the first removed sequence), so successive compactions abut: no gap, no overlap.

The archive and the log are different stores in general, so they cannot share a transaction, and the SPI does
not try to (no distributed commit). The crash window is therefore defined, not avoided:

- crash after `archive.append`, before truncate: the events are in the log AND in the archive (a duplicate).
  The checkpoint may or may not have been saved. **Never a gap.**
- a retry (or a later compaction) finds events at or below the archive's last `through`: it verifies each is
  in the archive, byte-for-byte (digest-checked, fail closed with `ArchiveGapError` if one is not), appends only
  the part above it, and truncates. An exact repeat is idempotent.
- `readWithArchive` (the stitched audit read) keeps one entry per sequence, so the duplicate is invisible.

A kind an earlier compaction KEPT in the log (pinned) and a later compaction releases (the app dropped it from
`pinnedEventTypes`) sits below the archive's last segment and is not in it: `ArchiveGapError`, nothing
truncated. Keep `pinnedEventTypes` as it was for such executions. (This is the only way compaction can refuse a
well-formed log.)

### D3 — Refuse without an archive (typed, fail closed, no transition)

`compact` throws `CompactionArchiveRequiredError` (naming the fix) when no `compactionArchive` is configured.
Nothing is read, archived, checkpointed or truncated. No transition release: the owner ruled it. Compaction is
already explicit and opt-in, but this changes what `compact()` needs, so it is a behaviour change for existing
callers and is called out in the CHANGELOG. `compactionExempt`/`pinned` executions still return `null`, as
before. The refusal comes after the existing ADR 0022/0130 snapshot guards (their typed errors keep priority).

Wiring so existing apps get a working default or a clear refusal:

- `defineConfig({ storage: { kind: "memory" } })`: an in-memory archive.
- `sqliteStorage()` / `postgresStorage()`: their own archive store (`archive.db` / the `archive_segments` table).
- `storage: { kind: "custom", archiveStore }` or `retention.compactionArchive`: explicit. A custom storage with
  an IN-MEMORY event store gets an in-memory archive; a DURABLE one with no archive gets none, so `compact`
  refuses instead of archiving into a volatile store that a restart would forget.
- `LogLifecycle` option `compactionArchive` (distinct from `archive`, the retention copy of a whole execution).
- `loom retention run --config` hands the app's compaction archive to the lifecycle.

### D4 — The erasure boundary: an encrypting event store needs the archive under the SAME KeyStore

Mirror of ADR 0130 D8. When the event store seals payloads (or exposes a `KeyStore`), `compact` requires the
archive to report `sealsSegments === true` AND share the event store's `KeyStore` by identity, else
`PlaintextArchiveError` (`not-sealed` | `keys-not-shared`), before anything moves. `EncryptingArchiveStore`
(`@loom/plugin-crypto`) seals each segment's envelopes as ONE AES-GCM envelope under the subject key (default:
the executionId, as the event store), bound by AAD to `executionId|from|through`. In the clear: the index
fields (`from`, `through`, `count`, `digest`) and the workflow id the subject resolves from; the digest is over
the PLAINTEXT, which is high-entropy event JSON (ids, timestamps), so it reveals nothing guessable. A shred
destroys the key: `readArchived` then throws `PayloadShreddedError` when the key store proves destruction
(`KeyUnavailableError` when this node merely lacks the key). There is NO `allowPlaintextCheckpoints`-style
escape hatch for the archive: a plaintext copy of an erased subject's log is not something to opt into by
accident.

### D5 — Reads: `readArchived` is explicit; `readRange` and the resume path never touch the archive

`LogLifecycle.readArchived(executionId, range?)` returns the moved events in sequence order, each segment
verified against its recorded digest (`ArchiveDigestError` on mismatch: the archive is evidence, not a cache).
`readWithArchive` stitches archive and log (one entry per sequence). `archiveHeaders` is the cheap index.
`EventStore.readRange`, `read`, replay, resume, fork, sealed replay and every sweep never read the archive;
`WorkflowRuntime` does not even hold a reference to one. Resume stays one read of the latest snapshot plus a
short tail.

*The checkpoint's archive record.* The plan asked the checkpoint to record `{archive:{from, through, count,
digest}}`. The `Snapshot` row has no such field, and adding one means a `SnapshotStore` SPI bump and a column
in every backend and decorator for a fact the archive already holds: the segment's `through` IS the
checkpoint's sequence, and its header carries `from`, `count` and `digest`. The link is therefore by
`(executionId, through == snapshot.sequence)`, readable with `archiveHeaders`. If the owner wants the record
inside the snapshot, that is a SnapshotStore SPI 1.3.0 (open question).

### D6 — The content sweep scans the archive, and the archive is never swept

A ref only an archived event cites (a step input after Part B, an old finding) is cited THERE and nowhere
else. `sweepUnpinnedContent({ archiveStores })` pins every ref cited by an archived envelope for as long as the
archive holds it; without it, an erasing orphan pass erases blobs the recoverable history still names (a
test pins this). The archive itself is never enumerated, aged or pruned by any sweep, and
`applyRetention` deletes its segments only on the plain-delete path (no retention archive): with a retention
archive configured the execution is being KEPT, and its compacted history stays readable.

### D7 — Audit hash chains verify across a compaction

`hashChainedEventStore(inner, { allowCompaction: true })` (OFF by default; the ADR 0037 refusal stands
otherwise) forwards `truncatePrefix(Keeping)`, and `verifyChain(id, { archived })` verifies the chain over
`archived ∪ log` (`LogLifecycle.readArchived`). A plain `verifyChain(id)` of a compacted log reports the break
truthfully, rather than a pass.

## Part B — Decisions (fold)

### D8 — The fold drops `input` from settled frames

`STEP_COMPLETED`, `STEP_FAILED` and `STEP_CANCELLED` stop copying `input` into the frame. `STEP_STARTED` and
`STEP_RETRYING` keep it, so an operator still sees what is in flight. `normalizeSnapshotState` strips `input`
from settled frames in one O(frames) pass, so `fold(snapshot, tail) == fold(events)` holds for snapshots
written before this change. EVENT_SCHEMA is bumped by a MINOR with the documented legacy exception (the 1.24.0
precedent): payloads are unchanged, the folded bytes are not, and a mixed fleet is harmless (an older node
re-adds an input to frames it settles; nobody reads it; the next normalize strips it). It is not a behaviour
change for any reader of the fold, so no flag. KERNEL_ABI, WIRE_ABI and the snapshot SPI are unchanged.

*Why this is safe only with Part A.* Dropping the input from the fold removes the checkpoint's incidental copy
of compacted inputs. With Part A the archive already holds the exact `STEP_STARTED` events, so nothing is lost.
**Part B must not merge before Part A.**

Surfaces that showed a completed step's input from the fold (the wire `stateView`, `executionFromState`, the
inspector's state pane, `ReplayInspector.framesTouched`, user `Scorer`s) now show it only for in-flight
frames; the input of a completed step is read from the log (or `readArchived`), which the inspector timeline
already does. Documented in the kernel spec and the inspector docs.

## Evidence

- `archive ∪ surviving log == original log`, byte-exact, on in-memory, SQLite and Postgres, across two
  successive compactions (`compactionArchive.test.ts`), plus the conformance kit on every backend and the
  sealing decorator.
- A hash chain verifies across a compaction via `readArchived`; a forged or dropped archived event breaks it.
- A crypto-shred makes the archived segment unreadable; a plaintext or foreign-keyed archive is refused.
- Refusal without an archive, the crash order, and the pinned-kind gap are tested.
- Mutation checks (refusal, digest check, fold drop, normalize strip) are listed in the PR.
- Size and resume time at 50 and 200 turns: `foldedInputs.perf.test.ts` (`pnpm test:perf`).

## Consequences

- Compaction now needs an archive, and the archive grows by exactly what the log lost. Storage is moved, not
  saved, by compaction; the saving is in the HOT path (the log and the snapshot resume reads).
- Operators must size and back up the archive like the log. `loom retention` removes an execution's segments
  with the execution (the existing explicit delete), never otherwise.
- The `archive_segments` table is created on the next boot of any Postgres store (a new table, idempotent).

## Open questions

1. Record `{archive:{...}}` on the snapshot itself (SnapshotStore SPI 1.3.0), or keep the link by `through`?
2. Tenant scoping: `TenantScopedEventStore` prefixes execution ids; the archive is keyed by the id the
   lifecycle is given. A multi-tenant host that compacts through a tenant-scoped store should scope the archive
   the same way. A `TenantScopedArchiveStore` is not shipped here.
3. `loom doctor` does not yet check that an encrypting deployment's archive is sealed (the refusal at compact
   time is the guard).
