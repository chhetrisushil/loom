# ADR 0129 — Close the `creationMarker` ABA: a store-assigned incarnation, kept out of the envelope

- Status: **Accepted** (2026-10-11) — option A, user decision 2026-10-11; implemented (see "Implementation note").
- Date: 2026-10-11
- Closes (if accepted): the logged follow-up "ABA nonce for `creationMarker` (breaks byte-identical replay — needs a design)" and [ADR 0116](0116-late-outcome-attach.md) round 4 item 7.
- Builds on: [ADR 0116](0116-late-outcome-attach.md) (`appendIfUnchanged`, `TipObservation.anchor`), [ADR 0118](0118-acquire-if-parked-fence.md) (the fence row the conditional write locks).
- Placement: **SPI semantics + the three reference stores** (`EventStore` SPI, `@loom/plugin-sqlite`, `@loom/plugin-postgres`, in-memory). Not the fold, not the envelope, not `EVENT_SCHEMA`. 3P stores are unaffected until they choose to claim the new SPI minor.
- Version impact if accepted: `EVENT_STORE_SPI_VERSION` 2.2.0 -> **2.3.0** (minor, semantic: no signature changes). `EVENT_SCHEMA`, `KERNEL_ABI`, `SNAPSHOT_STORE_SPI`, wire vectors: unchanged.

## Context

`recordOutcome` (a late reward on a finished execution) is a read-then-write: it observes the tip `{ head, fence, anchor }`, validates against the fold, then calls `appendIfUnchanged(id, event, expect)`, which commits only if the stored tip is still exactly what was observed. The `anchor` exists because `head` and `fence` alone cannot tell "the log I observed" from "that id was deleted and re-created and happens to have the same head and token" (envelope ids are deterministic, `<exec>-<seq>`).

Today `anchor = creationMarker(seq-0 envelope) = "<timestamp>:<id>"` (`packages/event-runtime/src/creationMarker.ts`, derived identically by the in-memory, SQLite and Postgres stores). It is derived at read time from the sequence-0 row; nothing stores it.

### The ABA, precisely

1. Observer reads execution `E`: head 12, fence 0, anchor `"1000:E-0"`.
2. `E` is deleted (`deleteExecution`: retention, an operator, a test harness) and re-created under the same id. The new sequence-0 envelope has the same id (`E-0`) and, if the clock gave the same value (frozen/virtual clock, or two starts within one clock tick), the same timestamp. It is driven to head 12, token 0.
3. Observer's `appendIfUnchanged` sees head, fence and anchor all equal and appends at slot 13. The outcome lands on a different incarnation.

When is it harmful? The late outcome names a `decisionId`; `recordOutcome` validated it against the OLD fold. The new incarnation has the same sequence-0 envelope id and timestamp, but its input and later events can differ. If a decision with that id exists there it is credited with someone else's reward (poisoning learning evidence); if none exists the fold gets an `_outcomes` row joined to nothing. Both need: same id reused, same millisecond, same head and fence, AND a write racing the delete+recreate between observe and write (8 retries, microseconds to milliseconds apart on one process; wider across a slow Postgres round trip).

### Who is affected in practice

- **Real deployments with retention then id reuse:** the delete and re-create are separated by at least a retention sweep and a new start; timestamps differ. Covered today. A same-millisecond collision needs a deliberate delete-and-restart of a caller-chosen id (ADR 0103 durable bootstrap ids make this possible but it still needs the race).
- **DST / test harnesses under a frozen or virtual clock:** the realistic population. Time never advances, so EVERY re-creation of an id has the same `timestamp`. A harness that deletes and re-creates an id while a late write is in flight (the very scenario a fault-injection test exercises) can see the false match. ADR 0116 documents this and advises varying the id.
- **Byte-identical re-creation** (DST replay of the same seed): the two incarnations are the same log up to head. The swapped write is semantically a no-op in state terms, since the fold is a pure function of the log. The hole only matters where the incarnations DIVERGE (different input / events) while sharing id, timestamp, head and token.

Severity: low likelihood, narrow window, learning-evidence corruption rather than kernel-state corruption. It is the correctness gap in an otherwise exact CAS, which is why it was logged rather than ignored.

### Why "a random nonce in the envelope" breaks replay

The obvious fix puts a nonce in the sequence-0 envelope's metadata. The envelope is the recorded fact: DST seeds compare logs byte for byte, the golden logs and the cross-implementation fold vectors compare envelopes, and the hash chain (`plugins/audit-chain`) hashes them. A random value there makes two runs of the same seed differ. Determinism of the LOG is the invariant; the nonce must therefore never be in an event or in folded state.

## Options

**A. Store-assigned incarnation counter, outside the envelope (recommended).** The store assigns a monotonically increasing integer when it durably creates an execution (the insert of sequence 0) and returns it inside the opaque `anchor`. It lives in store metadata only, never in an event, a fold, a snapshot or a hash.
- Memory: a store-wide counter; the incarnation is kept beside the log array and dropped with it.
- SQLite: a nullable `incarnation INTEGER` on the existing `executions` table (`plugins/sqlite/src/schema.ts`), set on first insert from `MAX(incarnation)+1` inside the write transaction (SQLite writes are serialised); an `ALTER TABLE ... ADD COLUMN` in the existing idempotent schema step.
- Postgres: a nullable `incarnation BIGINT` on `events`, filled only for `sequence = 0` rows by `nextval('events_incarnation_seq')` (`CREATE SEQUENCE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS` in the concurrency-safe migration, same pattern as `timers.redrive`). A Postgres sequence never reuses a value after a delete, so a re-created id always gets a larger one. The tip query (`tipSql`) reads it beside `a_id`/`a_ts`.
- `anchor = "<incarnation>"` when present, else the legacy `"<timestamp>:<id>"` for a log created before the migration. An observation taken before an upgrade stays valid across it (a legacy log keeps its legacy anchor until deleted); a log re-created after the upgrade gets an incarnation, so it can never equal a legacy anchor.
- Decorators already forward `anchor` untouched (tenant scope, sharding, coalescing, profiling, encryption, content): no decorator change. `creationMarker()` stays exported for stores that cannot assign one and as the legacy derivation.
- Replay byte-identity: preserved by construction. Nothing recorded changes; `fold`, envelopes, snapshots, hash chains and DST seeds are untouched. The counter is non-deterministic across runs, but it is only compared within one store between two observations of one process.
- Compaction (`compact` preserves sequence 0) and fork (a new execution with its own seq-0 insert) need no special case. A bulk copy tool that re-inserts sequence 0 gets a fresh incarnation, which is the right answer.

**B. Deterministic digest of the log (no new state).** `anchor = digest(seq-0 envelope payload) + head-event digest`. Closes the divergent-incarnation case with no schema change, and byte-identical re-creations remain "equal", which is harmless as argued above. Costs: a hash of two payloads per observation (the tip payload can be large), canonical-JSON stability across `jsonb` and across the encrypting decorator (ciphertext digest is stable per stored row but the decorator forwards what the inner store sees, so it is consistent), and it is a proof of "same content", not "same incarnation". It is the right answer only if a schema migration is unacceptable.

**C. Nonce in the sequence-0 envelope metadata.** Rejected: non-deterministic recorded envelope (see Context).

**D. Per-execution UUID column.** Same shape as A but random: not monotonic, needs UUID generation in each store, gains nothing over a counter, and a monotonic value additionally gives retention tooling an ordering. Rejected in favour of A.

**E. Keep documenting it.** Zero cost; the gap stays for frozen-clock harnesses. A reasonable choice if no consumer ever hits it: the in-repo evidence is one documented caveat and no reported incident.

## SPI and conformance impact (option A)

- `EVENT_STORE_SPI_VERSION` 2.2.0 -> 2.3.0, header comment extended: "the `anchor` MUST differ between two incarnations of an execution id, even when their sequence-0 envelopes are byte-identical". A store that cannot implement it keeps 2.2.0 behaviour and is simply not claiming 2.3.0.
- `docs/spec/compatibility-matrix.md` (regenerate), the spec's EventStore section (`docs/spec/loom-kernel-specification.md`, the `appendIfUnchanged` paragraph), `docs/cheatsheet-features.md`, `docs/usage-cli.md` version strings.
- Conformance kit (`packages/conformance`): new case(s) in the `appendIfUnchanged` group: (1) append events to `E`, observe, `deleteExecution(E)`, re-create `E` with byte-identical envelopes to the same head, then `appendIfUnchanged` with the stale observation answers `moved`; (2) the observation of a never-recreated log stays `appended: true` (no false refusals); (3) the anchor is stable across two observations of one incarnation and across a compaction. The existing frozen-clock expectations (if any assert equality across re-creation) invert. Decorator conformance picks the cases up through the existing "every in-repo decorator runs it" fitness test.
- Migrations: Postgres `ADD COLUMN IF NOT EXISTS` + `CREATE SEQUENCE IF NOT EXISTS` inside the existing advisory-locked migration (concurrent-start safe, per `migrate-concurrency.test.ts`); SQLite `ALTER TABLE ADD COLUMN`. Both nullable and online; existing logs keep the legacy anchor; no backfill. A rollback to a 2.2.0 kernel is safe because it ignores the column and derives `creationMarker` as before.
- Tests: the Postgres/SQLite/memory conformance runs; a Postgres migration test mirroring `timerMigration.test.ts` (pre-migration log observed, store upgraded, observation still valid; delete+recreate after upgrade is `moved`).

## Triage (ADR 0083 / P10)

Not kernel (no event, fold, syscall or ABI). It is an SPI semantic tightening in the stores, so it is "kernel-adjacent": the EventStore SPI minor is the only contract change, and all three in-repo stores change together. There is no 3P placement (a plugin cannot assign incarnations for a store it does not own). Consumers: `recordOutcome` / `LogLifecycle` (R11 late outcomes, the only users of `appendIfUnchanged` today); the second consumer to name before acceptance is any future conditional write (for example the ADR 0118 style compare-and-set family) that needs "same incarnation" and should not rebuild this. Smallest safe change = option A. If the user decides the harness-only population does not justify a column per store, option E (status quo) or option B (no schema) are the two honest alternatives.

## Decision needed from the user

1. Close it at all (A or B), or keep it documented (E)? Recommendation: A, because it is the only option that is exact and leaves replay untouched; B if you will not take a schema migration.
2. If A: accept `EVENT_STORE_SPI_VERSION` 2.3.0 as a semantic minor with a new MUST on `anchor`?
3. If A: Postgres column on `events` (sequence-0 row only; proposed) versus a column on the `fences` row (that row is lazily created and reclaimed with the log, which makes it a worse home)?
4. If A: legacy logs keep the old `timestamp:id` anchor until deleted (proposed, no backfill) versus a one-time backfill?

## Decision (user, 2026-10-11)

Option A, with the recommended defaults: close it; `EVENT_STORE_SPI_VERSION` 2.3.0 as a semantic minor with the new MUST on `anchor`; Postgres column on `events` (sequence-0 row only); legacy logs keep the old `timestamp:id` anchor until deleted (no backfill).

## Implementation note

- **Memory** (`InMemoryAsyncEventStore`): a store-wide counter; the incarnation is taken when sequence 0 first lands (in `setLog`, so append, batch and `copyPrefix` all assign) and is dropped by `deleteExecution` / `close`. The anchor is its decimal string.
- **SQLite**: a nullable `incarnation INTEGER` on the `events` table, on the sequence-0 row, not on `executions` (that table is not maintained by the event store, so a column there would need a second write on every creation and delete). An `AFTER INSERT ... WHEN NEW.sequence = 0` trigger bumps a one-row `incarnation_counter` and stamps the row, so every insert path (and another process) assigns one. The counter is never reset, so a delete cannot make a value reusable (`MAX()+1` would). The column is added by a `PRAGMA table_info` check plus `ALTER TABLE`, tolerating a concurrent migrator; counter and trigger are `IF NOT EXISTS`.
- **Postgres**: a nullable `incarnation BIGINT` on `events` and `events_incarnation_seq`; a `BEFORE INSERT ... FOR EACH ROW WHEN (NEW.sequence = 0)` trigger fills it from `nextval`. The block runs last in `runMigration`, under the existing advisory lock, with every step guarded by the catalog (so a normal boot takes no `events` lock), and the ALTER / CREATE TRIGGER wait under `loom.migration_lock_timeout`, the same pattern as `timers.redrive`. The tip query reads it beside `a_id` / `a_ts`.
- **Anchor**: the incarnation's decimal string, or the legacy `timestamp:id` (contains a `:`, so it can never equal an incarnation) when the column is NULL. `creationMarker()` is kept as the legacy derivation. No backfill; a rollback to a 2.2.0 kernel ignores the column.
- **Decorators**: tenant scope, sharding, coalescing, profiling, encryption, content, audit-chain, DST fault store and the crash harness all forward `expect` and return the inner `anchor` untouched; none rebuilds an anchor, EXCEPT `ShardedEventStore` (review round 1, P3-6): per-shard counters can issue the same number, and `migrateExecution` re-creates a log on another shard, so it hands out `s<shardIndex>/<inner anchor>` and strips the prefix when routing an observation (an observation issued by another shard is passed through unchanged and answers `moved`). The prefix starts with a letter, so it can equal neither a bare incarnation (digits) nor a legacy `<timestamp>:<id>` (digits first).
- **Conformance** (`@loom/conformance`, +3 cases): a delete plus a byte-identical re-creation (same id, timestamp, head, token) is `moved`; repeated observations agree and each is honoured (no false refusals); the anchor is stable across later appends and a compaction. Plus a Postgres migration test (old-shape `events`, concurrent `migrate`, legacy anchor kept, new logs get incarnations, delete plus recreate is `moved`) and a SQLite equivalent.
- **3P stores**: one claiming 2.3.0 must satisfy the MUST (documented in the spec, `docs/usage.md`, the SPI header comment); one that cannot stays at 2.2.0.

## Review round 1 (Postgres install and lookup availability)

- **The install can fail to happen, so the store reports it.** L10 now sets the "events is locked" flag only for `lock_not_available`, `query_canceled`, `deadlock_detected` (a dependent view recurs on every boot and says nothing about the lock). When the incarnation step still cannot install (events locked, `insufficient_privilege`, a dependent object) the boot emits ONE `onWarn` message (default `console.warn`; `MigrateOptions.onWarn` / `PostgresEventStoreOptions.onWarn`) naming the cause, and `PostgresEventStore.incarnationAnchors()` reports the EFFECTIVE capability: `false` means this store behaves as SPI 2.2.0 (legacy anchor, a delete + byte-identical re-creation is not detected) and must not be treated as a 2.3.0 store. A 3P wrapper that advertises the SPI level should consult it.
- **Lookup.** The column probe caches only `true`; a failed probe is never cached (the next call retries), and a `false` is re-probed at most every `incarnationRecheckMs` (default 30 s, injectable `clock`), so a node picks up a column another node installed later without a restart.
- **Function.** `events_assign_incarnation()` is created only when missing or of an older body (version comment `loom-incarnation-v2`), so a boot after the tables were re-owned to an application role is a no-op; if it would need replacing and the role cannot, that is a warning, not a failed boot. It is `SECURITY DEFINER` with `search_path = pg_catalog` and a baked, schema-qualified `nextval('<schema>.events_incarnation_seq'::regclass)`, so it is correct under any inserting session's `search_path` (`pg_restore --data-only`, ETL) and for a writer role without sequence rights, and never draws another loom schema's sequence.
- **Conformance.** `runEventStoreConformance(factory, label, { eventStoreSpi: "2.2.0" })` skips the three 2.3.0 cases for a store that does not claim them (default `"2.3.0"`); `incarnationAnchorProblem(factory)` asks the MUST without a test runner.
