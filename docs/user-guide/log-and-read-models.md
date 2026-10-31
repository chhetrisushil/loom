# Log lifecycle, read models, live queries & wire ABI

> Part of the [Loom User Guide](../user-guide.md), [section 17](../user-guide.md#17-kernel-grants-quotas--supervision) (Loom 2.0 kernel hardening). Working with the durable log itself: read models (ADR 0058), live queries, the log lifecycle (K10: crypto-shredding, retention, compaction), and the wire-level ABI (T2).

## Read models: durable cross-execution queries (ADR 0058)

Projections are per-execution and in-process; **read models** (`@loom/plugin-read-model`) are
the durable, cross-execution query layer — "every FINDING_RECORDED for table `orders`, newest
first", over months of runs, answered from an index instead of a re-fold:

```ts
import { InMemoryReadModelStore, ReadModelService } from "@loom/plugin-read-model";
// durable backends: SqliteReadModelStore / PostgresReadModelStore

const readModels = new ReadModelService(new InMemoryReadModelStore());
readModels.register({
  id: "findings-by-target",
  version: "1", // ADR 0095 — bump when `extract` changes MEANING (see below)
  kinds: ["FINDING_RECORDED"],
  indexes: ["target", "severity"],
  extract: (e) => [{ fields: { target: e.payload.target, severity: e.payload.severity } }],
});

const app = defineConfig({
  // the live tail rides the same in-process feed projections use:
  observability: { onEvent: (e) => readModels.handleEvent(e) },
  /* … */
});
await readModels.catchUp([app.stores.eventStore /*, archiveStore */]); // watermark-incremental

const page = await readModels.query("findings-by-target", {
  where: { target: "orders" }, order: "desc", limit: 50,
});
```

A read model is a **cache of the log with a watermark, never an authority**: drop it and
`rebuild()` re-derives identical state; queries are read-only and never recorded, so replay is
untouched. Ingestion converges from any mix of live tail, catch-up scans, and multiple nodes
(idempotent rows + monotonic per-execution watermarks — no global event order required).

**Changing an extractor is silent unless you pin it.** The rows the old `extract` wrote stay,
the `(modelId, executionId)` watermark is already past the events that produced them, so
catch-up never revisits them, and one `query` then answers from two extractors at once.
`rebuild()` is the exit; `version` is how anyone finds out it is needed. Whatever you derive
from these rows records `readModels.pins()`, and `readModels.checkPins(recorded)` compares it
later — a query that clears nothing, reporting `drift` when an extractor changed and `unpinned`
when one side declared no version, because two sides that declared nothing must not read as a
verified match ([ADR 0095](../adr/0095-binding-semantics-pin.md)). The same declaration exists on
`projection$` / `Projection` for the folds a composed surface binds to; see
[the composed-surface recipe](../composed-surfaces.md).

## Live queries: watching one execution as it runs (`@loom/live-query`)

Read models answer questions **across** executions. A live query is the other axis: the state
of **one** execution, pushed again every time an event lands — a progress view, a dashboard
panel, an SSE stream.

It needs no syscall and no new event type. `loadState` already folds an execution's durable
state on demand (bounded by snapshots), and `EventStore.subscribe` already says when something
changed; a live query is the two composed, which keeps it a read-model concern (P10) rather
than a kernel primitive.

```ts
import { liveQuery } from "@loom/live-query";

const lq = liveQuery({
  eventStore: app.stores.eventStore,
  reader: app.runtime,                        // anything with `loadState` satisfies StateReader
  onError: (err) => logger.warn({ err }),     // background re-folds — see below
});

await lq.snapshot(executionId);               // fold once, now (null if unknown)

const unsubscribe = await lq.subscribe(executionId, (state) => {
  render(state);                              // current state immediately, then on every event
});
// …later
unsubscribe();
```

**Coalesced, latest-wins.** Only one re-fold is ever in flight. Events arriving during a fold
set a dirty flag and cause exactly **one** more fold afterwards, so a burst of N events costs
O(1) extra folds rather than N — and a subscriber never sees a stale state arrive after a
newer one. `subscribe` also pushes once immediately, so a caller is not blind until the next
event.

**Two different failure paths, deliberately.** The first fold happens inside `subscribe`,
which you await — so if the store is unreachable, `subscribe` rejects and the failure is
yours to handle. Every later re-fold runs from the store's subscribe callback with nothing
awaiting it; those go to `onError`, and the subscription **stays live** — one failed re-fold
costs that update, and the next event folds from the log again.

> Wire `onError` in a long-lived process. Those background folds cannot reject to a caller,
> so without it a failing store read (or an `onState` callback that throws) is swallowed —
> and before it existed, it was an unhandled rejection, which terminates the process by
> default.

`reader` is typed as `StateReader` — just `loadState` — so a live query works over the
runtime, a remote read façade, or a test double, without depending on the whole runtime.

## Log lifecycle: crypto-shredding, retention & compaction (K10)

"Replay forever" collides with GDPR erasure and bounded storage. K10 gives the log a
lifecycle without ever creating a silent third behavior between "replays identically" and
"fails loudly".

**Pinning (K10.6, ADR 0055).** Retention consults an optional `PinPredicate`
(`defineConfig({ durability: { retention: { pinned } } })`) before reclaiming an execution — `pinByEventKinds(store,
["FINDING_RECORDED"])` pins runs carrying your designated domain events. The companion
`sweepUnpinnedContent` (in `@loom/plugin-content`) reclaims content-store blobs on a TTL while
refs cited by pinned event kinds survive — across archival, re-derived from the log on every
sweep (mark-and-sweep, no mutable index). Over a store with ContentStore SPI 1.3.0 (SQLite,
in-memory) every erase is conditional on the blob's touch time, so a blob re-cited mid-sweep is
kept, whether the re-cite is a `put` or a fork/append that carries the ref (SPI 1.4.0 `touch`, which `ContentResolvingEventStore` calls). `reclaimOrphans: { completeScan: true }` also reclaims blobs nothing cites any more; the
acknowledgement is required to erase (a bare `true` throws `ReclaimOrphansAckError`; a `dryRun` is exempt and is how you check) because you are asserting
that you passed every archive, every snapshot store and every `roots` source, and in the right
ORDER: each live store before its archive. A citation that enters a log without a `put` (a fork's
`copyPrefix`; an `append` that keeps a ref already in its payload) is protected by ContentStore SPI
1.4.0 `touch`: `ContentResolvingEventStore` touches those refs, so a fork made mid-sweep makes the
conditional delete refuse. To erase, the content store must implement `touch` (SQLite, in-memory and
`CachingContentStore` do) or `reclaimOrphans` throws `ReclaimOrphansTouchError`; a `dryRun` is
exempt. The log must be written through a `ContentResolvingEventStore` over that store, and its
snapshot store wrapped in a `ContentTouchingSnapshotStore` (a fork of a compacted parent keeps its
pre-compaction refs only in the seed snapshot). loom does not build either wrapper for you, so an
erasing pass given `snapshotStores` must assert it:
`reclaimOrphans: { completeScan: true, snapshotsTouchContent: true }` (else
`ReclaimOrphansSnapshotAckError`; the CLI flag is `--snapshots-touch-content`), and the store needs
`touchClock` as well (`ReclaimOrphansClockError`). The guarantee is the TTL's: the touch before a
write protects while the write takes less than the margin between the store's clock and the sweep's
cutoff, and the touch after it is only a best-effort extension (failures reach `onTouchError`), so
an erasing `reclaimOrphans` pass refuses `olderThanMs <= 0` or a margin under 60 s
(`ReclaimOrphansMarginError`). Run `dryRun` first. `roots` pins addresses held in your own tables
(ADR 0055 D5–D7). The joint rule the perpetual-agents series fixed:
*findings and their evidence are permanent; runs are archivable; raw telemetry is disposable.*
Give the same kinds to `retention.pinnedEventTypes` so compaction keeps those events in place
too (ADR 0106): a pinned execution then compacts around its findings. (With no
`pinnedEventTypes`, `lifecycle.compact` leaves an execution `pinned` pins uncompacted.) To keep
a WHOLE log uncompacted — a legal hold by tag — use `retention.compactionExempt`, which
`compact` always consults.
The whole pattern — schedule, carry state, claim-check, pin policy — is one declaration via
`sentinelPreset()` (`@loom/plugin-sentinel`), and `loom new sentinel <name>` scaffolds it.

**Crypto-shredding (K10.2, `@loom/plugin-crypto`).** Encrypt sensitive fields at rest under a
per-subject key; satisfy erasure by **destroying the key** — no history rewrite:

```ts
import { EncryptingEventStore, EncryptingSnapshotStore, InMemoryKeyStore, shredSubject }
  from "@loom/plugin-crypto";

const keys = new InMemoryKeyStore(); // tests only — `loom doctor` FAILS this in an app
                                     // (keys are the erasure boundary; losing them erases)
const eventStore = new EncryptingEventStore(inner, keys, {
  sensitive: { STEP_COMPLETED: ["output.ssn"] },      // dot-paths; only these encrypt (A4)
});
const snapshotStore = new EncryptingSnapshotStore(innerSnaps, keys, {
  sensitive: ["variables._input.ssn"],                // snapshots fold plaintext — cover them too (A1)
});

// `snapshotStore` is the RAW one: the tombstone follows the folded tip, which a compacted log's
// last event can sit below (ADR 0106). Required when `inner` can truncatePrefix.
await shredSubject(keys, inner, executionId, { reason: "gdpr-erasure", snapshotStore: innerSnaps });
// key destroyed; PAYLOAD_SHREDDED tombstoned at shred time (A3); any decrypting read now
// throws PayloadShreddedError — loud, never a silent divergence.
```

Snapshots are covered (or the secret survives the fold — erasure theater); a fork shares the
parent's **subject** so its copied ciphertext stays readable and shreds with the parent (A2).

**Retention & compaction (K10.1 / K10.4, `LogLifecycle`).** A kernel reclaims resources:

```ts
import { LogLifecycle } from "@loom/workflow-runtime";

const life = new LogLifecycle(eventStore, snapshotStore, {
  archive: { eventStore: archiveEvents, snapshotStore: archiveSnaps }, // A6 — archive first
  compactionArchive, // ADR 0138 — where `compact` MOVES the events it removes (an ArchiveStore)
});

// Reclaim a terminal execution older than its window (archive-before-delete, so the
// learning plane + deploy-sim corpus aren't starved):
await life.applyRetention(executionId, { terminalTtlMs: 30 * 86_400_000 }, Date.now());

// Compact a very long execution: archive the prefix, checkpoint, then truncate it (sequence 0
// preserved); `fold(snapshot, suffix) === fold(events)` still holds, so it replays byte-identically:
await life.compact(executionId);

// Audit: the moved events, byte-exact, digest-verified; with the surviving log this is the
// original log. Replay, resume and `readRange` never read the archive.
const moved = await life.readArchived(executionId);
const original = await life.readWithArchive(executionId);
```

**Compaction moves events, it never deletes them (ADR 0138).** `compact` appends the exact envelopes it
removes to an `ArchiveStore` (`compactionArchive`; in-memory, SQLite and Postgres backends ship, and
`sqliteStorage()` / `postgresStorage()` / `kind: "memory"` provide one) BEFORE it truncates, and it
**refuses** (`CompactionArchiveRequiredError`, nothing changed) when none is configured. A crash between
the two leaves a duplicate in the archive, never a gap, and a retry is idempotent. Over an encrypting event
store the archive must be an `EncryptingArchiveStore` on the SAME `KeyStore` (`PlaintextArchiveError`
otherwise), so a shred erases the archived copy too. Pass the archive to `sweepUnpinnedContent({ archiveStores })`
so a blob only an archived event cites is not reclaimed, and verify an audit hash chain across the
compaction with `verifyChain(id, { archived })` (`hashChainedEventStore(..., { allowCompaction: true })`).
An erasing `sweepUnpinnedContent` **checks every compacted log's removed range against the given `archiveStores`'
headers** and refuses (`ArchiveStoresRequiredError`) when it is not covered - `[]` no longer suffices. For logs
compacted before the archive existed (their history is already gone) pass `acknowledgeUnarchivedLogs: true`
("erasing their orphan blobs is accepted"; the executions are reported in `unarchivedAcknowledged`); a fork child
of a compacted parent needs it too. `loom sweep content` needs `--compaction-archive <archive.db>` (default:
`archive.db` beside `--db`; `--config` wires the app's) and, for such logs, `--acknowledge-unarchived`.
**The tenant guard is opt-in:** a multi-tenant deployment must set `durability.retention.tenant` (or use
tenant-scoped stores) to get the `ArchiveTenantMismatchError` refusals; an undeclared, unscoped stack reads as
single-tenant. A log compacted before the archive existed keeps its old
checkpoint as a `legacy-checkpoint` segment (`readLegacyCheckpoints`); `readArchived` / `readWithArchive` report a
range only that checkpoint remembers (`ArchiveIncompleteError`, `archiveCoverage`) instead of leaving a silent hole.
A segment is bound to its log's incarnation, so an execution id reused after a delete never inherits the old
archive; over a tenant-scoped event store the archive must be a `TenantScopedArchiveStore` for the same tenant.

**The durable inbox's streams are archived the same way (ADR 0139).** `trimInbox`, the per-topic trim, the quarantine
trim and a retired chain's delete MOVE the envelopes (ids, timestamps, sender metadata - the payload survives in
`MESSAGE_CONSUMED`) into the SAME archive, keyed by the reserved stream id, and refuse without one: through `defineConfig`
the compaction archive is handed to the runtime (`inboxArchive`); a hand-built runtime without it trims and deletes
nothing and reports a `ReservedStreamArchiveRequiredError` per chain through `onStorageError`. Read it back with
`life.readReservedWithArchive(streamId)` / `life.reservedArchiveCoverage(streamId)`; `exportSubject` returns it as
`reservedStreams`; a re-created stream starts above the archive, and a straggler lands in `<stream>#late-<n>`.

Both run over optional store SPI (`deleteExecution` / `truncatePrefix`, on in-memory, SQLite,
and Postgres); a store that omits them can't be swept. A compacted execution resumes, and
compacts again, exactly as if it had never been compacted (ADR 0106), and the event kinds in
`retention.pinnedEventTypes` survive compaction in place (`truncatePrefixKeeping`, SPI 1.5.0). Over an **encrypting** store, the
destination must share its `KeyStore`: `compact` throws `UnsafeCompactionError` unless the
snapshot store is an `EncryptingSnapshotStore` on the same keys, and `applyRetention` returns
`"unsafe-archive"` for an archive that isn't. Otherwise the decrypted fold or events would sit
outside the reach of a key shred (ADR 0022 Amendment).

**Redaction markers (K10.3).** Where crypto-shredding stores an *encrypted* secret in the log,
redaction keeps a secret **out of the log entirely** — a step carries a deterministic
reference, resolved to the real value only at effect execution:

```ts
import { redactionMiddleware, secretRef, InMemorySecretResolver } from "@loom/middleware";
const resolver = new InMemorySecretResolver(/* vault/KMS in production */);
new EffectRuntime([redactionMiddleware({ resolver })]);

// flow code passes a REFERENCE — STEP_STARTED logs the ref, never the secret:
await ctx.run(chargeStep, { amount, apiKey: secretRef("stripe-key") });
// the middleware resolves it into the value the TOOL sees; the durable log only
// ever contains { __loomSecret: "stripe-key" }. redactOutput does the same for
// secrets a tool RETURNS (replaced by a deterministic ref before STEP_COMPLETED).
```

**Encryption at rest (K10.5).** The two seams above are *application-layer* (Loom encrypts
fields / keeps secrets out of the log). Encrypting the store **files** themselves — against a
stolen disk or leaked backup — is a storage-layer concern: volume encryption
(FileVault/LUKS/encrypted-EBS for SQLite; managed-DB storage encryption or LUKS for Postgres),
or SQLCipher/TDE for per-file/per-cluster keys. All three layers stack; see
**[Encryption at rest](../loom-2.0/11-encryption-at-rest.md)** for the SQLite and Postgres
configuration and when to use which.

**Classify once, derive the wiring (K10-R1/R2/R6).** The hand-authored `sensitive: {…}` maps
above are the low level. In practice, mark the field **once** on its schema and every mechanism
derives its wiring — encryption, redaction, and egress scrubbing:

```ts
import { sensitive, secret, internal, externalized } from "@loom/classify";

const output = z.object({
  ssn: sensitive(z.string()),        // encrypt-at-rest + crypto-shreddable + scrubbed from egress
  apiToken: secret(z.string()),      // never persisted (substituted via secretRef)
  note: internal(z.string()),        // logged, but never egressed externally
  doc: externalized(z.object({…})),  // stored in a content store, log keeps a ref (ADR 0046)
});

// One key wires secret redaction; telemetry egress is auto-scrubbed for marked fields:
const app = defineConfig({
  storage,
  flows,
  security: { secrets: { resolver } },
  observability: { telemetry: [datadog] },
});
```

See **[Data classification](../data-classification.md)** for the full taxonomy + derive helpers,
and the [content-store seam](../adr/0046-content-store-seam-thin-authoritative-log.md) for `externalized()`.

**Data-subject rights (T3, `@loom/compliance`).** Event-sourcing makes GDPR Art. 15/20 (access,
portability) and Art. 17 (erasure) a *fold*. Wire a `subjectOf` resolver (and `tenantOf` for
multi-tenant isolation) and get a live subject index + export + erasure:

```ts
const app = defineConfig({ storage, flows,
  security: { compliance: { subjectOf: (e) => e.payload.input?.userId, erase: { shred } } } });

await app.exportSubject("user-42");             // Art. 15 access + Art. 20 portability
await app.eraseSubject("user-42");              // Art. 17 — liveness-gated (never shreds a live fold)
```

Operator sweeps over cold storage: `loom compliance report` (subject inventory) and
`loom retention run`. See **[Compliance](../compliance.md)**.

## Wire-level ABI (T2)

`@loom/wire-abi` lets a **non-TypeScript client** (any language, even a shell script) drive
executions over JSON-RPC. The wire protocol is a versioned *projection* of the K1 syscalls —
generated from `KERNEL_SYSCALLS`, so the hand-written `ctx` surface stays authoritative:

```ts
import { handleRpc, WIRE_ABI, FOLD_VECTORS, runFoldVectors } from "@loom/wire-abi";

// Mount the carrier on any transport (node:http, the A2A server, worker-server):
const response = await handleRpc(runtime, jsonRpcRequest);
// methods: execution.start / execution.resume / execution.getState / execution.cancel
// A wire client starts/resumes/reads; the KERNEL folds and runs every ring (K2/K3/K6/K7/K12)
// on its side of the wire — a wire client gains no bypass. The returned fold is
// byte-identical to an in-process run.
```

Cross-language conformance is executable: `FOLD_VECTORS` are plain-JSON event-log → expected-
fold fixtures any implementation can run (`runFoldVectors` is the TS reference), extending the
K1/K5 pins from "the fold understands these types" to "the fold produces exactly this state".

---

Back to [User Guide section 17](../user-guide.md#17-kernel-grants-quotas--supervision).
