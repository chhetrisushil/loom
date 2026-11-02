# ADR 0146 — Reclaimable content ages from the citing execution's end

- Status: **Accepted** (2026-11-02)
- Date: 2026-11-02
- Amends: [ADR 0055](0055-k10-6-pin-seam-content-gc.md) (the sweep's clock, D2/D4) and
  [ADR 0140](0140-agent-claim-check-opt-in.md) (D6, "TTL-reclaimed"). Neither rule about WHICH refs are
  reclaimable changes; only the instant their age is measured from.
- Builds on: [ADR 0145](0145-app-owned-retention-policy.md) (the retention policy and its advisory
  `content.unpinnedAfterMs >= terminalTtlMs` rule), [ADR 0116](0116-late-outcome-attach.md) (a late outcome lands
  after the terminal event), [ADR 0104](0104-recovery-never-answers-a-gate.md) (`resumeAs` re-opens a terminal execution)
- Placement: **1P, `@loom/plugin-content` only** (`sweepUnpinnedContent`, `terminalEndOf`) + one CLI line in
  `@loom/cli`. No new dependency (the terminal-kind check is duplicated, not imported from
  `@loom/workflow-runtime`). Kernel, KERNEL_ABI, EVENT_SCHEMA and every SPI version unchanged. Always on: no
  flag.

## Context

`sweepUnpinnedContent` reclaims an envelope-only (`reclaimable`) ref once `now - latest citation >=
olderThanMs`. `LogLifecycle.applyRetention` deletes a terminal execution's log once `now - its END >= ttl`.
A long run cites a blob early and ends much later, so the blob could be erased while the log citing it was
still retained, and `resolveClaimCheck` returned `null` for a log the operator was still keeping. ADR 0145
could only call its `unpinnedAfterMs >= terminalTtlMs` rule "advisory" for this reason.

## Decision

A TTL-reclaimable ref's age clock runs from the citing execution's END instead of the citation, per citing
event, and the ref's effective time is the maximum over its citing events:

```
effective(event) = terminal(execution) ? max(event.timestamp, endedAt(execution)) : event.timestamp
reclaim iff now - max(effective) >= olderThanMs
```

- **Terminal** = the execution's newest kernel `EXECUTION_COMPLETED`, `EXECUTION_FAILED`,
  `EXECUTION_CANCELLED` or `EXECUTION_CONTINUED` (kernel-stamped), the same set as `LogLifecycle`'s
  `terminalEndedAt`; `endedAt` is that event's timestamp. An execution RE-OPENED after its newest terminal
  event (a later `EXECUTION_RESUMED`, `EXECUTION_SUSPENDED` or `EXECUTION_STARTED`, as `resumeAs` appends) is
  NOT terminal. Reserved streams (the inbox) and logs with no terminal event are not terminal.
- **Never earlier than the citation.** The `max` with the citing event matters: a late outcome appended after
  the terminal event, or a non-monotone timestamp, would otherwise make the bare end EARLIER than today's
  clock and delete more.
- **Non-terminal executions keep the citation clock**, so a perpetual sentinel's telemetry still ages
  `cite + T` and storage stays bounded. A continue-as-new chain ages per generation (each ends in a kernel
  `EXECUTION_CONTINUED`): at most one generation's span of extra retention, bounded.

### Monotonicity: it only ever deletes less

For every ref, the effective time is `>=` today's latest-citation time by construction (a max that includes
the citation itself), so `now - effective < olderThanMs` whenever `now - latest citation < olderThanMs`.
Pinned kinds, bare (load-bearing) refs, `roots`, archive-cited refs (pinned) and snapshot-only citations
(never reclaimed) are untouched. The orphan pass gates on citation presence, which is unchanged, and every
erase stays conditional on the store's own touch clock. Proved by a seeded fuzz test
(`reclaimedNew` is a subset of `reclaimedOld`).

### Report

`ContentSweepReport.refsAgedByEnd` counts unpinned refs whose effective time came from an end. A DRY RUN also
returns `heldByEndClock`: the refs the citation clock alone would have reclaimed that the end clock keeps.
The erasing sweep keeps no second map, so mark memory is not doubled (it holds a `viaEnd` Set, at most one entry per ref, for the metric). `loom sweep content` prints the count
only when non-zero, so unchanged sweeps print unchanged text. The re-opened exception below prints the same way.

### ADR 0145 consequence

With a policy used by BOTH commands, `content.unpinnedAfterMs >= terminalTtlMs` now makes a reclaimable
blob never reclaimable before retention could delete the log: it becomes reclaimable at `max(end, citation) +
unpinnedAfterMs >= end + terminalTtlMs`, when retention makes the log eligible (same policy, numeric
timestamps). Exceptions, where the log lives on past eligibility while the blob is reclaimed: retention gates (pinned predicate, blocked-by-branch, unsupported, unsafe-archive) can keep the log longer; a running or re-opened execution keeps the citation clock (owner ruling 2026-11-02: kept on purpose, so a re-opened sentinel's telemetry still ages; the fix is VISIBILITY only: `ContentSweepReport.refsOfReopened` counts, on every sweep, the unpinned refs whose newest citation came from an execution re-opened after a terminal event, and a dry run's `reclaimedWhileReopened` lists those among `reclaimed`; a plain running or parked execution is not counted); the retention archive's copy keeps citing forever; and a legacy log compacted before the terminal event was preserved is aged by retention from its last event while the sweep finds no terminal (citation clock). It still holds only within one policy used by both commands
(a bare `--ttl` on either breaks it), and it never protects a retained or bare ref, which no TTL reclaims.

## Alternatives

- **Non-terminal = never reclaim (a pure end clock).** Rejected: a perpetual execution never ends, so its
  telemetry would grow without bound (the state-growth class of ADR 0137).
- **The bare end, without the max.** Rejected: not monotone, can reclaim earlier than today.
- **Opt-in flag.** Rejected: the change is monotone-safe and fixes a real mismatch; a flag leaves the
  surprising default and a second code path.
- **Import `terminalEndedAt` from workflow-runtime.** Rejected: it would invert layering. The four-kind check
  is duplicated and a drift test (`plugins/content/src/gc.endClock.test.ts` (l)) pins it against the ReplayVM fold.

## Consequences

- Reclaimable blobs are kept at most one run's span longer than before, never shorter.
- A caller that sweeps with a `now` earlier than a real execution's end now keeps that execution's refs
  (including `olderThanMs: 0`); only-less, but a test with a stale fixed `now` can flip.
