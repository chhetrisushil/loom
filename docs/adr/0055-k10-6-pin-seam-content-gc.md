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

Decided: ContentStore SPI **1.3.0** adds an optional
`deleteIfUntouchedSince(ref, cutoffMs): Promise<boolean>`. It is ONE atomic statement (SQLite:
`DELETE … WHERE address = ? AND touched_at < ?`), never a read followed by a delete. A store
that implements it MUST bump the blob's touch time on **every** `put`/`putStream`, including a
put of bytes it already holds (SQLite: `INSERT … ON CONFLICT(address) DO UPDATE SET touched_at =
max(touched_at, excluded.touched_at)`). The `max` means a clock that steps backwards cannot make
a re-cited blob look older. The sweep fixes one cutoff at its **start**, `now − olderThanMs`,
and erases only through the conditional delete when the store has it. A put during the mark
window therefore makes the delete refuse. Without the method, the sweep falls back to `delete`
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
- `deleteExecution`, `truncatePrefix` or a branch prune removed the only citing events.

D4 made this larger, since a bare ref is only released when its execution goes.

Decided: SPI 1.3.0 adds an optional `listPage({ cursor?, limit?, touchedBefore? })`, which pages
**keyset on address**. Memory is bounded per page, and deleting entries mid-scan never skips a
survivor. The page limit must be a positive integer; anything else is a `RangeError`, never "no
limit" (SQLite reads `LIMIT -1` as unbounded). With `reclaimOrphans: true` (CLI `--orphans`),
after the TTL pass the sweep streams `listPage({ touchedBefore: start − TTL })`. It erases,
conditionally, every address NOT in `lastCited ∪ pinned ∪ loadBearing ∪ roots`. `pinned` and
`loadBearing` are subsets of `lastCited`, so each decision is two `Set` lookups and the whole
sweep is O(events + blobs). A blob younger than the TTL is never an orphan, so an in-flight
`put` whose append has not landed survives. `reclaimOrphans` refuses a store that lacks
`listPage` or `deleteIfUntouchedSince`: without the conditional delete, erasing a listed orphan
reintroduces D5's race. The report gains `orphansReclaimed`.

**The hazard the sweep cannot detect.** To this pass, a blob cited only from a store that was
not passed in `eventStores` is an orphan, and it is erased. The usual case is the retention
archive. The sweep cannot tell "no archive" from "an archive you forgot". So `--orphans`
without `--archive-db` prints a WARNING, the CLI help says the same, and so does the
`reclaimOrphans` docstring. `docs/data-protection-patterns.md` now says the archive is REQUIRED
whenever retention archives.

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
- The conformance kit checks the optionals when present: a put bumps the touch time, the
  conditional delete refuses a touched blob and erases an untouched one, `listPage` returns
  every blob exactly once across pages even while deleting, `touchedBefore` is strict, and a
  bad limit rejects. `CachingContentStore` forwards both, and a conditional delete that erases
  evicts before and after.
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
