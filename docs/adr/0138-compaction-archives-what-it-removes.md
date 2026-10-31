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
- Version impact: **new SPI** `ARCHIVE_STORE_SPI_VERSION` **1.0.0** (`@loom/event-runtime`; unreleased, so the review round's shape changes - `incarnation` / `kind` on every header and `listExecutions` - are part of 1.0.0). Part A changes no
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

## Review round (2026-10-31) - decisions D9-D16

An adversarial review of the first cut found four ways an owner ruling (AUDITABILITY INTACT, resume never
reads the archive, nothing pruned, fail closed) could still be broken. Each is a decision here.

### D9 - the erasing orphan sweep fails closed without the archive (B1)

An erasing `reclaimOrphans` pass that scans a compacted log (a gap below its tip, or only its bootstrap left
beside a checkpoint) and was not given `archiveStores` throws `ArchiveStoresRequiredError` before it erases
anything (mirror of the `truncatePrefix` -> `snapshotStores` refusal). `archiveStores: []` is the operator's
explicit "no archive exists" (logs compacted before this ADR); a dry run is exempt. The archive is
ENUMERATED (`ArchiveStore.listExecutions`, D15), not walked per log, so segments whose log is gone still pin
their blobs. A segment still sealed when read (`count > 0`, no envelopes: the RAW inner store of an
`EncryptingArchiveStore`) throws `SealedArchiveScanError` on an erasing pass. `loom sweep content`: under
`--config` the app's compaction archive is scanned; on `--db` the default is `archive.db` beside the events
db, `--compaction-archive <path>` names one (a missing file is refused, not created), and
`--no-compaction-archive` is the explicit statement that none exists. `loom retention run` now hands the
app's retention archive to the lifecycle (B3: it used to take the plain-delete branch and delete the
compaction segments of an execution it was KEEPING).

### D10 - a log compacted BEFORE the archive existed keeps its settled inputs: the legacy segment (B2)

Such an execution's only copy of the settled steps' inputs is the old checkpoint row, and the next checkpoint
is normalized (inputs stripped). So the first post-0138 compaction of a gapped log with no archived history
FIRST appends one typed segment (`kind: "legacy-checkpoint"`, range `[first missing .. gap]`) holding the
anchor checkpoint (the lowest snapshot at or above the gap) byte-exact, as a synthetic
`ARCHIVE_LEGACY_CHECKPOINT` envelope so every backend and the sealing decorator carry it unchanged. The fact
is therefore recoverable (`LogLifecycle.readLegacyCheckpoints`) without depending on GC configuration or on
`pruneSnapshots`. The events themselves were removed before the archive existed and are NOT recoverable as
events, and the audit reads say so: `archiveCoverage(id)` lists every range neither the archive nor the log
holds (`why: "legacy" | "missing"`), and `readArchived` / `readWithArchive` throw `ArchiveIncompleteError`
for a range that includes one unless `{ allowIncomplete: true }` (never a silent hole). The legacy segment is
the Art. 15/20 export's `legacyCheckpoints`.

### D11 - segments are bound to the incarnation of their log (H2)

A segment header carries `incarnation`: the `segmentDigest` of the log's bootstrap envelope (sequence 0,
kept by every compaction; the envelope id is `<executionId>-0` and says nothing). `ArchiveStore.append`
(`classifyAppend`) refuses a segment of another incarnation with `ArchiveIncarnationError`, and `compact` and
the audit reads compare the log's bootstrap with the headers, so a REUSED execution id never inherits the
previous run's archive and its `readArchived` never mixes the two runs; the error names the reuse. Two runs
with byte-identical bootstrap envelopes (same input, same millisecond) are not told apart here; their later
events then disagree, which the compaction (`ArchiveGapError`) and the byte-compared stitch (D13) catch. On the
plain-delete retention path the segments are now deleted BEFORE the log (a crash leaves the execution
findable for the retry, never segments a reused id could meet).

### D12 - tenant scoping (H3)

`TenantScopedArchiveStore` follows the other `TenantScoped*` decorators (key prefix, `listExecutions`
confined to the tenant, sealing markers forwarded). Both tenant-scoped stores expose `tenantScope`;
`compact` refuses (`ArchiveTenantMismatchError`) any pairing whose scopes differ, including a scoped log with
a shared archive, so tenants cannot read each other's history nor delete it on the plain-delete path.

### D13 - duplicates are compared byte-exact (M2)

The crash window leaves a sequence in both the archive and the log. `readWithArchive` and
`verifyChain(id, { archived })` compare the two copies and report a difference (`ArchiveLogMismatchError`; a
chain break at that sequence) instead of silently preferring the log's. The chained store with
`allowCompaction` never removes the chain head (the log's tip) in `truncatePrefix(Keeping)`: a restarted
writer derives its `prevHash` from the last surviving event, and compacting through the tip used to leave
`[0]` (H1); the tip is a duplicate of the archive's last event, which D13 compares.

### D14 - configuration, erasure subject, scaffold (M3, M4, M5)

`defineConfig` warns at boot when a durable custom storage has no archive, and wraps the archive in
`EncryptingArchiveStore` (same KeyStore, same `subjectOf`) when the event store encrypts (as it does for
snapshots), for both `storage.archiveStore` and `durability.retention.compactionArchive`. The guard also
compares the erasure SUBJECT mapping by identity (`EncryptingEventStore.subjectOf` /
`EncryptingArchiveStore.subjectOf`, both default to the shared `defaultSubjectOf`):
`PlaintextArchiveError('subject-mismatch')`. The `store` scaffold emits an `ArchiveStore` and wires
`runArchiveStoreConformance`; a fitness test asserts that every SPI the scaffold claims it covers is emitted.
`exportSubject` takes the lifecycle (`archive`) so Art. 15/20 exports include archived events (M1).

### D15 - `ArchiveStore.listExecutions` (M6) and JSON-normalized digests (L1)

`listExecutions({cursor, limit})` is keyset-paged in code point order like `EventStore.listExecutionsPage`.
`segmentDigest` digests the JSON round trip of the envelopes (a `Date` or `toJSON` value digests as what any
JSON store returns, so a durable backend never raises a false `ArchiveDigestError`); a value that cannot be
JSON (circular, BigInt, unbounded nesting) is `ArchiveUnserializableError`, not a bare `TypeError`.

### D16 - accepted residual: plaintext digests (L2)

The segment `digest` and the `incarnation` are SHA-256 of PLAINTEXT, stored in the clear beside a sealed
segment. After a crypto-shred they remain. They are hashes of high-entropy event JSON (ids, millisecond
timestamps), so they confirm a guess only for an attacker who already holds the whole event; this is accepted
(and a keyed digest would make a shredded archive unverifiable, which defeats the point of recording it).

## Second review round (2026-10-31) - decisions D17-D23

A re-review found that the first round's tenant guard failed OPEN, that the Art. 15/20 export dropped gaps
silently, and that `archiveStores: []` silenced a refusal by bare assertion. Each is a decision here.

### D17 - the tenant guard fails closed (re-review blocker 1)

`tenantScopeOf` read `.tenantScope` / `.inner` only, and `hashChainedEventStore` (a closure-built decorator)
exposed neither, so `hashChain(TenantScoped(acme))` + an UNSCOPED archive compacted and mixed tenants. Three
layers now, none depending on the others:

1. **Markers are forwarded uniformly.** `installOptional` already carried the encryption markers up; the one
   helper it calls, `forwardStoreMarkers(target, inner)` (`@loom/event-runtime`), now also carries
   `tenantScope` and records `target` as wrapping `inner` (`decoratedInnerOf`, a WeakMap). Every decorator
   routes through it: `EncryptingEventStore`, `EncryptingSnapshotStore`, `EncryptingArchiveStore`,
   `ContentResolvingEventStore`, `ContentTouchingSnapshotStore`, `CoalescingEventStore`, `ProfilingEventStore`,
   `ProfilingSnapshotStore`, `SealGuardedEventStore`, `SealGuardedSnapshotStore`, `hashChainedEventStore`,
   `faultInjectingStore`, `crashingEventStore`, `TenantScopedSnapshotStore`; `ShardedEventStore` carries the
   marker when every shard has the SAME scope (shards that disagree get a scope no archive can match, so the
   guard refuses); `TenantScopedEventStore` / `TenantScopedArchiveStore` ARE the marker.
2. **The walk no longer trusts a decorator's shape.** `tenantScopeOf` follows `tenantScope`, then the recorded
   wrapped store, then a visible `inner`, so a layer that hides its inner store AND forgets the marker still
   resolves as long as it used the helper.
3. **The tenant can be declared.** `new LogLifecycle(..., { tenant })` / `durability.retention.tenant`: when
   set, `compact` requires the event store AND the archive to both report exactly that scope and refuses
   (`ArchiveTenantMismatchError`, naming the declared tenant) when either does not - including a store stack
   whose scope cannot be seen. This is the one check that does not depend on every layer forwarding a marker,
   so a custom third-party decorator that bypasses the helper is caught for every multi-tenant deployment that
   declares its tenant. Undeclared, a bypassing wrapper is indistinguishable from a plain single-tenant store
   (an unscoped store with no wrappers must keep working); that residual is documented, not hidden.

A fitness test keeps the set closed: the decorator conformance kit (`runEventStoreDecoratorConformance`,
`runSnapshotStoreDecoratorConformance`, and the new `runArchiveStoreDecoratorConformance`) asserts that every
decorator keeps the `tenantScope` and `keys` markers of the store it wraps, and
`packages/spec/src/decoratorConformance.test.ts` discovers EVERY class that implements `EventStore`,
`SnapshotStore` or `ArchiveStore` over an inner store and fails unless some test runs the kit on it - so a
future decorator cannot reopen this.

### D18 - the Art. 15/20 export reports every gap (re-review blocker 2)

`exportSubject({ archive })` used `readWithArchive(id, { allowIncomplete: true })` and so dropped a range the
archive could not return without saying so. Each execution in the export now carries `unarchived:
UnarchivedRange[]` (`LogLifecycle.archiveCoverage`: `{ from, through, why }`), `[]` for a complete log. A caller
(or the data subject) sees every gap; the `events` / `state` of an execution with a non-empty list are
incomplete for those ranges and say so. `archive.archiveCoverage` is a required member of the option type. The
field is absent only for an execution read through the crypto-shred erasure window (its log is unreadable by
design).

### D19 - `archiveStores: []` is checked, not trusted (re-review medium 3)

> **Superseded in part by D24 (third round):** the mark no longer decides which logs are checked.

The sweep (D9) took `[]` as "no archive exists" on the operator's word. The word can be wrong: a wiped, wrong
or forgotten archive over a log that WAS archived. Now an archiving compaction marks its checkpoint (D21) and an
ERASING pass requires, for every scanned log whose checkpoint carries the mark, that the given archives'
headers cover the log's removed range (events or `legacy-checkpoint` segments), else `ArchiveStoresRequiredError`
(`reason: "uncovered"`, naming the executions) before anything is erased. `[]` remains valid over logs whose
checkpoint is unmarked: the genuinely pre-0138 ones (and fork seeds). The CLI additionally refuses
`--no-compaction-archive` when an `archive.db` sits beside `--db` (the filesystem contradicts the flag).

### D20 - re-compacting with nothing new is a no-op (re-review low 4)

A hash-chained log keeps its tip (D13), so a compaction through the tip leaves `[0, tip]`. A second `compact`
re-derived the same range, re-read the archive and saved an identical checkpoint on every call. When the only
removable event is the tip, a checkpoint at that sequence exists and the archive already covers it, `compact`
now returns `null` without touching the archive's bodies or the snapshot store.

### D21 - wiped archive vs pre-0138 log (re-review low 5)

An empty archive beside a gap used to be indistinguishable from a log compacted before the archive existed.
An archiving compaction now writes its checkpoint with an id carrying `COMPACTION_CHECKPOINT_ID_PREFIX`
(`ckpt-0138-`, `@loom/snapshot-runtime`; no schema change, the id is opaque to every store). `archiveCoverage`
labels an uncovered range `why: "missing"` (an archive loss to investigate) when the checkpoint at the log's
extent carries the mark, and `why: "legacy"` when it does not (compacted before the archive existed; only the
folded checkpoint remains). **Limit, stated:** the mark is read back through the snapshot store, which may
return a different snapshot of the same sequence on a tie (the runtime's own suspend checkpoint shares the
compaction's sequence) or none (pruned), and then the range reads `legacy`. It is evidence, not proof; a
caller that must be certain compares the archive's headers against its own backup.

### D22 - which store reads the archive (re-review low 6)

The `incarnation` (D11) is the digest of the bootstrap envelope AS THE READING STORE PRESENTS IT. Read archives
(`readArchived`, `readWithArchive`, `archiveCoverage`) through the same decorated event-store stack the
compaction used (or one that presents the same bootstrap bytes: the sealing store decrypts to the same
envelope, a transform that rewrites payloads does not). A different view reads as a foreign incarnation and is
refused (`ArchiveIncarnationError`), never silently mixed.

### D23 - conformance paging order (re-review low 7)

`runArchiveStoreConformance` asserted paging order with the JS default `sort()` (UTF-16 code units), which
disagrees with the SPI's CODE POINT order for ids above U+D800. It now compares with `compareExecutionIds`,
and a new case lists astral-character ids so an implementation that sorts by code unit fails.

## Third review round (2026-10-31) - decisions D24-D27

### D24 - an erase is never gated by a heuristic: coverage is checked for EVERY compacted log (supersedes D19's mark gate)

D19 ran the erasing sweep's coverage check only when the checkpoint it picked carried the `ckpt-0138-` id
mark. The mark can be lost: the checkpoint at the gap pruned or replaced and a later ulid snapshot picked, or a
fork child whose lowest snapshot is an unmarked fork seed. Then `archiveStores: []`, or an archive missing a
segment, let the pass erase blobs only archived history cites. A heuristic must not gate an ERASE. Now, in an
erasing pass (`reclaimOrphans` and not `dryRun`), for every scanned log with a gap (and every log compacted
to its tip) the removed range - the log's missing sequences, whatever its checkpoint is called - must be
covered by the given archives' headers (events or `legacy-checkpoint` segments; the headers carry
`from`/`through`, so the "archived through" fact lives in the archive and pruning cannot lose it), else
`ArchiveStoresRequiredError` (`reason: "uncovered"`, naming the executions) before anything is erased.
`archiveStores: []` alone therefore no longer suffices for a gapped log.

The one way past it, for logs whose compacted history is ALREADY GONE (compacted before ADR 0138 and never
re-compacted, so no archive exists), is the explicit, separately named opt-in
`acknowledgeUnarchivedLogs: true` (CLI `--acknowledge-unarchived`): "these logs' compacted history is already
gone; erasing their orphan blobs is accepted." The sweep result lists the executions it applied to in
`unarchivedAcknowledged` (the CLI prints them). The mark is kept for REPORTING only (`archiveCoverage`'s
`why: "missing" | "legacy"` labels, D21); no erase decision reads it. A dry run is exempt.

**Fork children (decision).** A child forked from a compacted parent copies the parent's gap, but an archive is
keyed per execution and the child's envelopes do not name the parent, so the child's removed range is covered
by NO archive header. Consulting the parent's coverage would need a parent id the log does not carry, i.e. a
guess. Fail closed: a sweep over a fork child of a compacted parent needs the acknowledgment (the parent's
archive, passed in `archiveStores`, still pins every blob its history cites, so the acknowledgment loses
nothing the parent's archive holds). The e2e fork-race test passes it for that reason.

### D25 - the export says WHY coverage is missing (low)

An `exportSubject` execution read through the crypto-shred erasure window now carries `erasureWindow: true`
alongside the absent `unarchived`, so a caller can tell "unreadable by design" from "no archive configured".

### D26 - the tenant guard is opt-in (docs)

`durability.retention.tenant` (or tenant-scoped stores) is what makes the guard refuse (D17): an undeclared,
unscoped store stack is indistinguishable from a single-tenant one. A multi-tenant deployment must declare it;
the operator docs now say so.

### D27 - the re-compact no-op checks the incarnation (low)

D20's no-op returned `null` before the incarnation check, so a reused-id leftover header was hidden. The
no-op now refuses with `ArchiveIncarnationError` on a foreign incarnation first, exactly as `archiveRemoved`.

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
   **Answered (kept):** the link stays by `(executionId, through == snapshot.sequence)`; the legacy segment
   (D10) proves the archive can carry checkpoint facts without a Snapshot field.
2. Tenant scoping. **Answered:** D12 ships `TenantScopedArchiveStore` and refuses a mismatched pair.
3. `loom doctor` does not yet check that an encrypting deployment's archive is sealed (the refusal at compact
   time, now also the boot-time auto-wrap in `defineConfig`, is the guard).
4. Reserved-stream trims and deletes (`trimInbox`, the quarantine trim, the terminal delete): see [ADR 0139](0139-reserved-streams-archive-before-removal.md) (#728).
