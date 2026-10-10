# ADR 0055 — K10.6: the pin seam — retention pin predicate + pinned mark-and-sweep for content

- Status: **Accepted — shipped** (`PinPredicate` on `LogLifecycle`, `defineConfig({ retention.pinned })`,
  `sweepUnpinnedContent`/`pinByEventKinds` in `@loom/plugin-content`)
- Date: 2026-07-15
- Builds on: [ADR 0051 D5](0051-perpetual-agents-placement-schedule-remodel.md), ADR 0022 (K10.1
  retention), ADR 0054 (claim-check envelope), ADR 0046 (content store — whose "refcounted blob GC"
  follow-up this closes).
- Part of: the perpetual-agents series (W3, issue #167). Additive/opt-in (G2); no new event kinds.
- Amendment (2026-07-15, W9): **relabeled K10.5 → K10.6.** The series originally reused
  "K10.5", which the K10 requirement set had already assigned to encryption-at-rest
  (ADR 0022, `docs/loom-2.0/11-encryption-at-rest.md`). The pin seam is K10.6 everywhere
  (docs, code comments, tests); mechanics unchanged.
- Amendment (2026-10-10): **`reclaimOrphans` requires an explicit completeness acknowledgement** (see the end of D6).
- Amendment (2026-09-28, L11): compaction keeps pinned event kinds and the D6 checkpoint
  lookup follows the kept events — see the closed "known gap" under D6 and
  [ADR 0106](0106-compaction-integrity.md).

## Context

The series' retention rule — *findings and their evidence are permanent; runs are archivable; raw
telemetry is disposable* — needs two mechanisms K10 lacked: retention could not exempt executions
an app declares precious, and nothing reclaimed content-store blobs at all (the ADR 0046 deferred
gap), let alone while honoring evidence citations that must outlive both raw-telemetry TTL and the
archival of the citing run.

## Decisions

### D1 — Execution-level: `PinPredicate` on `LogLifecycle` (the kernel gate)

`applyRetention` consults an optional `pinned?: (executionId) => boolean | Promise<boolean>`,
evaluated after the terminal/TTL/branch checks and **before anything is copied or destroyed**
(a pinned execution is not even archived — pin means "leave it exactly where it is"). New outcome
`"pinned"`. Wired via `defineConfig({ retention: { pinned } })`. G3 division: the kernel supplies
the gate; what pins is policy — `pinByEventKinds(store, ["FINDING_RECORDED"])` gives the common
case in one line.

### D2 — Ref-level: mark-and-sweep, not a persisted refcount

The requirements left refcount-vs-mark-and-sweep open. Decided: **pins are re-derived from the log
on every sweep.** `sweepUnpinnedContent` walks every event of every execution across the given
stores (live AND archive), deep-collecting claim-check refs (ADR 0054 envelopes) from payloads;
refs cited by designated event kinds are pinned; unpinned refs whose *latest* citation is older
than the TTL are physically erased via `ContentStore.delete`.

Why mark-and-sweep won: the log is already the source of truth, so there is no mutable pin index
to corrupt, migrate, or resurrect after a crash; archived runs keep pinning simply by being
scanned (pass the archive store — pins are keyed by content address, so a finding in an archived
month-1 run protects its evidence through any number of successor runs, the RC-11/TS-5 joint
requirement); and a refcount would have to be transactionally coupled to event append/delete —
exactly the cross-store coupling ADR 0046 flagged as the risk. Cost: sweep is O(events scanned);
it runs on the operator cadence (`loom retention run` discipline — nothing on a timer), where
linear scans are acceptable, and the per-event walk is a single pass with O(1) set lookups.

Safety property: a store that cannot be enumerated (`listExecutions` absent) makes the sweep
**refuse** rather than proceed — an unscannable store's pins would be invisible, and under-pinning
deletes evidence.

### D3 — Layering

`plugins/content → @loom/middleware` (for `isClaimCheck`) is plugin→kernel-package, the allowed
direction; `@loom/workflow-runtime` gains no new dependencies (the predicate is structural). The
envelope stays a leaf in the payload walk — digests are projections, not containers.

> **Amended 2026-09-27 (see D4).** Both halves above were stale. The sweep never took the
> `@loom/middleware` dependency: it recognises an envelope structurally, with the same test as
> `isClaimCheck` (`__loomClaimCheck === true` AND a string `ref.__loomContent`). And the envelope
> is not a leaf in the walk. Its `ref` is reported as the one enveloped (TTL-reclaimable)
> citation, and every other field, `digest` included, is walked as ordinary payload. A digest is
> replay-visible, so a ref inside it is load-bearing.

## Consequences

- Aggressive raw-telemetry TTLs are now safe: the W7 acceptance test (delete blobs 30d+, archive
  runs 60d+, every finding's evidence still hash-verifies) is provable — the gc test suite proves
  the store-level half today.
- Re-sweeping an already-reclaimed ref re-reports it (delete is idempotent); the report is
  "what was requested erased," not a delta. Documented in the sweep's contract.
- Erasure remains invisible to replay by ADR 0054's contract; only `resolveClaimCheck` readers
  observe `null`.

## Amendment (2026-09-27) — D4: a bare ref is load-bearing

### D4 — Only a claim-check envelope's own ref is TTL-reclaimable

D2 said the sweep deep-collects *claim-check* refs; the code collected every object with a string
`__loomContent`, and reclaimed each one on the TTL unless a pinned event kind cited it. That is
safe only for ADR 0054 envelopes, whose erasure the fold never sees. An ADR 0046 externalized
field is a **bare** ref in the raw log, and `ContentResolvingEventStore.read` resolves it and
throws `ContentMissingError` when its blob is gone.

The probe that found it: `ContentResolvingEventStore(raw, content, { externalize:
{ STEP_COMPLETED: ["output"] } })`, one `STEP_COMPLETED` 60 days old in a still-running
execution, swept on the raw store with `pinnedEventTypes: ["FINDING_RECORDED"], olderThanMs:
30d`, gave `reclaimed 1`, and the next `read()` threw. The execution was bricked: resume, replay,
fork and compliance export all read the log through the resolving store. The documented operator
command, `loom sweep content --ttl 30d --apply`, did this to any perpetual agent that also
externalized its large step outputs.

Decided: **only a claim-check envelope's own `ref` is TTL-reclaimable; every other ref is
load-bearing (ADR 0046 resolves it), pinned while cited.** "An envelope's own ref" means exactly
the envelope's own `ref`, the offloaded value. An envelope is recognised structurally, with the
same test as `isClaimCheck`: `__loomClaimCheck === true` AND a string `ref.__loomContent`. An
app object that only carries the flag is app data. Every other envelope field is recorded,
replay-visible data and is walked in the envelope's own context. That matters most for
`digest`, which orchestration branches on (ADR 0054 CC-2), so a ref inside a digest is
load-bearing. A ref cited anywhere other than an envelope's `ref` is never reclaimed while any
scanned event cites it, and when one ref is seen both ways the bare citation wins. The report gains `refsLoadBearing`; `loom sweep content` prints it.

The rule covers every bare ref, not only the fields a resolving store was configured to
externalize. It has to: the raw log does not say which fields were externalized, and
`ContentResolvingEventStore` resolves every bare ref in a payload, not only its configured paths.
So a ref an app emits itself (`ctx.emit(KIND, { ref })`) is retained too. An app that wants such
a ref to age out has to cite it as an envelope's `ref`. That works under a resolving store too
(see the closed gap below).

A bare ref stops being cited when its execution is deleted. Reclaiming the blob then is an
orphan pass over the content store (D6, below; opt-in via `reclaimOrphans`). Without that pass
such a blob is kept, which leaks storage but never breaks a read. Cost is unchanged at O(payload) with the one WeakSet cycle
guard: an envelope reports its `ref` directly instead of descending into it, so an object an
in-memory payload aliases at a bare site and as an envelope's `ref` is still seen bare.

Closed (2026-09-27, the store-decorator fix recorded in ADR 0074's amendment of that date):
`ContentResolvingEventStore` used to descend into claim-check envelopes, replacing
`envelope.ref` with the decoded value on read and throwing when the blob was gone. Its read
walkers (`hasContentRef`, `collectContentRefs`, `substituteContentRefs`) now treat an envelope,
recognised by the same structural test, as a leaf. An envelope whose blob was reclaimed reads
back as the envelope, a `codec: "bytes"` envelope reads, and a bare ref beside it still
resolves. Only `resolveClaimCheck` readers observe the erasure, as ADR 0054 intends.

## Amendment (2026-09-28) — D5–D7: the re-cite race, orphans, external root sets

Placement: 1P (`@loom/plugin-content`, `@loom/plugin-sqlite`, `@loom/conformance`, the CLI). No
kernel change. D2 stands: a persisted refcount is still rejected, because it would have to be
transactionally coupled to event appends in a different store. All three decisions keep the log
as the only source of citations. They add a **store-side touch time**, which is a fact about
the blob, not a count of its citers.

The new SPI surface is justified by a domain argument (ADR 0083). Every content-addressed store
that dedups has both the race (D5) and unreachable orphans (D6). That follows from content
addressing, not from any one workload. The root set (D7) has an unrelated second consumer:
genUI's `experience_refs`, an app table in its own Postgres that cites blobs the log never
sees.

### D5 — Every erase is conditional on the blob's touch time (ContentStore SPI 1.3.0)

A `put` of bytes the store already holds was a no-op (`INSERT OR IGNORE`). Nothing recorded that
the blob had just been cited again. The sweep decided from the log alone, so a sweep that ran
between a re-citing `put` and that execution's event append erased the blob by its *old*
citation time. The new event then cited a blob that was gone. For a claim-check envelope,
`resolveClaimCheck` returned `null`. For an externalized ref, the execution was bricked, as in
D4. The window is any effect whose result dedups against an old blob: a retried tool with
identical output, a re-fetched unchanged document, a repeated `EXPLAIN`.

Decided: ContentStore SPI **1.3.0** adds three optional methods that come as a set: a store
implements all three or none, and the conformance kit fails a partial set. The first is
`deleteIfUntouchedSince(ref, cutoffMs): Promise<boolean>`. It is ONE atomic statement (SQLite:
`DELETE … WHERE address = ? AND touched_at < ?`), never a read followed by a delete. A store
that implements it MUST bump the blob's touch time on **every** `put`/`putStream`, including a
put of bytes it already holds (SQLite: `INSERT … ON CONFLICT(address) DO UPDATE SET touched_at =
max(touched_at, excluded.touched_at)`). The `max` means a clock that steps backwards cannot make
a re-cited blob look older: touch times are monotonic, and the kit checks it with a clocked
factory.

**Two clocks, kept apart.** The TTL is measured on the LOG: `now` is a log-time instant,
compared with event `timestamp`s. The guard compares against touch times, which are on the
STORE's clock. A simulated year, a replayed archive, or a database server whose clock is not
the caller's all make the two differ. A cutoff derived from the caller's `now` could then
disarm the guard: with `now` ahead of the store, every re-cited blob already looks untouched.
So the third method is `touchClock(): Promise<number>`, the store's own current time. The
guard cutoff is `touchedBefore`, which defaults to `touchClock() − olderThanMs` read once at
the sweep's **start**. A caller may pass `touchedBefore` explicitly. A store with the
conditional delete but no `touchClock` requires it explicitly, and the sweep refuses otherwise.
The sweep erases only through the conditional delete when the store has one, so a put during
the mark window makes the delete refuse. Without the method, the sweep falls back to `delete`
and reports `raceSafe: false`; `loom sweep content` prints `race-safe: NO`.

The guarantee holds while a flow's put→append window is shorter than the TTL. A put more than a
TTL before its own append is outside what any TTL can protect.

SQLite migration: `ALTER TABLE content_blobs ADD COLUMN touched_at INTEGER NOT NULL DEFAULT 0`,
then a one-time backfill to the migration time, inside one `BEGIN IMMEDIATE` transaction that
re-checks for the column. That is conservative: nothing that already existed ages out until a
full TTL after the upgrade. The in-memory store keeps `{ bytes, touchedAt }` per address, with
an injectable clock.

### D6 — Orphan reclamation: the store is enumerable, and the pass is opt-in

The sweep only ever deleted addresses it found cited, and the SPI could not enumerate a store.
So a blob was never reclaimed once nothing in the scanned logs cited it:

- its execution was deleted by retention with no archive configured,
- the process crashed between `put` and the event append (the claim-check middleware puts
  inside the effect, before `STEP_COMPLETED`), or
- `deleteExecution` or a branch prune removed the only citing events.

`truncatePrefix` does NOT orphan.
`LogLifecycle.compact` folds the prefix into a snapshot before truncating. A ref the prefix
cited in step state (a claim-checked output in `frames`) lives on in that snapshot, and the
fold still carries it. Only a ref cited solely by an event the fold ignores (an app's
`FINDING_RECORDED`) loses its last loom-held citation on compaction. An app that projected
such an event elsewhere contributes that projection as `roots` (D7).

D4 made this larger, since a bare ref is only released when its execution goes.

Decided: SPI 1.3.0 adds an optional `listPage({ cursor?, limit?, touchedBefore? })`, which pages
**keyset on address**. Memory is bounded per page, and deleting entries mid-scan never skips a
survivor. The page limit must be a positive integer; anything else is a `RangeError`, never "no
limit" (SQLite reads `LIMIT -1` as unbounded). With `reclaimOrphans` (CLI `--orphans`; amended 2026-10-10: the object form `{ completeScan: true }`, see the end of this section),
after the TTL pass the sweep streams `listPage({ touchedBefore })`, using D5's store-clock cutoff. It erases,
conditionally, every address NOT in `lastCited ∪ pinned ∪ loadBearing ∪ roots`. `pinned` and
`loadBearing` are subsets of `lastCited`, so each decision is two `Set` lookups and the whole
sweep is O(events + blobs). A blob younger than the TTL is never an orphan, so an in-flight
`put` whose append has not landed survives. `reclaimOrphans` refuses a store that lacks
`listPage` or `deleteIfUntouchedSince`: without the conditional delete, erasing a listed orphan
reintroduces D5's race. The report gains `orphansReclaimed`.

> **Superseded in part by [ADR 0106](0106-compaction-integrity.md) D4.** The "no
> sequence-1 event" test and the checkpoint "at exactly `events[1].sequence − 1`" below were
> true only while compaction removed everything below its checkpoint. Compaction now keeps
> pinned-kind events in place and never removes the tip when it does. So "compacted" means
> gapped or bootstrap-only, and the checkpoint is the lowest snapshot in `[gap, tip]`, where
> `gap` is the log's highest missing sequence. The rest of this section stands.

**Compaction snapshots are scanned (`snapshotStores`: the live snapshot store and each
archive's).** `LogLifecycle.compact` checkpoints the fold at the tip and truncates the prefix, so
the next surviving event after sequence 0 is `tip + 1`. For every execution whose log has no
sequence-1 event, the sweep pins every ref in two snapshots:

- the **compaction checkpoint**, the snapshot at exactly `events[1].sequence − 1`. If only
  sequence 0 remains (compacted at its tip), the checkpoint is the latest snapshot.
- the **latest** snapshot, which resume loads.

Pinning only the latest is not enough. A later snapshot (a suspend, a loop that overwrote the
same step's output) can drop a prefix ref from state, while `fork()` from any point between the
checkpoint and that snapshot loads the checkpoint (`loadLatestBefore`) and needs the ref.
Snapshots in between hold only checkpoint- or suffix-derived refs, and the suffix is scanned as
log. Anything below the checkpoint is unreachable, because the events that would fold on from it
are gone.

The refs are **pinned** because compaction folded away the event kinds, so the sweep cannot tell
telemetry from evidence (D1). They are released when retention deletes the execution, which
deletes its snapshots too; the next orphan pass then reclaims them. Only executions that lack a
sequence-1 event cost a snapshot read, so an uncompacted log pays nothing.

The orphan pass **fails closed**, before anything is erased, in two cases:

- any scanned event store can `truncatePrefix` and no `snapshotStores` were given;
- an execution looks compacted and no checkpoint is found, meaning either a gap with no
  snapshot at `events[1].sequence − 1`, or a sequence-0-only log with no snapshot.

A sequence-0-only log is either compacted at its tip or a run that never got past its
bootstrap, and the two cannot be told apart, so both refuse. The refusal names the executions.
A transient bootstrap clears as soon as the run progresses. A run that crashed at its bootstrap
blocks the orphan pass until it is re-driven (`loom recover`) or cancelled. The CLI requires
`--archive-snap` whenever `--orphans` runs with `--archive-db`, and every CLI refusal exits
non-zero.

**Known gap (backlog L11) — closed by [ADR 0106](0106-compaction-integrity.md).** Compaction
used to truncate an app's `FINDING_RECORDED` events away, since the fold ignores them and so
the checkpoint did not carry them. `LogLifecycle` now takes `pinnedEventTypes` (the same list
given to this sweep) and keeps those events in place below the checkpoint
(`EventStore.truncatePrefixKeeping`, SPI 1.5.0). Compaction consults the `pinned` predicate
only when no kinds are declared (ADR 0106 D3); D1 above governs retention. Kept events move the checkpoint lookup (ADR 0106 D2/D4, the tip
rule): a gap-free log with more than the bootstrap was never compacted; a gapped log's
checkpoint is the lowest snapshot in `[gap, tip]`, where `gap` is its highest missing
sequence (for a log with no kept events, `events[1].sequence − 1`, as above); and a
bootstrap-only log's checkpoint is its latest snapshot.

**Unknown touch times.** A touch time of `0` is the column default a pre-1.3.0 writer leaves
during a mixed-version rollout. It means UNKNOWN, and the orphan pass never erases such a
blob. Such a writer also does not bump on a re-put, so the D5 race stays open for blobs it
writes until every writer runs 1.3.0.

**Scan order and memory.** List the live store BEFORE its archive. Retention copies an
execution to the archive and then deletes it from the live store, so scanned live-first, an
execution that moves mid-sweep is seen in one of them. Scanned archive-first, it can be missed
by both and its blobs then look like orphans. The CLI scans live then archive. Mark memory
grows with the number of DISTINCT cited addresses (one map entry each, plus the pinned,
load-bearing and root sets). Content is never held; pages bound the store scan, not the mark.

**The hazard the sweep cannot detect.** To this pass, a blob cited only from a store that was
not passed in `eventStores` is an orphan, and it is erased. The usual case is the retention
archive. The sweep cannot tell "no archive" from "an archive you forgot". The CLI therefore
scans the app's `durability.retention.archive` automatically under `--config`, and refuses
`--orphans --apply` with no archive unless `--no-archive` asserts there is none. In that case
it warns on stderr BEFORE erasing anything, and the dry-run report carries the same WARNING.
`--orphans` also needs the snapshot store (`--snap`/`--archive-snap`; a config always has one).
The CLI help and the `reclaimOrphans` docstring say the same. `docs/data-protection-patterns.md` now says the archive is REQUIRED
whenever retention archives.

**Amendment (2026-10-10) — the acknowledgement is mandatory.** The paragraph above left the
guard to the CLI and to `dryRun`; a library host calling `sweepUnpinnedContent({ reclaimOrphans: true })`
that omitted an event store or snapshot store silently erased every blob only that store cited
(the library cannot see a store it was not given). Decided: `reclaimOrphans` is now
`{ completeScan: true }`. A bare `true`, `{}`, `{ completeScan: false }` or any other value throws
`ReclaimOrphansAckError` (a `TypeError`) before anything is read or erased, so the unsafe sweep
cannot be reached by accident and a migrating host must read the hazard once. A `dryRun` is
EXEMPT: it erases nothing and is how a host checks completeness, so `dryRun: true` accepts a
plain `true` (the type is a union tying the two: the erasing arm takes only the object or
`false`, the `dryRun: true` arm also takes a boolean). The object form is the caller's assertion
that `eventStores`, `snapshotStores` and `roots` cover every citing store, **in scan order**: each
live store BEFORE its archive (see "Scan order" in D5), because `[archive, live]` can truthfully
cover every store and still miss an execution retention moves mid-sweep. The CLI passes it only
after its own archive/snapshot checks and scans live then archive. Considered and not added: (b) a
two-phase plan/apply token, because a token would not detect an omitted store, and it does not
close the concurrency gap below either (the plan is as stale as the scan); D5's
`deleteIfUntouchedSince` covers a re-cite through `put` against the store-clock cutoff read once
at the start, nothing more; (c) a grace floor, which exists already (a blob touched within
`olderThanMs` of the sweep is never an orphan, and an in-flight `put` survives). The sweep cannot
detect an omitted store, so no further automatic detection is claimed. The `reclaimOrphans: false`
/ absent path is unchanged.

> **KNOWN GAP (not fixed here): a citation copied WITHOUT a `put` is not protected.** D5's
> conditional delete reads the blob's touch time, and only `put`/`putStream` bump it
> (`InMemoryContentStore`, `SqliteContentStore`). A re-cite through `put` is therefore safe; a
> citation that never calls `put` is not: `ContentResolvingEventStore.copyPrefix` (a fork) copies
> refs verbatim, and an `append` keeps refs already inside its payload (recalled memory,
> `scriptRef`, refs passed between steps). Scenario: a blob older than the TTL is cited only by
> `p-parent`. The sweep lists executions in id order. Mid-sweep `p-parent` is forked (copied
> verbatim) into `a-child`, whose id the listing has already passed, and `p-parent` is then
> deleted. The scan sees neither citation, the blob is an orphan older than the cutoff, the
> orphan pass erases it, and `a-child` replay throws `ContentMissingError`. A test pins this
> (`KNOWN GAP` in `gc.test.ts`); a fix flips it deliberately. **Operational rule: do not run an
> orphan sweep concurrently with forks or deletes of the executions it scans; quiesce them
> first.** Closing it needs a ContentStore SPI change (a way to touch without a put, called by
> the fork path), which is a separate decision.

### D7 — External root sets

`sweepUnpinnedContent({ roots: () => AsyncIterable<string> })` lets an app's own tables add
addresses to the mark phase. Every yielded address is pinned through both passes. Roots are read
once, after the scan. An app that records a new root for bytes the store already holds must
`put` them, as a flow does, because the put is the touch the conditional delete sees. Take an
app that keeps its own content store (for example a Postgres blob table implementing this SPI)
and its own citation table (`SELECT hash FROM experience_refs`). With `roots` it gets
race-safety and orphan reclamation from the same sweep. Its eager, transactional delete stays
app code, which is free for it because refs and blobs share one database. The CLI cannot read
an app's tables, so roots are API-only.

### Consequences

- `CONTENT_STORE_SPI_VERSION` 1.2.0 → **1.3.0** (additive MINOR). The kernel manifest now
  carries it, so the compatibility matrix lists it and `checkCompatibility({ contentStoreSpi })`
  checks it.
- The conformance kit checks the optionals when present. The three methods must come as a
  set. A re-put must bump the touch time, checked through the conditional delete alone with a
  cutoff taken from `touchClock` between the two puts; an `INSERT OR IGNORE` store fails
  (the kit's internal touch-contract check, whose negative tests prove it fires; it is not exported, since nothing outside the kit consumes it, ADR 0083). Touch times must be
  monotonic (with a clocked factory). The conditional delete refuses a touched blob and erases
  an untouched one, `listPage` returns
  every blob exactly once across pages even while deleting, `touchedBefore` is strict across a
  full paged scan, and a bad limit rejects. `CachingContentStore` forwards both, and a conditional delete that erases
  evicts before and after.
- A caller running the log on a simulated clock (a DST harness) must give the content store
  the same clock, or pass `touchedBefore`. Otherwise the guard, which is correctly on the
  store's clock, keeps every blob the simulation "aged".
- A test that fabricates history (cites a blob at a synthetic past time after putting it at
  today's wall clock) now sees it kept, because the blob was touched after the cutoff. Such
  fixtures give the store a clock (`new InMemoryContentStore({ now })`,
  `new SqliteContentStore(path, { now })`).
- **Erasure is not closed here.** Blobs are deduped plaintext with no subject mapping, and
  `EraseCoordinator` shreds log keys only. A subject's bytes in the content store are erased by
  an explicit `contentStore.delete(ref)`. A subject→blob index is deferred until a consumer
  needs it.
- There is no Postgres ContentStore in this repo. The SQLite store and the in-memory reference
  implement 1.3.0.
