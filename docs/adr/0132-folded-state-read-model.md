# ADR 0132 — Folded-state read models: durable per-execution projections in `@loom/plugin-read-model`

- Status: **Proposed**
- Date: 2026-10-19
- Implements: the item [ADR 0058](0058-read-model-plugin.md) D4 deferred — *"an aggregate-state
  variant can layer on the same watermark machinery when a consumer needs it."*
- Builds on: [ADR 0058](0058-read-model-plugin.md) (watermarks, idempotent apply, cache-not-authority),
  [ADR 0093](0093-read-model-row-purge.md) (purge, watermarks untouched by erasure),
  [ADR 0095](0095-binding-semantics-pin.md) (declared fold `version`),
  [ADR 0049](0049-projection-on-demand-fold-code.md) (`projection$` fold shape),
  [ADR 0130](0130-sealed-payload-delivery-guard.md) (sealed payloads: the envelope shape rule, the
  `metadata.seal` marker, `sealingCapability`), [`docs/data-classification.md`](../data-classification.md) (K10-R1: classify once,
  derive every mechanism's wiring).
- **KERNEL_ABI unchanged; EVENT_SCHEMA unchanged.** No kernel, `@loom/app` or event-type change; wiring
  rides the same `onEvent` seam and catch-up scan as ADR 0058. A plugin SPI grows five **optional**
  methods: `READ_MODEL_STORE_SPI_VERSION` 1.1.0 → **1.2.0**. `@loom/plugin-read-model` gains a dependency on
  `@loom/classify` (masking vocabulary only; the kernel still names no taxonomy, G3).

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
  sensitive?: SensitiveMap;                                // D11: payload paths a handler must never see
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

- `rowCount = 1` → `"applied"`, or `"applied-erased"` when the row was a tombstone (`RETURNING sequence, erased`: the
  sequence advanced, the state stayed `NULL`). `0` → one more `SELECT version FROM "<folds>" WHERE model_id = $1`
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

- **Live tail** (`handleEvent`): the engine is shown **every** event of an execution, handled or not
  (real executions always contain events no handler matches, and treating each as a gap would make the
  live path unusable without a `liveSource`). An event no handler matches writes nothing; it advances an
  in-memory *contiguous-through* pointer for that `(model, execution)`: "every event up to here is either
  folded into the stored state or was seen on this node and is unhandled". This is ADR 0058 D2's
  "advances the high-water mark even when no rows matched" without a store write per unhandled event. A
  handled event is applied when it is the next event after `max(watermark, pointer)`, and the watermark
  is persisted at its own sequence; if `<= watermark` (a duplicate, or another node got there first) it
  is ignored; anything else is a hole (`> max(watermark, pointer) + 1`: a cold node, a missed event, a
  restart mid-execution). A hole is filled by reading the missing tail from the configured `liveSource`
  (`ReadModelServiceOptions.liveSource`, normally the node's own event store) from `watermark + 1`. With
  no `liveSource` the hole is reported to `onError` as `FoldGapError` and the next `catchUp` heals it, so
  `liveSource` is optional and is needed only for holes. A gap is never papered over. The pointer is
  seeded by an execution's sequence-0 event, dropped when this node observes a hole in what it was shown
  and when the model is reset, and bounded in size; losing it costs one store read and at worst a hole
  fill, never a wrong state.
- **Catch-up / refresh / rebuild**: always `readFrom(executionId, watermark + 1)`, and they persist the
  final watermark even when the tail they read is unhandled.
- **The fold itself refuses to skip.** The first event a fold applies must be `watermark + 1`, or at most
  `pointer + 1` when the live path vouches for the events between (they are unhandled by construction);
  otherwise it raises `FoldGapError` and writes nothing, whichever feed called it.
- Every feed that writes (live, catch-up, refresh, rebuild) serializes per `(modelId, executionId)`
  through one promise chain, because the read-state → fold → apply sequence is async and two interleaved
  applies would fold from the same base. Cross-node races are covered by D3, not by this queue. The base
  state of a live apply is a `getFolded` read, or the node's bounded cache entry when one exists (D15).
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
- The version written to the header is the declared `version` plus a digest of the declared sensitive map
  (D11), so editing the sensitive paths rebuilds the model the same way a code change does.
- `ReadModelService.pins()` / `checkPins` include folded models, so a derived artifact can still record
  which fold it read.

### D6 — Store SPI: five optional methods, `READ_MODEL_STORE_SPI_VERSION` 1.1.0 → 1.2.0

```ts
beginFold?(modelId, foldVersion): Promise<{ rebuilt: boolean }>;
applyFolded?(a: FoldedApply): Promise<"applied" | "applied-erased" | "stale" | "version-mismatch">;
getFolded?(modelId, executionIds: readonly string[]): Promise<FoldedRecord[]>;
getFoldedByKey?(modelId, keys: readonly string[]): Promise<FoldedRecord[]>;
purgeFolded?(modelId, selector: { executionId } | { key } | { scope }): Promise<number>;
```

MINOR, like ADR 0093: a backend that omits them behaves exactly as at 1.1.0, and
`registerFolded` against such a backend throws a typed `FoldedUnsupportedError` rather than accepting a
model it cannot persist. The five are all-or-none (the service checks all five). `getFoldedByKey` returns its records ordered by `executionId` in byte (code-point)
order (on Postgres `COLLATE "C"`), the same on every backend. `clear(modelId)` now also
removes the model's folded state and header — an extension of "all rows and watermarks", and the only
sensible meaning of "drop everything for this model" once folded state exists. On Postgres it does so
only if the folded tables already exist and never creates them, so a store that never used a folded model
(or a role that cannot run DDL) clears exactly as it did at 1.1.0 (D10). A new
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
the plain `getMany` stays one query. Neither reads the state cache (D15).

`getManyByKey(model, keys, { refreshFrom })` has one stated limit: it refreshes only the executions that
already have a row for those keys (the key is derived from the executionId, so an execution with no row
has nothing to look up by key). The execution a user action has just started is refreshed by id —
`getMany(model, [executionId], { refreshFrom })` or `refresh` — which is the call D8 recommends for the
one execution a user touched anyway. The trade-off against fire-and-forget is thus explicit: the default read
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
  apps that never register a folded model pay nothing and the shared `migrate()` is untouched. `clear`
  (D6) never creates them either: it drops folded rows only when the tables already exist.
- `scope` (nullable `TEXT`, from `scopeOf(executionId)`) is the column an RLS policy keys on, indexed
  `(model_id, scope)`. `scopeOf` is derived **synchronously from the executionId** (owner decision, 2026-10-19), so it is knowable at read,
  purge and RLS time with no lookup. The DocMind example (Loom itself stays generic): its execution ids are
  `u_<userId>:<name>`, so `scopeOf` returns `<userId>`, and the app's own RLS policy maps scope → tenant through its own table.
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

### D11 — Sensitive-state guard: handlers never see declared-sensitive values, and the engine refuses to persist sealed or lifted ones

The fold sees events *after* decryption: the live `onEvent` carries the plaintext event the runtime
emitted, and catch-up / refresh / `liveSource` read through `EncryptingEventStore`, which opens sealed
fields on read. Whatever a handler copies into `state` is then written to the read-model table **in the
clear**, outside the reach of the key that protects the log. The owner decided (2026-10-19) that v1 must
not leave this to documentation alone. The guard is built only from primitives Loom already has:

| Reused primitive | Used for |
|---|---|
| `sensitive()` marks → `sensitivePathsFromSteps` / the `EncryptingEventStore` `sensitive` map (K10-R1, `docs/data-classification.md`) | the declared set: `eventType → payload dot-paths`, `[]` array wildcards allowed |
| `metadata.seal.covers` stamped on every envelope that holds a sealed field, and `sealingCapability().covers` (ADR 0130 residuals D7) | the marked set, with no configuration, on every read-through-store feed |
| The envelope shape rule: a plain object with an OWN string `__loomEnc` (ADR 0130 D2) | recognising ciphertext without keys or knowledge of the cipher |
| `maskPaths`, `expandPaths`, `REDACTED` (`@loom/classify`) | masking, wildcard resolution, the sentinel `"[redacted]"` |
| The bounded breadth-first walk, budget 100 000 nodes, exhaustion = fail closed (ADR 0130 D2) | every scan the guard makes |

```ts
type SensitiveMap = Readonly<Record<string, readonly string[]>>;   // eventType -> payload dot-paths

new ReadModelService(store, { sensitive });        // applies to every folded model on the service
registerFolded({ projection, sensitive? });        // per model; unioned with the service's map
sensitiveMapFromCovers(enc.sealingCapability?.()?.covers ?? [])   // derive the map from the sealing store
```

The effective path set for one event is `sensitive[eventType]` (service ∪ model) ∪ the entries of
`event.metadata.seal.covers` that name that event type. The marker survives decryption and is present on
raw reads, so it covers every catch-up source with zero configuration; the declared map is what covers the
**live** feed, whose event carries no marker. Hand the model the same constant the app gave
`EncryptingEventStore`.

**Layer 1 — the fold input (pure).** `foldView(event)` gives the handler a *copy* of the event in which
every effective path is replaced by `"[redacted]"` and any cipher envelope anywhere else in the payload is
replaced the same way. The original event never reaches a handler, and a handler can still see *that* the
field was present. Every feed (live, catch-up, refresh, rebuild; strict, tolerant or raw sources) now
presents byte-identical input, so rebuild == incremental holds regardless of source (D14), and a
`{ $shredded: true }` under a sensitive path is masked too. While building the view the engine records the
set of scalar values found under the effective paths of the **original** event (`Lifted`).

**Layer 2 — the state output (pure).** After every handler call, after the JSON round trip (D4) and before
anything is persisted, `assertStateClean(state, lifted)` walks the new state breadth-first and refuses it
when it contains:

1. a cipher envelope at any depth (`reason: "sealed-envelope"`) — Loom's own ciphertext is never a legal
   state value, even one that is validly sealed: the read model has no key lifecycle for it;
2. a string (length >= 6), or an integer (>= 6 digits), equal to a value lifted from this event's sensitive
   paths, as a value **or as an object key** (`reason: "lifted-value"`) — this is what catches a handler (or
   an upstream step) that mirrored the secret into a field nobody declared;
3. anything it cannot finish verifying inside the walk budget (`reason: "unverifiable"`, fail closed).

The refusal is a typed `SensitiveStateError { modelId, executionId, eventType, sequence, reason,
statePath }`. The message names the model, the execution and the path inside the state (`$.owner.email`;
a key hit reports the parent and `<key>`), **never the value**. It follows the poison-event rule of D4: on
the live path it goes to `onError`, from `catchUp` / `refresh` it throws, and the execution's watermark
does not advance. Failing loudly beats storing the secret.

**Fold version.** Because the declared map changes what handlers see, it is part of the model's identity:
the version written to the header (D5) is the declared `version` plus an 8-hex digest of the effective
declared map (`1+sens.3fa9c01b`; unchanged `version` when the map is empty). Editing the sensitive paths
rebuilds the model, and an old node with the old map is refused rather than diverging (P5). Pins report the
effective version.

**Why mask rather than "keep sealed".** The live event arrives plaintext, and a handler cannot be handed an
envelope it could open; masking is the one representation all four feeds can produce identically. A
catch-up source may also be the store's `readAtRest()` view (ADR 0130 D9), in which case the node never
decrypts for the fold at all and layer 1 masks the at-rest envelopes by marker.

**What it catches.** Declared and marked paths never reach a handler; ciphertext never reaches a handler or
a state; an exact copy (value or key) of a value from a sensitive path of the event being folded is refused
even when it travelled through an undeclared duplicate field; payloads and states too large to verify are
refused.

**What it cannot catch — stated plainly.** (a) Sensitive data in a field nobody classified or sealed: the
classification *is* the declaration, so unclassified means unguarded (K10-R1 G2). (b) A handler that
transforms a secret before storing it — hashing, truncation, case folding, concatenation, splitting,
substrings. (c) A copy of a value from an *earlier* event or another execution, or one short enough to fall
under the thresholds. (d) Data a handler obtains from outside the event (closures, module state, I/O);
handlers are pure by contract (P2), not sandboxed. (e) Free text in undeclared paths. The guard is a
seatbelt for a declared classification, not a data-loss-prevention scanner. The author's obligation stands:
state holds identifiers, enums, counters and timestamps; D12's purge is still the erasure path for whatever
slips through. There is no off switch in v1.

(f) **Lifted-copy detection needs the decrypted value.** On an at-rest source (a raw log whose sealed fields
are still cipher envelopes) only masking applies: the handler never sees the secret, but there is nothing to
compare a copy against, so a duplicate carried in an undeclared plain field is stored. The same event
arriving live, or through the decrypting store, is refused. (g) On the live feed with no declared map, a
sealed field whose seal marker is absent reaches the handler as delivered; declare the map to protect it.

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
the number of rows newly tombstoned (a retry returns 0). There is no `PurgeUnsupportedError` path for
folded models: a backend without the five methods was already refused at `registerFolded`
(`FoldedUnsupportedError`, D6), so a registered folded model always has `purgeFolded`. Compliance wiring is the existing two-step: `eraseSubject(...)` then
`purgeFolded(model, { scope })`. With D11 declared, the fold never held the declared values, so the purge is the
backstop for what the guard cannot see, not the primary control.

Un-tombstoning is `rebuild(modelId, sources)` (clear + re-fold), which has the same obligations as
ADR 0092 D6: rebuild through a source that tolerates shredded payloads, and make the handler treat
`{ $shredded: true }` as "skip", not as data. A rebuild that fails part-way (for example through a strict
source) leaves the model cleared, tombstones and watermarks included: a failed rebuild is an unfinished
rebuild, so re-run it through a tolerant source. A tombstone is for an execution that exists; erasing a subject
whose execution has not started yet is the app's job (the shred makes its events unreadable).

### D13 — Wiring: unchanged seam, plus a per-execution queue and an optional `liveSource`

`service.handleEvent` fans out to row extractors and shows every event to each folded model (an event no
handler matches is a no-write bookkeeping step, D4); `catchUp(sources)` computes ONE
frontier per execution across both kinds (one shared `readFrom`, as the existing audit fix) and applies to
each; the folded models' fold runs on the same per-`(model, execution)` queue as the live path (D4).
`liveSource` is optional and only fills holes (a restart mid-execution, a missed event). Boot order: `await registerFolded(…)` (may rebuild, D5) → wire `onEvent` → `catchUp([store])`. Events that
arrive between registration and wiring are healed by the catch-up, exactly as for rows. Errors follow
ADR 0058: live path → `onError`, catch-up path → throws.

### D14 — Rebuild equals incremental, pinned at two levels

The store kit pins the storage half (monotonic, idempotent, version guard). A service-level suite pins the
fold half: for an event log with interleaved executions, (a) incremental live apply, (b) one catch-up,
(c) catch-up after a partial prefix, (d) two services over one store applying the same events concurrently,
and (e) `rebuild` all yield byte-identical states. Replay never reads a folded model (queries are reads of
a cache, unrecorded), so determinism of the kernel is untouched by construction. Caveat (D11): a model
rebuilt from an at-rest source can hold a copy of a sealed value that a decrypted fold would refuse, so
catch-up and rebuild should prefer decrypted sources.

### D15 — A bounded per-node state cache on the live apply path (owner decision, 2026-10-19)

Without it, every handled live event costs one `getFolded` before its `applyFolded`. A hot execution (tens
of events in seconds) pays that read every time although this node wrote the previous row a moment ago. The
owner asked for a cache in v1, under one rule: it must never be able to weaken correctness.

```ts
new ReadModelService(store, { foldCache: { maxEntries: 1024 } })   // default 1024
new ReadModelService(store, { foldCache: false })                   // or { maxEntries: 0 }: disabled
```

A per-node LRU of `(modelId, executionId) → { sequence, state, erased }`, bounded by entry count, owned by
the `FoldedModelEngine`. The store's monotonic compare-and-set (D3) stays the only authority; the cache is
only a guess at the *base* a fold starts from.

- **Written** only after this node's own `applyFolded` returned `"applied"` (it holds exactly the row it just
  wrote) or `"applied-erased"` (it holds the erased marker `{ erased: true, state: null }`, never folded state), and read only by the live path (`applyLive`). `take` *removes* the entry, so any failure while a
  handler is running leaves the key absent rather than holding a half-mutated state.
- **Never decides a gap.** A cached base with `event.sequence` beyond the next expected one (the cached
  sequence, or the contiguous-through pointer of D4 when this node has seen unhandled events since) is
  dropped and the store is re-read first, because another node may be ahead. `event.sequence <= cached` is a safe
  ignore (the watermark is monotonic).
- **A lost CAS drops the entry and re-reads once.** `"stale"` from a write that started from a cached base
  means the cache was behind; the entry is discarded, the store row is read, and the same event is
  re-evaluated against it (ignored if the other node already folded it). `"version-mismatch"` drops every
  entry of the model before raising `FoldVersionMismatchError`.
- **Invalidated** by `registerFolded` / `beginFold` (version change), `purgeFolded` (the model's entries),
  `rebuild` / `clear` (the model's entries), and by any catch-up, refresh or rebuild write to the same
  execution (those paths advance the row behind the entry, so they delete it).
- **Never serves a read.** `getMany`, `getManyByKey` and `refresh` always go to the store: a cache that is
  correct for the write path (where the CAS catches staleness) would silently return stale data on a read
  path (where nothing does), and another node's progress or a purge elsewhere would be invisible.
- **A purge on another node** is covered by the store: the upsert keeps `state = NULL` for an erased row
  whatever base it was computed from, and reports `"applied-erased"`. The node then caches the erased marker, so
  its later events skip the handler (D12: the engine never folds an erased execution). The one fold that raced
  the purge is discarded by the store; it is never resurrected.
- **A local purge, register, reset or version mismatch** bumps a per-model generation; an apply that began
  before the bump never caches its result, so an in-flight apply cannot re-cache pre-purge state.
- Memory is bounded by count, not bytes; state is a status-shaped value (D11). A model with large states
  should lower `maxEntries` or turn the cache off.

Evidence is by counted store reads, never timing: N sequential live events on one execution read the row
once with the cache and N times without; the entry cap bounds the cache and an eviction costs exactly one
re-read; a lost CAS costs exactly one re-read and converges; two cached nodes (including nodes that each saw
only half of the events) converge with the cache disabled and with it enabled.

## Explicitly out of scope

- **Cross-execution folds** (D2) — would need a merge with enforced laws; separate ADR when a consumer exists.
- **Paging, range or field-filtered queries over folded state** (D9) — equality by `executionId`/`key`/`scope` only.
- **Push / subscription** of state changes — `@loom/live-query` territory; a durable model is read on demand.
- **Serving reads from the state cache** (D15) — the cache is write-path only; `getMany` / `refresh` hit the store.
- **A sensitive-value *detector*** (entropy, regex, ML scanning of state) — D11 guards what is declared or sealed and states
  its limits; guessing at undeclared sensitivity is a different product.
- **An off switch for the sensitive-state guard** — not in v1.
- **State history / snapshots / compaction** — the log is the history; the model is the latest state only.
- **Event-time or wall-clock folds** — handlers are pure (P2); a handler needing time reads `event.timestamp`.
- **Automatic RLS role/policy creation** — the DDL helper and ADR text provide the shape; roles are the DBA's.

## Consequences

- DocMind's list view becomes one `getManyByKey(model, docIds, { refreshFrom: [store] })` per page (50 keys,
  one state query; the refresh variant adds one tail read per execution and should be reserved for the row the
  user just acted on, which is refreshed by id because the key variant refreshes only executions that already
  have a row, D8) instead of a row query and a client-side fold per document.
- Live ingest costs one upsert per handled event per model, plus one `getFolded` read only on a cache miss (D15):
  the first event of an execution on this node, an eviction, or a lost CAS. `foldCache: false` restores a read per event.
- Handlers see `"[redacted]"` where a declared-sensitive field was, and a fold that mirrors a secret into state fails
  loudly instead of storing it (D11). The cost is one bounded walk of the payload per folded event and one of the new
  state, and an app must hand the model the same sensitive map it gave the encrypting store (or derive it with
  `sensitiveMapFromCovers`).
- Changing a fold is now a version bump and a boot-time re-fold, with the old nodes refused rather than
  corrupting — at the price that a rollback re-folds too.
- The Postgres store gains an options argument and two optional tables; the existing constructor form and
  the shared `migrate()` are unchanged. Third-party backends are unaffected until they implement the five methods.
- State is still a plaintext copy of whatever event data the guard cannot recognise (D11 states exactly what it can
  and cannot catch): a compliance surface, reduced by the guard and backstopped by the tombstone purge. `docs/compliance.md`
  gains a section next to the 0093 one.

## Principles check

| Principle | How the decisions satisfy it |
|---|---|
| **P1** log is truth | The model is a cache with a per-execution watermark; every state is recomputable from the log (D3, D5, D14); read-your-writes repairs *from the log* (D8) instead of treating the store as authoritative; the state cache is a guess at the base that the store's CAS corrects and it never serves a read (D15). |
| **P2** pure, deterministic fold | Handlers are the pure `(state, event) => state` of `projection$`; keys/scope are pure functions of `executionId`; per-event JSON normalization removes representation-dependent drift (D4); nothing is read on replay; no clock or randomness enters the fold (D14); the handler's input is a pure function of the event and the declared paths, and those paths are part of the fold version, so changing them rebuilds (D11). |
| **P3** suspension normal | Nothing here parks or blocks an execution; a suspended execution's state is simply the fold so far. |
| **P4** plain code | The fold is the author's own function; no DSL. |
| **P5** static wiring | Models are registered explicitly at boot (D13); no discovery, no environment-conditional registration. The version header (code version + sensitive-map digest) makes a drifted deployment refuse rather than diverge (D5, D11). |
| **P6** composition | Reuses `ProjectionDefinition`, the existing service/catch-up/store, `iterateExecutionIds`, ADR 0093's purge posture; extends by optional methods, nothing replaced (D1, D6). |
| **P7** pure core, thin edges | Fold, key/scope derivation, contiguity rule and JSON normalization are pure and unit-tested with the in-memory store; SQL lives only in the backends; `foldedStateDdl` is a pure string builder; the sensitive-state guard (`foldView`, `assertStateClean`) and the LRU are pure and unit-tested without a database (D4, D10, D11, D15). |
| **P8** pluggable edges | `ReadModelStore` stays the SPI; in-memory, SQLite, Postgres and any 3P backend implement the same optional methods against one conformance kit (D6). |
| **P9** logged non-determinism | Not applicable: the model introduces none (no clock, no randomness, no decisions); version bumps are build-time facts, not runtime choices. |
| **P10** minimal kernel | No kernel/ABI/schema change; the durable write is off the execution's critical path, which is why synchronous apply was rejected (D8); an app that never calls `registerFolded` pays nothing; the cache removes a read from the advisory plane and cannot block it (D15). |
| **P11** NL compiles to code | Not engaged: no runtime NL input. |
| **K10-R1 / G2 / G3** classify once, unmarked is a no-op, kernel ignorant of the taxonomy | The guard consumes the existing `sensitive` marks, `metadata.seal` and `sealingCapability`; it adds no class and no kernel knowledge; an unclassified field is unguarded, and D11 says so (D11). |
