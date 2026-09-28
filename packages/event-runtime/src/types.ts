import type { EventEnvelope } from "@loom/core";

export type { EventEnvelope };

/**
 * SPI version for the {@link EventStore} contract (ADR 0033). Bump MINOR when adding an
 * optional method, MAJOR when changing a required method's contract. Pinned by
 * `runEventStoreConformance` in `@loom/testing`.
 *
 * 1.1.0: added optional `listExecutions()` (enumerate distinct executionIds — powers
 *   `loom retention run` / `loom compliance report` over cold storage).
 * 1.2.0: added optional `listExecutionsPage()` (SP-1, db-copilot infra #184 — keyset-paged
 *   enumeration so maintenance passes run in bounded memory at year scale). Consumers use
 *   {@link iterateExecutionIds}, which prefers pages and falls back to `listExecutions()`.
 * 1.3.0: added optional `appendBatch()` (ADR 0074 D1 — one round-trip for many envelopes,
 *   which is what lets `CoalescingEventStore` raise the write ceiling). Consumers use
 *   {@link appendBatchOf}, which prefers it and falls back to a per-envelope `append` loop,
 *   so a backend that omits it is byte-identical to before.
 * 1.4.0: added optional `head()` (the tip as one indexed `MAX(sequence)` — `fork()` was
 *   reading the whole parent log to validate a fork point). Consumers use {@link headOf}.
 * 1.5.0: added optional `truncatePrefixKeeping()` (ADR 0106 — compaction that keeps an app's
 *   pinned event kinds, ADR 0055 D1). A store that omits it never loses an event, but
 *   `LogLifecycle.compact` then can NEVER compact past the first pinned event (it stops just
 *   below it on every pass, and warns): a long-lived execution that records a finding early
 *   keeps an unbounded replay tail on such a store.
 * 1.6.0: `listExecutionsPage()` ORDER pinned (L10). "Lexicographic" named no one order: a
 *   Postgres store paged in the database collation (`en_US.UTF-8`: `a_b` < `A1`) while
 *   `ShardedEventStore` merged in JavaScript's (`A1` < `a_b`), and resuming every shard from
 *   the merged page's last id skipped executions. Ids now page in Unicode CODE POINT order
 *   ({@link compareExecutionIds}; = UTF-8 byte order, SQL `COLLATE "C"`, SQLite BINARY), a
 *   cursor may be any string (the page holds the ids strictly after it), and `nextCursor` is
 *   the page's last id. No new method: a store that already paged in that order (SQLite, the
 *   in-memory store on BMP ids) conforms unchanged; the conformance kit checks it.
 *
 * Every optional method is listed in {@link OPTIONAL_EVENT_STORE_METHODS}; adding one here
 * without listing it there is a compile error. `OptionalEventStoreMethod` is derived from this
 * interface, and `DecoratorPlan` makes every one of its keys REQUIRED, so a new optional method
 * is also a compile error in every decorator whose plan `satisfies DecoratorPlan<EventStore,
 * OptionalEventStoreMethod>` until it forwards, overrides or refuses it. A decorator that uses
 * no plan at all is caught by the decorator conformance kit instead (and the `packages/spec`
 * fitness test makes every in-repo decorator run it).
 */
export const EVENT_STORE_SPI_VERSION = "1.6.0";

/**
 * Reserved-stream prefix. Control facts (retention `__loom_lifecycle__`, erasure
 * `__loom_erasure__`) are stored under executionIds beginning with this, so
 * {@link listExecutions} surfaces them too. Enumerators over *real* executions filter with
 * {@link isReservedStream}.
 */
export const RESERVED_STREAM_PREFIX = "__loom_";

/**
 * Whether an executionId names a reserved control stream rather than a real execution.
 *
 * The blank id `""` is reserved too (ADR 0107). It names no execution, and it is where the
 * pre-ADR-0106 compaction bug wrote the events of every resume that followed a compaction.
 * Reserving it keeps enumerators from treating that stream as an execution to recover, retain
 * or report, and keeps every runtime entry point from writing to it again.
 */
export function isReservedStream(executionId: string): boolean {
  return executionId === "" || executionId.startsWith(RESERVED_STREAM_PREFIX);
}

/**
 * Durable, append-only event log. Async-first so any backend plugs in —
 * synchronous stores (SQLite, in-memory) satisfy this trivially by marking
 * methods `async`; async/network stores (Postgres, Redis, DynamoDB) return
 * real Promises.
 *
 * Note there is no `nextSequence` — sequence allocation is owned by the
 * per-execution in-memory sequencer in `@loom/workflow-runtime` (ExecutionJournal),
 * so a backend never needs a read-then-write round-trip to append.
 */
export interface EventStore {
  /**
   * Append one envelope.
   *
   * A log has TWO uniqueness constraints, and a backend MUST enforce both — rejecting,
   * never overwriting and never silently treating the second write as a re-delivery:
   *
   * - **`(executionId, sequence)`**, rejected with {@link DuplicateSequenceError}. Not
   *   covered by fencing: fencing engages only once a token has been ACQUIRED for the
   *   execution, while sequences are allocated per-process from folded state (see the note
   *   above), so two unfenced writers recovering the same execution allocate the same next
   *   sequence with neither one a zombie. A backend that accepts both silently interleaves
   *   them into a log that every fold reads as truth.
   * - **`id`**, rejected with {@link DuplicateEnvelopeIdError}. Required WITHIN an
   *   execution. Store-wide uniqueness is what `PRIMARY KEY (id)` gives a single-log
   *   backend, and those are free to be stricter, but it is explicitly **not required** —
   *   {@link ShardedEventStore} cannot provide it (separate executions live on separate
   *   backing stores, and no shard sees another's ids), the same carve-out `appendBatch`
   *   makes for cross-execution atomicity. A backend that indexes ids separately must free
   *   them when the events they name are deleted or compacted away, or an erased execution
   *   can never be re-created.
   *
   * The two are different failures and must not be reported as each other: a taken
   * sequence means another writer reached that slot (a lost race, retryable by re-reading
   * and re-allocating), while a taken id means the same envelope identity was minted twice
   * (a bug in whatever produced it). The SQL backends get both from table constraints; a
   * backend without them checks explicitly.
   */
  append(envelope: EventEnvelope): Promise<void>;
  /**
   * OPTIONAL bulk append (ADR 0074 D1, SPI 1.3.0). Semantically **equivalent to calling
   * `append` once per envelope, in array order**, but in one round-trip — which is the
   * entire point, and the only part a caller cannot synthesize above the store boundary.
   *
   * Contract a backend MUST honour:
   * - **Atomic PER EXECUTION.** All envelopes for a given executionId land, or none of
   *   them do. That is the property a fold depends on: a partial write within one log
   *   could leave a hole (sequence 6 durable, 5 missing), which no fold expects. A prefix
   *   is fine — the run simply stops there.
   *
   *   Whole-batch atomicity across DIFFERENT executions is explicitly **not** required.
   *   {@link ShardedEventStore} cannot provide it — separate executions live on separate
   *   logs — and nothing needs it: a batch only ever groups INDEPENDENT executions, so
   *   nothing in it depends on anything else in it. A backend backed by a single
   *   transactional store will get whole-batch atomicity for free; do not rely on it.
   * - **Fencing per envelope, not per batch.** Envelopes may belong to DIFFERENT
   *   executions (that is exactly what {@link CoalescingEventStore} produces), so each is
   *   checked against its own execution's fence. Rejecting when any envelope is fenced out
   *   is correct; silently dropping just the fenced rows is not.
   * - **Reject, don't half-report.** If any envelope fails, the returned promise rejects —
   *   so a caller never reads a partial write as success. `CoalescingEventStore` propagates
   *   that rejection to every writer in the batch.
   * - **Uniqueness within the batch, too.** Two envelopes claiming the same
   *   `(executionId, sequence)` — or the same `id` — are each appendable against the
   *   durable log and conflict only with each other, so a backend that validates solely
   *   against stored rows admits the pair. Checking the batch against itself is part of
   *   the contract.
   * - **Empty input is a no-op**, not an error.
   *
   * A store that omits it is byte-identical to today — callers use {@link appendBatchOf},
   * which falls back to a sequential `append` loop. Implementing it is how a
   * bring-your-own backend opts into the batching win; `runEventStoreConformance` covers
   * the contract above so that implementation is verifiable.
   */
  appendBatch?(envelopes: readonly EventEnvelope[]): Promise<void>;
  read(executionId: string): Promise<EventEnvelope[]>;
  readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]>;
  /**
   * OPTIONAL bounded read of `[fromSequence..toSequence]` (both inclusive) for one
   * execution, ordered by sequence. Backends push the bound into the query (indexed
   * range) instead of loading the whole log and filtering in JS. A store that omits
   * it falls back to `readFrom` + filter, so callers must tolerate its absence — use
   * {@link readRangeOf}. Empty when `toSequence < fromSequence`.
   */
  readRange?(
    executionId: string,
    fromSequence: number,
    toSequence: number
  ): Promise<EventEnvelope[]>;
  /**
   * OPTIONAL tip query: the highest sequence durably stored for an execution, or `null`
   * when it has none. One indexed `MAX(sequence)` instead of materializing a log just to
   * ask how long it is.
   *
   * `fork()` is the motivating caller — it needs the tip to validate a fork point, and was
   * reading the ENTIRE parent log to get it even when the store could copy the prefix
   * natively. A store that omits this falls back to reading the log, so callers must
   * tolerate its absence — use {@link headOf}.
   */
  head?(executionId: string): Promise<number | null>;
  subscribe(executionId: string, handler: (event: EventEnvelope) => void): Promise<() => void>;
  /**
   * OPTIONAL fencing (K9.4). Atomically increment and return the execution's
   * monotonic fencing token (first call → 1). A dispatcher/worker acquires a
   * fence per dispatch; every envelope the run appends carries it in
   * `metadata.fence`. Once an execution has a fence, a store that implements
   * fencing MUST reject appends whose token is missing or lower than the
   * current one (throw {@link StaleFenceError}) — a re-dispatched execution's
   * zombie predecessor can no longer write. Executions that never acquire a
   * fence are entirely unaffected (zero overhead, G2); a store that omits this
   * method performs no fencing (e.g. single-node SQLite, where the process is
   * the failure domain).
   */
  acquireFence?(executionId: string): Promise<number>;
  /**
   * OPTIONAL bulk copy of the prefix `[0..throughSequence]` of one execution's log
   * into another `executionId`, re-stamping `id` + `executionId` and merging
   * `metadata` into each copied event — WITHOUT round-tripping payloads through JS
   * (de)serialization. Used by `fork()`; a store that omits it falls back to a
   * per-event `append` loop, so this is purely a performance fast-path.
   */
  copyPrefix?(
    fromExecutionId: string,
    toExecutionId: string,
    throughSequence: number,
    metadata: Record<string, unknown>
  ): Promise<void>;
  /**
   * OPTIONAL (K10.1 retention). Delete ALL events for an execution. Used by the
   * retention sweep after a terminal execution's retention window elapses
   * (archive-before-delete is the sweep's responsibility, not the store's). A
   * store that omits it cannot be swept — retention is opt-in per backend.
   */
  deleteExecution?(executionId: string): Promise<void>;
  /**
   * OPTIONAL (K10.4 compaction). Delete the prefix `(0..throughSequence]` of an
   * execution's log — **sequence 0 (the EXECUTION_STARTED bootstrap) is always
   * preserved** as the execution's metadata anchor (resume reads input/workflowId
   * from it). The caller MUST ensure a snapshot at a sequence
   * `>= throughSequence` exists first, so the invariant
   * `fold(snapshot, suffix) === fold(events)` holds — the store only truncates.
   */
  truncatePrefix?(executionId: string, throughSequence: number): Promise<void>;
  /**
   * OPTIONAL (SPI 1.5.0, ADR 0106). {@link truncatePrefix}, except that events whose
   * `eventType` is in `keepEventTypes` survive in place: delete the prefix
   * `(0..throughSequence]` of an execution's log, keeping sequence 0 AND every event of a kept
   * type. ONE atomic operation (SQL: a single `DELETE … AND event_type <> ALL($3)`), never a
   * read followed by per-row deletes, so a crash cannot leave a half-truncated prefix. With an
   * empty `keepEventTypes` it is exactly `truncatePrefix`. The kept events sit BELOW the
   * compaction checkpoint, where no reader folds them (every fold reads from
   * `snapshot.sequence + 1`); what reads them is policy that scans the log for its pinned kinds
   * (`pinByEventKinds`, the content sweep). Same precondition as `truncatePrefix`. A store that
   * omits it cannot be compacted past a log's first pinned event, ever.
   */
  truncatePrefixKeeping?(
    executionId: string,
    throughSequence: number,
    keepEventTypes: readonly string[]
  ): Promise<void>;
  /**
   * OPTIONAL enumeration of every distinct executionId in the store (unordered). Powers
   * operator sweeps that must visit all executions — `loom retention run`,
   * `loom compliance report`. Includes reserved control streams (`__loom_*`); callers that
   * want only real executions filter with {@link isReservedStream}. A store that omits this
   * cannot be swept over cold storage (there is no cheap fallback — enumeration requires a
   * scan the store alone can do efficiently, e.g. `SELECT DISTINCT execution_id`).
   */
  listExecutions?(): Promise<string[]>;
  /**
   * OPTIONAL keyset-paged enumeration (SP-1, SPI 1.2.0): distinct executionIds in Unicode
   * CODE POINT order (SPI 1.6.0 — {@link compareExecutionIds}; SQL `COLLATE "C"`, never the
   * database's collation), `limit` per page. `cursor` is an executionId — any string, not
   * only one this store returned — and the page holds the ids strictly after it; `nextCursor`
   * is the page's last id. `ShardedEventStore` depends on all three: it merges shard pages in
   * this order and resumes EVERY shard from the merged page's last id. Bounded-memory alternative to {@link listExecutions} for maintenance passes
   * (retention, the K10.6 sweep, read-model catch-up) over year-scale stores. Executions
   * created DURING iteration whose ids sort before the cursor may be missed — acceptable
   * for periodic maintenance jobs (they are visited on the next pass); do not use this for
   * exactly-once semantics. Same reserved-stream note as `listExecutions`.
   */
  listExecutionsPage?(opts?: { cursor?: string; limit?: number }): Promise<ExecutionPage>;
  close(): Promise<void>;
}

/**
 * The names of the OPTIONAL {@link EventStore} methods, derived from the interface itself —
 * a key whose `Pick` admits `{}` is optional. A decorator that forgets one silently takes that
 * capability away from everything above it (ADR 0074 Amendment), so decorators declare a
 * `DecoratorPlan` over this whole union.
 */
export type OptionalEventStoreMethod = {
  // biome-ignore lint/complexity/noBannedTypes: `{}` is exactly the test — a key whose Pick admits the empty object is optional
  [K in keyof EventStore]-?: {} extends Pick<EventStore, K> ? K : never;
}[keyof EventStore];

/**
 * The runtime list of {@link OptionalEventStoreMethod}, for the decorator conformance kit.
 * The check below makes a new optional method on the interface a compile error here until it
 * is listed — so the kit can never quietly stop checking one.
 */
export const OPTIONAL_EVENT_STORE_METHODS = [
  "appendBatch",
  "readRange",
  "head",
  "acquireFence",
  "copyPrefix",
  "deleteExecution",
  "truncatePrefix",
  "truncatePrefixKeeping",
  "listExecutions",
  "listExecutionsPage",
] as const satisfies readonly OptionalEventStoreMethod[];

type _MissingOptionalMethod = Exclude<
  OptionalEventStoreMethod,
  (typeof OPTIONAL_EVENT_STORE_METHODS)[number]
>;
// A new optional EventStore method that is not listed above makes this line a compile error.
const _exhaustiveOptionalMethods: [_MissingOptionalMethod] extends [never] ? true : never = true;
void _exhaustiveOptionalMethods;

/**
 * One page of {@link EventStore.listExecutionsPage}. `nextCursor` present iff more remain; a
 * page that carries a `nextCursor` carries at least one id (consumers such as
 * `ShardedEventStore`'s scatter-gather read an empty page as the end).
 */
export interface ExecutionPage {
  executionIds: string[];
  nextCursor?: string;
}

/** The enumeration surface of a store — what maintenance passes actually need. */
export interface ExecutionEnumerable {
  listExecutions?(): Promise<string[]>;
  listExecutionsPage?(opts?: { cursor?: string; limit?: number }): Promise<ExecutionPage>;
}

/**
 * SP-2 — the one enumeration loop every maintenance pass shares: prefers the
 * bounded-memory paged surface, falls back to `listExecutions()`, and REFUSES a
 * store with neither (silent partial passes are how retention deletes evidence
 * and read models under-index).
 */
export async function* iterateExecutionIds(
  source: ExecutionEnumerable,
  pageSize = 1000
): AsyncGenerator<string, void, void> {
  if (source.listExecutionsPage !== undefined) {
    let cursor: string | undefined;
    for (;;) {
      const page = await source.listExecutionsPage({
        ...(cursor !== undefined && { cursor }),
        limit: pageSize,
      });
      for (const id of page.executionIds) yield id;
      if (page.nextCursor === undefined) return;
      if (page.nextCursor === cursor) {
        // Audit hardening: a buggy store returning a non-advancing cursor would
        // spin every maintenance pass forever — refuse loudly instead.
        throw new TypeError(
          "iterateExecutionIds: listExecutionsPage returned a non-advancing cursor (store bug) — aborting the scan"
        );
      }
      cursor = page.nextCursor;
    }
  }
  if (source.listExecutions !== undefined) {
    for (const id of await source.listExecutions()) yield id;
    return;
  }
  throw new TypeError(
    "iterateExecutionIds: the store supports neither listExecutionsPage() nor listExecutions() — it cannot be enumerated"
  );
}

export interface EventStoreOptions {
  dbPath: string;
}

/**
 * Append many envelopes through a store that may or may not implement the optional
 * `appendBatch` fast-path (ADR 0074 D1). Uses the single round-trip when available, else
 * falls back to a sequential `append` loop — so callers never branch on the capability.
 *
 * The fallback is deliberately **sequential**, not `Promise.all`: `append` is
 * order-sensitive per execution, and a parallel loop would also lose the all-or-nothing
 * property that the native path guarantees. The fallback is a correctness-preserving
 * degradation, not a performance one — it wins nothing, and is not meant to.
 */
export async function appendBatchOf(
  store: EventStore,
  envelopes: readonly EventEnvelope[]
): Promise<void> {
  if (envelopes.length === 0) return;
  if (store.appendBatch !== undefined) return store.appendBatch(envelopes);
  for (const envelope of envelopes) await store.append(envelope);
}

/**
 * Read `[fromSequence..toSequence]` from a store that may or may not implement the
 * optional `readRange` fast-path. Uses the native indexed range when available,
 * else falls back to `readFrom` + a bounded slice — so every caller gets the
 * range without having to branch on the capability.
 */
/**
 * The tip of an execution's log through the optional {@link EventStore.head} fast-path,
 * falling back to reading it. `null` means the execution has no events at all.
 */
export async function headOf(store: EventStore, executionId: string): Promise<number | null> {
  if (store.head) return store.head(executionId);
  const events = await store.read(executionId);
  return events.length === 0 ? null : (events[events.length - 1]?.sequence ?? null);
}

export async function readRangeOf(
  store: EventStore,
  executionId: string,
  fromSequence: number,
  toSequence: number
): Promise<EventEnvelope[]> {
  if (toSequence < fromSequence) return [];
  if (store.readRange) return store.readRange(executionId, fromSequence, toSequence);
  const from = await store.readFrom(executionId, fromSequence);
  return from.filter((e) => e.sequence <= toSequence);
}
