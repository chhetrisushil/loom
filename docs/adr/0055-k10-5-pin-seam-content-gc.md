# ADR 0055 — K10.5: the pin seam — retention pin predicate + pinned mark-and-sweep for content

- Status: **Accepted — shipped** (`PinPredicate` on `LogLifecycle`, `defineConfig({ retention.pinned })`,
  `sweepUnpinnedContent`/`pinByEventKinds` in `@loom/plugin-content`)
- Date: 2026-07-15
- Builds on: [ADR 0051 D5](0051-perpetual-agents-placement-schedule-remodel.md), ADR 0022 (K10.1
  retention), ADR 0054 (claim-check envelope), ADR 0046 (content store — whose "refcounted blob GC"
  follow-up this closes).
- Part of: the perpetual-agents series (W3, issue #167). Additive/opt-in (G2); no new event kinds.

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

## Consequences

- Aggressive raw-telemetry TTLs are now safe: the W7 acceptance test (delete blobs 30d+, archive
  runs 60d+, every finding's evidence still hash-verifies) is provable — the gc test suite proves
  the store-level half today.
- Re-sweeping an already-reclaimed ref re-reports it (delete is idempotent); the report is
  "what was requested erased," not a delta. Documented in the sweep's contract.
- Erasure remains invisible to replay by ADR 0054's contract; only `resolveClaimCheck` readers
  observe `null`.
