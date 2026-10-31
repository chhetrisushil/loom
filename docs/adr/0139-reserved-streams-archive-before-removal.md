# ADR 0139 — Reserved streams archive what a trim or a delete removes

- Status: **Proposed** (2026-10-31) — implemented in the PR that carries it; accepted on merge
- Date: 2026-10-31
- Found by: GitHub issue #728, from the review of #727 ([ADR 0138](0138-compaction-archives-what-it-removes.md)). It predates that PR.
- Builds on: [ADR 0138](0138-compaction-archives-what-it-removes.md) (the `ArchiveStore` SPI, the erasure and tenant guards, the audit reads, the sweep), [ADR 0110](0110-durable-inbox-and-receive-select.md) (the inbox streams), [ADR 0130](0130-sealed-payload-delivery-guard.md) residuals D9 (the quarantine stream).
- Owner rulings (2026-10-31): auditability stays intact (every fact the log held stays recoverable, byte-exact; a range that cannot be recovered is REPORTED, never silent); nothing in loom is pruned or deleted (a removal MOVES). Same rulings as ADR 0138, applied to the streams it did not reach.
- Version impact: **none**. No new SPI: the reserved streams use the `ArchiveStore` of ADR 0138 (SPI 1.0.0, unchanged), keyed by the reserved stream id. No `EVENT_SCHEMA`, `KERNEL_ABI`, `WIRE_ABI`, `EVENT_STORE_SPI` or `SNAPSHOT_STORE_SPI` change. New userspace API: `inboxArchive` / `inboxArchiveTenant` on the runtime deps, `ReservedStreamArchiveRequiredError`, `LogLifecycle.readReservedWithArchive` / `reservedArchiveCoverage` / `readReservedArchive`, `SubjectExecutionExport.reservedStreams`. **Behaviour change** (CHANGELOG): a trim or a delete of a reserved stream refuses without an archive.
- Placement: the kernel half (`@loom/workflow-runtime`: trims and deletes), `@loom/plugin-content` (the sweep), `@loom/plugin-crypto` (the sealing subject), `@loom/compliance` (the export). Reviewed as kernel + storage + security boundary (it is the same boundary as ADR 0138).

## Context

ADR 0138 made compaction MOVE the events it removes. Four other paths still removed envelopes from the log and kept nothing:

1. `trimInbox` and `trimTopicStream` truncate the consumed prefix of a chain's inbox (`__loom_inbox__:<chain>` and its per-topic streams). The payload survives in the owner's `MESSAGE_CONSUMED`; the envelope (its id, timestamp, the sender metadata, a floor marker) does not.
2. `trimQuarantine` frees the disposed copies of the chain's quarantine stream (`__loom_quarantine__:<chain>`): verbatim copies of messages a node could not open.
3. `deleteInbox` (the owner's terminal, `reclaimInbox`, a send that raced the terminal) deletes every stream of a chain, including messages nobody ever consumed.
4. The retention path (`applyRetention`) calls `deleteInbox` as part of deleting a whole execution.

## The deletion-path inventory

Every path that removes envelopes from any stream, classified:

| Path | Class |
| --- | --- |
| `LogLifecycle.compact` (`truncatePrefix(Keeping)`) | (c) archives (ADR 0138) |
| `LogLifecycle.applyRetention`, retention archive configured (copy, then delete) | (c) archives (the existing retention archive) |
| `applyRetention`, plain delete (`deleteExecution`, the compaction segments, the chain's streams) | (a) the user asked for the execution to go |
| `trimInbox`, `trimTopicStream` | (b) **fixed here** |
| `trimQuarantine` | (b) **fixed here** |
| `deleteInbox` from `retireInbox` (owner terminal), `reclaimInbox`, and the send-after-terminal re-delete | (b) **fixed here** |
| `applyRetention` -> `deleteInbox`, retention archive configured | (b) **fixed here** (moves to the compaction archive when one is configured) |
| `eraseSubject` -> `purgeInboxStreams` | (a) a requested erasure; the cryptographic half is the key, which a shred destroys under the archive's segments too |
| `ShardedEventStore` rebalance (`source.deleteExecution` after `copyPrefix`) | (c) a move between shards, the destination holds every envelope |
| Failed-fork cleanup (`deleteExecution(childQuarantine)`) | (a) rollback of a stream the same call just created; the originals are untouched in the parent's stream |
| `deleteExecution` / `truncatePrefix` inside store conformance kits and tests | not a product path |

## Decisions

### D1 — the same `ArchiveStore`, keyed by the reserved stream id; archive first, then remove, refuse without one

`ReservedStreamArchive` (`@loom/workflow-runtime`) moves the exact envelopes a removal is about to take out of the stream into the archive (`moveThrough` for a trim, `moveAll` for a delete), then the caller removes. Crash order is ADR 0138's: archive, then remove, so a crash leaves a duplicate (byte-exact, recognised by the next attempt), never a gap. Without an archive every trim and delete REFUSES with `ReservedStreamArchiveRequiredError` (typed, names the fix, `op: "trim" | "delete"`), before anything is read or removed. `deleteInbox` archives EVERY stream of the chain before deleting ANY (a refusal on the last leaves the first intact); a chain whose streams are all empty has nothing to lose and is deleted as before. Streams that do not exist cost one `head` read each, not a `read`.

### D2 — the incarnation of a reserved stream is a constant of the stream id

ADR 0138 D11 binds a segment to the digest of the log's bootstrap envelope. A reserved stream has none: a topic stream starts at `INBOX_TOPIC_SEQ_BASE` with a message, the legacy inbox's sequence 0 IS a message, the quarantine's sequence 0 is a clock-stamped payload-free anchor. The incarnation is therefore `segmentDigest` of a synthetic envelope naming the stream (`reservedIncarnation(streamId)`). It cannot tell two lives of one stream id apart by header; the byte-for-byte comparison every move makes does (D4). It is documented as such, not hidden.

### D3 — a re-created stream never reuses an archived sequence

The archive is append-only and contiguous per key, but a reserved stream is deleted at the owner's terminal and may be re-created (a send that raced the delete, a re-opened chain, a quarantine trimmed to its anchor). Re-creation used to restart at the stream's base. Now every writer that creates a stream consults the archive FIRST, only when the stream does not exist: `appendInboxMessage` (the first message of a stream), the floor seed of a fork or re-open (`seedInboxFloors`), and `appendQuarantineCopy` (a quarantine whose head is its anchor) start at `archive's last through + 1` (`ReservedStreamArchive.floorOf`, `ArchiveFloor`). The common hot path (the stream exists) reads nothing from the archive. A node WITHOUT an archive in a fleet restarts at the base; D4 catches what it writes.

### D4 — stragglers go to a late run, never dropped, never a wedged stream

An envelope at or below the archive's last sequence that the archive does not hold byte-for-byte is a STRAGGLER (a send allocated its sequence before the owner's delete and appended after it; a node with no archive floor). It is archived under `<stream>#late-<n>` (`reservedLateKey`, `RESERVED_LATE_SUFFIX`; the first `n` that can take it; an exact repeat is recognised after a crash). `inboxChainOf` strips the suffix so the sealing subject, the retention delete, the sweep and the export all see a late run as part of its chain, and `hasInboxStreamShape` refuses a chain id of that shape. More than 64 late runs of one stream fails closed (`ArchiveGapError`). Without this, one raced send would leave a stream that can never be trimmed or deleted.

### D5 — wiring: the compaction archive is the inbox archive

`WorkflowRuntime` deps take `inboxArchive` (and `inboxArchiveTenant`). `defineConfig` hands the SAME archive it hands `LogLifecycle`: `storage: { kind: "memory" }` and the sqlite/postgres presets get one automatically; a custom storage supplies `storage.archiveStore` or `durability.retention.compactionArchive` (the boot warning for a durable custom store with none now also says the inbox will not trim). It is resolved before the runtime is built. A runtime WITHOUT one does not trim and does not delete: `maybeTrimInbox` reports one `ReservedStreamArchiveRequiredError` per chain through `onStorageError` and moves on (the registry bookkeeping, which deletes nothing, still runs); a terminal's delete is refused and reported the same way. Sends keep working until `inboxMaxRetained` refuses them (a bounded, loud failure, as before for a pinned topic). The erasure guard (`PlaintextArchiveError`) and tenant guard (`ArchiveTenantMismatchError`, `inboxArchiveTenant`) of ADR 0138 D4/D12/D17 run before the first move.

### D6 — the sealing subject of a reserved stream is the chain owner's

`EncryptingEventStore` seals a chain's inbox payloads under the OWNER's subject, resolved from the chain id. `EncryptingArchiveStore` now does the same for a reserved stream's segments (`inboxChainOf`, including a late run's key), so a shred of the owner destroys the archived envelopes with the live ones (a read throws `PayloadShreddedError`). A custom `subjectOf` that reads `workflowId` resolves the owner's from its first event through the new `ownerWorkflowId` option (`defineConfig` supplies it from the event store, as the event store does).

### D7 — the reads, the sweep and the export see them

- `LogLifecycle.readReservedWithArchive(stream)`: archive u surviving stream, one entry per sequence, duplicates compared byte-exact (`ArchiveLogMismatchError`), `ArchiveIncompleteError` for a range nothing holds unless `allowIncomplete`. `reservedArchiveCoverage(stream)` reports every unrecoverable range (`why: "legacy"` when the archive holds nothing for the stream, trimmed before it archived; `"missing"` when it holds some). `readReservedArchive(chain)` returns every archived stream of a chain (late runs included) for the export.
- The content sweep already enumerates the archive, so a blob only an archived inbox envelope cites stays pinned. Reserved streams were mis-classified by its compaction detection (a topic stream starts at `INBOX_TOPIC_SEQ_BASE`, so a bare gap test called every topic stream "compacted"; a reserved stream has no checkpoint). A reserved stream is now judged by its sequences from its first possible one (1, or the base), and an ERASING pass requires the archive's headers to cover them (D24 of ADR 0138), else `ArchiveStoresRequiredError` before anything is erased. Streams trimmed BEFORE this ADR (no archive) are not covered: `acknowledgeUnarchivedLogs` is the explicit statement that their history is already gone.
- `exportSubject` returns `reservedStreams` per execution (the chain's archived streams with their envelopes and every `unarchived` range) for the chain's generation-0 execution.
- `applyRetention`: a plain delete removes the chain's archived reserved segments with the execution (the user asked for it to go, and the segments are keyed by a stream no sweep revisits once the log is gone); with a retention archive configured the execution is KEPT, so the chain's streams MOVE to the compaction archive when there is one and its segments stay readable.

## Cost on the hot path

Trimming already ran wherever the inbox advances (`maybeTrimInbox`), once per advance, bounded by the entries it removes. The archive adds, per TRIM: one ranged read of the entries being removed (the scan already read them once), one archive append, and nothing else in steady state (the archive's last sequence is remembered per stream, bounded; a stale memory is answered once with a header read after the archive's own conflict error). Per message consumed in a burst the added cost is zero (one trim covers the burst). A creation of a stream adds one `headers` read. Nothing reads the archive on the resume path (a test pins `read` at zero). Measured on the in-memory stores, 40 messages consumed one at a time (the worst case: one trim per message): store calls 1521 -> 1654 (+133, 8.7%), archive calls 39 (37 appends, 2 header reads), with the trim itself unchanged. The terminal delete adds one `head` read per stream and one `read` + append per stream that holds anything.

## Consequences

- `trimInbox` / `trimTopicStream` / `trimQuarantine` / `deleteInbox` take an optional `ReservedStreamArchive`; called without one they refuse (`deleteInbox` accepts `"discard"` for the explicit whole-execution delete of the retention path). Apps going through `defineConfig` need nothing; a hand-built `WorkflowRuntime` with `inboxEnabled` needs `inboxArchive`.
- The archive grows by exactly what the streams lose. Every node of a fleet must configure the same archive (D3/D4 degrade, not corrupt, when one does not).
- **Residual, stated:** a message appended to a chain's stream in the instant between the terminal's archive read and its delete is lost without an archive entry (the sender re-reads the owner after its append and re-runs the delete, which archives it, unless the first delete already removed it). The window existed before as "the message is reported discarded"; it is not widened. A message sent to a TERMINAL chain is refused with `InboxClosedError` regardless.
- A seeded floor (a fork or a re-open) leaves a gap below it that never held a message; the erasing sweep reports it as uncovered until `acknowledgeUnarchivedLogs` (before this ADR the same stream stopped the sweep outright).

## Open questions

1. `loom doctor` does not yet check that an inbox-enabled deployment has an archive (the boot warning and the per-chain `onStorageError` are the guards).
2. A durable `eraseSubject` of a plaintext (non-encrypting) deployment deletes the live reserved streams but not their archived segments: erasure there is the key, and a plaintext deployment has none. Same as the compaction archive today.
