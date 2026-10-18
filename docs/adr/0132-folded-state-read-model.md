# ADR 0132 — Folded-state read models: durable per-execution projections in `@loom/plugin-read-model`

- Status: **Proposed**
- Date: 2026-10-19
- Implements: the item [ADR 0058](0058-read-model-plugin.md) D4 deferred — *"an aggregate-state
  variant can layer on the same watermark machinery when a consumer needs it."*
- Builds on: [ADR 0058](0058-read-model-plugin.md) (watermarks, idempotent apply, cache-not-authority),
  [ADR 0093](0093-read-model-row-purge.md) (purge, watermarks untouched by erasure),
  [ADR 0095](0095-binding-semantics-pin.md) (declared fold `version`),
  [ADR 0049](0049-projection-on-demand-fold-code.md) (`projection$` fold shape),
  [ADR 0130](0130-sealed-payload-delivery-guard.md) (sealed payloads).
- **KERNEL_ABI unchanged; EVENT_SCHEMA unchanged.** No kernel, `@loom/app` or event-type change; wiring
  rides the same `onEvent` seam and catch-up scan as ADR 0058. A plugin SPI grows five **optional**
  methods: `READ_MODEL_STORE_SPI_VERSION` 1.1.0 → **1.2.0**.

## Context

`@loom/plugin-read-model` indexes **rows**: an extractor turns an event into zero or more rows and a
query pages over them. A consumer that needs *the current state of one thing* — "what is the ingestion
status of this document?" — has to query every row the thing ever produced and fold them itself, per
request. The first such consumer is DocMind: one ingest execution per document per generation
(`<user-scoped prefix>…ingest-<docId>`, a `.2` suffix for a re-ingest), and a UI list that needs the
current status of ~50 documents at once, behind Postgres row-level security.

The existing in-process `ProjectionRuntime` folds exactly this shape (`projection$`:
`{ id, version, initialState, handlers: { [eventType]: (state, event) => state } }`) but is ephemeral,
LRU-bounded and rebuilt from the log on restart ([ADR 0049](0049-projection-on-demand-fold-code.md)). What is missing is
the **durable** version of that fold, with the same discipline ADR 0058 gave rows.

Constraints carried over: `EventStore.subscribe` is per-execution, there is no global event order
(ADR 0058 D2), the layering guard forbids kernel packages naming plugins, and the log is the only
authority (P1).

## Decisions

### D1 — A second model kind, declared with the projection you already have

```ts
interface FoldedReadModelDefinition<TState> {
  projection: ProjectionDefinition<TState>;          // from projection$ — id, version, initialState, handlers
  keyOf?:   (executionId: string) => string | undefined;   // app key, e.g. documentId
  scopeOf?: (executionId: string) => string | undefined;   // tenant / RLS scope
}
service.registerFolded(def): Promise<{ rebuilt: boolean }>
```

No parallel declaration is invented: the fold is the `ProjectionDefinition` that `projection$` produces
(handlers keyed by event type, `(state, event) => state`), so an app can bind the same definition to the
ephemeral runtime and to the durable model. It is a *second kind beside* row extractors rather than a flag
on `ReadModelDefinition`: the two share a service, a catch-up scan and a store, but have different
read shapes (`query` pages rows; `getMany` returns states), and a flag would make half the definition
fields meaningless in each mode. Model ids share one namespace; registering a duplicate across kinds throws.

`registerFolded` is async because it resolves a compiler-emitted lazy handlers ref
(`loadProjectionHandlers`) and registers the fold version with the store (D5). The lazy-chunk gating of
ADR 0049 is therefore lost for durable models (the chunk loads at registration); the saving was for an
in-process runtime that folds every event, and this model only exists to be loaded.

### D2 — Folds are per execution; there is no cross-execution fold (decided, not deferred)

One state row per `(modelId, executionId)`, produced by folding **that execution's** events in
`sequence` order. Within one execution a total order exists (sequences are gap-free and monotonic), so
the fold is well-defined without any global order. A fold that spans executions would need a
commutative/associative/idempotent merge to converge under ADR 0058 D2's arbitrary arrival order; that is
a law the conformance suite could not enforce for user code, and DocMind does not need it. Rejected.

An app that wants *the document* across generations gets it from the **app key** (D9): `keyOf(executionId)`
maps `…ingest-<docId>` and `…ingest-<docId>.2` to the same `docId`, `getManyByKey` returns one record per
generation, and the caller picks (it owns the generation rule). If a later consumer needs a real
cross-execution fold, it needs its own ADR with a merge-laws check.

`keyOf`/`scopeOf` take the **executionId only**, never the event: they must be knowable at read, purge and
RLS time without opening a payload, and they must not copy event data (possibly sensitive) into an indexed
plaintext column.

### D3 — State and watermark are ONE row; the write is a monotonic compare-and-set

For folded models the watermark is the state row's `sequence`. There is no second table to keep atomic
with the first: a single-statement upsert is atomic on Postgres, a single transaction on SQLite, a single
map write in memory. A "scanned, nothing handled" batch writes a row with `state = NULL` and the advanced
`sequence`, preserving the RM-1 cold-start property (applied history is skipped) without storing an
initial-state row for every execution that never emitted a handled event. `NULL` therefore means "no
handled event yet", and a fold that returns `null`/`undefined` is refused (`TypeError`).

Convergence without locks. Writers fold deterministically from a contiguous base (D4), so any writer's
state at sequence *n* equals fold(events 0..n); the highest sequence wins and a lower or equal one is a
no-op:

```sql
-- applyFolded (Postgres). $1 model, $2 execution, $3 app_key, $4 scope, $5 sequence,
-- $6 state (jsonb, may be NULL), $7 fold version
INSERT INTO "<state>" (model_id, execution_id, app_key, scope, sequence, state, erased)
SELECT $1, $2, $3::text, $4::text, $5, $6::jsonb, false
WHERE EXISTS (SELECT 1 FROM "<folds>" h WHERE h.model_id = $1 AND h.version = $7 FOR SHARE OF h)
ON CONFLICT (model_id, execution_id) DO UPDATE
   SET sequence = EXCLUDED.sequence,
       state    = CASE WHEN "<state>".erased THEN NULL ELSE EXCLUDED.state END,
       app_key  = COALESCE(EXCLUDED.app_key, "<state>".app_key),
       scope    = COALESCE(EXCLUDED.scope,   "<state>".scope)
 WHERE "<state>".sequence < EXCLUDED.sequence
RETURNING sequence;
```

- `rowCount = 1` → `"applied"`. `0` → one more `SELECT version FROM "<folds>" WHERE model_id = $1`
  distinguishes `"version-mismatch"` from `"stale"` (an equal or lower sequence — an idempotent
  re-apply). The WHERE on `DO UPDATE` is what makes the watermark monotonic: two nodes folding the same
  tail race, one wins, the other is told `"stale"`, and both wrote the same bytes anyway.
- `FOR SHARE OF h` serializes against `beginFold`'s `FOR UPDATE` on the same header row (D5): a writer
  that read the pre-rebuild header blocks until the rebuild commits, then re-evaluates the predicate under
  READ COMMITTED and inserts nothing. Without it a pre-commit snapshot could insert an old-version row
  after the rebuild's DELETE.
- `erased` is sticky (D12): an erased row keeps advancing its sequence but never regains a state.
- SQLite runs the same statement (minus `FOR SHARE`) inside `db.transaction`; better-sqlite3 is a single
  writer, so the header check and upsert are serial by construction.

### D4 — The fold input is contiguous from the watermark, or it is not applied

A fold is not idempotent per event the way a row is: applying event *n* to a state that already included
it, or skipping *n−1*, silently corrupts the state. So the engine only folds events with
`sequence > watermark`, and **only from `watermark + 1`**:

- **Live tail** (`handleEvent`): if `event.sequence === watermark + 1` fold it; if `<= watermark`
  (a duplicate, or another node got there first) ignore it; if it is a gap (`> watermark + 1`, e.g. a
  cold node, a missed event, a restart mid-execution) read the missing tail from the configured
  `liveSource` (`ReadModelServiceOptions.liveSource`, normally the node's own event store) and fold from
  `watermark + 1`. With no `liveSource` the gap is reported to `onError` as `FoldGapError` and the next
  `catchUp` heals it. A gap is never papered over.
- **Catch-up / refresh / rebuild**: always `readFrom(executionId, watermark + 1)`.
- The live path serializes per `(modelId, executionId)` through a promise chain, because the
  read-state → fold → apply sequence is async and two interleaved applies would fold from the same base.
  Cross-node races are covered by D3, not by this queue.
- Each handler result is round-tripped through JSON before the next event, so the incremental state
  (persisted after every event) and the rebuilt state (folded in one batch) cannot differ by
  non-JSON values (`undefined` properties, `Date`, `Map`). That makes "rebuild == incremental" a property of
  the engine rather than of every handler (D14).

A handler that throws is reported to `onError` on the live path and **throws** from `catchUp`/`refresh`
(same stance as ADR 0058's extractors): the execution's watermark does not advance past a poison event,
which is a loud, bounded failure rather than a silently wrong state.

### D5 — Fold-code `version` is required, and a change rebuilds the model automatically

ADR 0095 made `version` a declared field and left `rebuild()` as the manual exit. For a durable fold that
leaves the exact silent hazard 0095 describes: rows from the old fold stay, watermarks are past the events,
and one `getMany` answers from two folds. Here the declaration is enforced:

- `registerFolded` **throws** if `projection.version` is missing or blank after trim (ADR 0095's
  "blank is undeclared" rule). A durable fold without a version cannot be rebuilt when it changes.
- A per-model header `(model_id, version)` lives beside the state. `store.beginFold(modelId, version)`
  runs at registration: first call creates the header; an equal version is a no-op; **a different version
  deletes that model's state rows and swaps the header, in one transaction** (`SELECT … FOR UPDATE` on the
  header). `{ rebuilt: true }` is returned. Because the watermark is the row's sequence (D3), "no rows" means
  the next `catchUp(sources)` re-folds every execution from the log — no manual `rebuild()` step.
- Every `applyFolded` carries the writer's version and is refused (`"version-mismatch"`, surfaced as
  `FoldVersionMismatchError` to `onError`) when it differs from the header. During a rolling deploy the old
  nodes stop projecting rather than corrupting the new fold. Reads during the rebuild window see missing
  states (not wrong ones); a boot sequence of `registerFolded` → `catchUp` → serve avoids even that.
- Honesty limit, as in ADR 0095: a declaration is a claim. An author who edits the fold without bumping
  the version gets no rebuild. Versions are opaque strings with no order, so a rollback to an older
  version also rebuilds (and flaps if old and new nodes keep restarting alternately). Accepted.
- `ReadModelService.pins()` / `checkPins` include folded models, so a derived artifact can still record
  which fold it read.

### D6 — Store SPI: five optional methods, `READ_MODEL_STORE_SPI_VERSION` 1.1.0 → 1.2.0

```ts
beginFold?(modelId, foldVersion): Promise<{ rebuilt: boolean }>;
applyFolded?(a: FoldedApply): Promise<"applied" | "stale" | "version-mismatch">;
getFolded?(modelId, executionIds: readonly string[]): Promise<FoldedRecord[]>;
getFoldedByKey?(modelId, keys: readonly string[]): Promise<FoldedRecord[]>;
purgeFolded?(modelId, selector: { executionId } | { key } | { scope }): Promise<number>;
```

MINOR, like ADR 0093: a backend that omits them behaves exactly as at 1.1.0, and
`registerFolded` against such a backend throws a typed `FoldedUnsupportedError` rather than accepting a
model it cannot persist. The five are all-or-none (the service checks all five). `clear(modelId)` now also
removes the model's folded state and header — an extension of "all rows and watermarks", and the only
sensible meaning of "drop everything for this model" once folded state exists. A new
`runFoldedStateConformance` kit in `@loom/conformance` pins the semantics (idempotent, monotonic,
version guard, tombstones, key lookup, isolation, concurrent convergence) and skips for backends without
the methods. In-memory (reference), SQLite and Postgres implement it.

### D7 — Batch read: `getMany` / `getManyByKey` (adopted)

```ts
service.getMany<S>(modelId, executionIds, opts?): Promise<Map<string, FoldedState<S>>>
service.getManyByKey<S>(modelId, keys, opts?): Promise<Map<string, FoldedState<S>[]>>
interface FoldedState<S> { executionId: string; key: string | null; sequence: number; state: S }
```

One round trip per call (`= ANY($2::text[])` / `IN (…)`), capped at `MAX_GET_MANY = 1000` keys (larger →
`RangeError`; empty → empty result; empty-string keys → `TypeError`). Absent executions, never-matched
executions (`state IS NULL`) and erased executions are simply **absent from the map** — a caller
cannot distinguish them, which for erasure is the point. `sequence` is returned so a caller that knows the
sequence of the event it just caused can see whether the state is at least that fresh without another call.

### D8 — Read-your-writes: read-repair from the log, not a synchronous apply (adapted)

The live tail is fire-and-forget by contract: `onEvent` is a synchronous callback in the execution
pipeline, so a UI that lists documents right after a step completes can read the state *before* the
async durable apply landed. Two ways to close that:

1. **Apply synchronously in the event path** — *rejected.* It would put a database write (and its failure
   modes) in the execution's critical path, directly against P10 (the advisory plane must never gate the
   kernel) and ADR 0058's rule that a throwing read model never breaks the pipeline. It also would not help a
   multi-node deployment, where the completing node is not necessarily the serving node.
2. **Read-repair against the log** — *adopted.* The log is the authority (P1), so "make this state at least
   as fresh as the log" is just a catch-up for named executions:

```ts
service.refresh(modelId, executionIds, sources, { concurrency?: number }): Promise<number /* executions advanced */>
service.getMany(modelId, ids, { refreshFrom: [eventStore] })   // refresh, then read
service.drain(): Promise<void>                                  // await the node's in-flight live applies
```

`refresh` serializes behind any in-flight live apply for that execution (so it also drains it), reads
`readFrom(id, watermark + 1)` and folds. It is correct from any node, needs no sequence from the caller, and
is a no-op round trip when the state is already current. Cost: one `getFolded` + one `readFrom` per execution
per call, so use it on the executions a user action just touched (the one document), not on every list view;
the plain `getMany` stays one query. The trade-off against fire-and-forget is thus explicit: the default read
is eventually consistent and free; read-your-writes is opt-in and costs a log tail read.

### D9 — App key and scope are derived columns; keyed lookup is IN, paging over state is OUT (adapted / rejected)

`keyOf(executionId)` is stored as `app_key` and indexed `(model_id, app_key)`; `getManyByKey` is an equality
lookup, which covers "status for these 50 document ids" in one query and keeps a DocMind-owned `documentId`
out of the framework's vocabulary. **Keyset paging and field filtering over folded state are not in v1.**
DocMind pages its own `documents` table and asks for the states of the 50 ids it already holds; paging *by
state* ("all documents currently failed") would need declared indexed state fields — i.e. the row model's
`indexes` machinery again — and is a separate decision with its own consumer. The state is a plain JSONB
column with `app_key`/`scope`, so an app that wants to join it in its own SQL can (D10).

### D10 — Postgres placement and tenant scoping: caller-chosen schema/tables, a `scope` column, RLS by policy

DocMind keeps tenant data under row-level security. Today `PostgresReadModelStore` takes only a pool; its
schema is whatever `search_path` that pool carries and its table names are fixed. For folded state:

```ts
new PostgresReadModelStore(pool, {
  schema?: string,                               // default: the pool's current schema
  tables?: { state?: string; folds?: string },   // defaults: read_model_state / read_model_folds
  manageSchema?: boolean,                        // default true; false = create no tables AND skip the shared migrate()
})
foldedStateDdl({ schema, tables }): string       // pure — put it in the app's own migration instead
```

- `manageSchema: false` is the least-privilege setting for the RLS **reader** instance: it neither creates
  the folded tables nor runs the shared `migrate()` (DDL a read-only role cannot, and must not, run).
- Identifiers are validated (`/^[A-Za-z_][A-Za-z0-9_]{0,47}$/`, so derived index names stay under 63 bytes) and double-quoted; they are never taken
  from event data. The folded tables are created lazily on first folded use, under an advisory lock, so
  apps that never register a folded model pay nothing and the shared `migrate()` is untouched.
- `scope` (nullable `TEXT`, from `scopeOf(executionId)`) is the column an RLS policy keys on, indexed
  `(model_id, scope)`. For DocMind `scopeOf` is the user-scoped prefix already in the executionId.
- **Writer and reader are different roles.** The ingest path (`onEvent`, catch-up) writes every tenant's rows
  and must not run under a tenant policy: give it a role with `BYPASSRLS` or a `TO loom_ingest USING (true)
  WITH CHECK (true)` policy. `INSERT … ON CONFLICT` needs SELECT visibility of the conflicting row, so the
  ingest policy must be `FOR ALL`. The request path constructs a **second** `PostgresReadModelStore` over a
  pool whose session sets `app.tenant` (or whatever the app's policy reads) and uses it only for
  `getMany`/`getManyByKey`:

```sql
ALTER TABLE docmind.read_model_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON docmind.read_model_state FOR SELECT TO docmind_app
  USING (scope = current_setting('app.tenant', true));
CREATE POLICY ingest_all ON docmind.read_model_state FOR ALL TO loom_ingest USING (true) WITH CHECK (true);
```

- *Rejected:* having the store `SET app.tenant` itself. The store does not know who the reader is, and a
  GUC set on a pooled connection is exactly the leak RLS exists to prevent. The app owns the session
  context.
- *Alternative offered:* a policy can instead test `starts_with(execution_id, current_setting('app.prefix'))`
  with no `scope` column; the column is the recommendation because it is indexable and survives a change of
  the id scheme.
- SQLite has no RLS; tenant isolation there is one file per tenant. `scope` is stored and purgeable anyway.

### D11 — State is stored in plaintext: it must be non-sensitive, or app-sealed

The fold sees events *after* the `EncryptingEventStore` has opened them, so whatever the handler copies
into `state` is written to the read-model table **in the clear**, outside the reach of the key that
protects the log. The framework cannot detect "sensitive" (the sealed-envelope guard of ADR 0130 only
recognises ciphertext, which is the safe case), so this is a documented obligation, not a check:
state holds identifiers, enums, counters and timestamps (`{ status: "parsing", step: "ocr", attempts: 2,
updatedAt }`), never document text, filenames or user-entered values; where a sensitive value must be
shown, the handler stores an app-sealed value the reader opens, or the UI reads it from the log under
the viewer's authority. D12 is the safety net for what slips through.

### D12 — Erasure: `purgeFolded` tombstones, never deletes the watermark (extends ADR 0093 D2)

```ts
service.purgeFolded(modelId, { executionId } | { key } | { scope }): Promise<number>
```

ADR 0093 D2: a purge must not clear a watermark, or the next catch-up re-derives what was erased from a
log that may still hold it. For folded models the watermark *is* the state row, so deleting the row would
do exactly that. `purgeFolded` therefore **tombstones**: `state = NULL, erased = true`, `sequence` kept.
The engine never folds an erased execution (it advances the sequence and leaves the state `NULL`), so later
events cannot resurrect a partial state from `initialState`. Exactly one selector field is required (an
empty selector is refused, ADR 0093 D3); the call drains the node's in-flight live applies first; it returns
the number of rows newly tombstoned (a retry returns 0); a backend without the method raises
`PurgeUnsupportedError`. Compliance wiring is the existing two-step: `eraseSubject(...)` then
`purgeFolded(model, { scope })`.

Un-tombstoning is `rebuild(modelId, sources)` (clear + re-fold), which has the same obligations as
ADR 0092 D6: rebuild through a source that tolerates shredded payloads, and make the handler treat
`{ $shredded: true }` as "skip", not as data. A tombstone is for an execution that exists; erasing a subject
whose execution has not started yet is the app's job (the shred makes its events unreadable).

### D13 — Wiring: unchanged seam, plus a per-execution queue and a `liveSource`

`service.handleEvent` fans out to row extractors and folded models; `catchUp(sources)` computes ONE
frontier per execution across both kinds (one shared `readFrom`, as the existing audit fix) and applies to
each. Boot order: `await registerFolded(…)` (may rebuild, D5) → wire `onEvent` → `catchUp([store])`. Events that
arrive between registration and wiring are healed by the catch-up, exactly as for rows. Errors follow
ADR 0058: live path → `onError`, catch-up path → throws.

### D14 — Rebuild equals incremental, pinned at two levels

The store kit pins the storage half (monotonic, idempotent, version guard). A service-level suite pins the
fold half: for an event log with interleaved executions, (a) incremental live apply, (b) one catch-up,
(c) catch-up after a partial prefix, (d) two services over one store applying the same events concurrently,
and (e) `rebuild` all yield byte-identical states. Replay never reads a folded model (queries are reads of
a cache, unrecorded), so determinism of the kernel is untouched by construction.

## Explicitly out of scope

- **Cross-execution folds** (D2) — would need a merge with enforced laws; separate ADR when a consumer exists.
- **Paging, range or field-filtered queries over folded state** (D9) — equality by `executionId`/`key`/`scope` only.
- **Push / subscription** of state changes — `@loom/live-query` territory; a durable model is read on demand.
- **An in-process state cache** in the live path — v1 does one `getFolded` read per handled event; add an LRU
  only against a measured ingest rate (the ADR 0058 posture on batching Postgres inserts).
- **State history / snapshots / compaction** — the log is the history; the model is the latest state only.
- **Event-time or wall-clock folds** — handlers are pure (P2); a handler needing time reads `event.timestamp`.
- **Automatic RLS role/policy creation** — the DDL helper and ADR text provide the shape; roles are the DBA's.

## Consequences

- DocMind's list view becomes one `getManyByKey(model, docIds, { refreshFrom: [store] })` per page (50 keys,
  one state query; the refresh variant adds one tail read per execution and should be reserved for the row the
  user just acted on) instead of a row query and a client-side fold per document.
- Live ingest costs one `getFolded` read and one upsert per handled event per model. Acceptable for
  status-shaped models (tens of events per execution); the cache in "out of scope" is the lever if it is not.
- Changing a fold is now a version bump and a boot-time re-fold, with the old nodes refused rather than
  corrupting — at the price that a rollback re-folds too.
- The Postgres store gains an options argument and two optional tables; the existing constructor form and
  the shared `migrate()` are unchanged. Third-party backends are unaffected until they implement the five methods.
- State is a plaintext copy of event data (D11): a new compliance surface, mitigated by the tombstone
  purge but not eliminated. `docs/compliance.md` gains a section next to the 0093 one.

## Principles check

| Principle | How the decisions satisfy it |
|---|---|
| **P1** log is truth | The model is a cache with a per-execution watermark; every state is recomputable from the log (D3, D5, D14); read-your-writes repairs *from the log* (D8) instead of treating the store as authoritative. |
| **P2** pure, deterministic fold | Handlers are the pure `(state, event) => state` of `projection$`; keys/scope are pure functions of `executionId`; per-event JSON normalization removes representation-dependent drift (D4); nothing is read on replay; no clock or randomness enters the fold (D14). |
| **P3** suspension normal | Nothing here parks or blocks an execution; a suspended execution's state is simply the fold so far. |
| **P4** plain code | The fold is the author's own function; no DSL. |
| **P5** static wiring | Models are registered explicitly at boot (D13); no discovery, no environment-conditional registration. The version header makes a drifted deployment refuse rather than diverge (D5). |
| **P6** composition | Reuses `ProjectionDefinition`, the existing service/catch-up/store, `iterateExecutionIds`, ADR 0093's purge posture; extends by optional methods, nothing replaced (D1, D6). |
| **P7** pure core, thin edges | Fold, key/scope derivation, contiguity rule and JSON normalization are pure and unit-tested with the in-memory store; SQL lives only in the backends; `foldedStateDdl` is a pure string builder (D4, D10). |
| **P8** pluggable edges | `ReadModelStore` stays the SPI; in-memory, SQLite, Postgres and any 3P backend implement the same optional methods against one conformance kit (D6). |
| **P9** logged non-determinism | Not applicable: the model introduces none (no clock, no randomness, no decisions); version bumps are build-time facts, not runtime choices. |
| **P10** minimal kernel | No kernel/ABI/schema change; the durable write is off the execution's critical path, which is why synchronous apply was rejected (D8); an app that never calls `registerFolded` pays nothing. |
| **P11** NL compiles to code | Not engaged: no runtime NL input. |
