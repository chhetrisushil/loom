import { createHash } from "node:crypto";
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
 * 2.0.0: `listExecutionsPage()` ORDER and CURSOR pinned (L10, ADR 0108). "Lexicographic"
 *   named no one order: a Postgres store paged in the database collation (`en_US.UTF-8`:
 *   `a_b` < `A1`) while `ShardedEventStore` merged in JavaScript's (`A1` < `a_b`), and
 *   resuming every shard from the merged page's last id skipped executions. Ids now page in
 *   Unicode CODE POINT order ({@link compareExecutionIds}; = UTF-8 byte order, SQL
 *   `COLLATE "C"`, SQLite BINARY); the cursor, which was OPAQUE, is now an executionId — any
 *   string, the page holding the ids strictly after it; and `nextCursor` MUST be the page's
 *   last id. MAJOR because a conforming 1.x store (any order, any opaque cursor token) can
 *   fail the kit, and `TenantScopedEventStore`/`ShardedEventStore` now depend on all three —
 *   the same rule that made MemoryStore 2.0.0 (ADR 0091). No method was added or removed: a
 *   store that already paged ids in that order with id cursors (SQLite; the in-memory store
 *   on well-formed BMP ids) conforms unchanged.
 * 2.1.0: the optional `acquireFenceIf(id, { fence, parkSeq })` (ADR 0118 R8k: an atomic
 *   compare-and-set on the fence token AND "no answering event past the park"). The constant
 *   moved with the rest of the Wave 2 bump (W2-0); the method, its conformance cases and the
 *   decorator forwarding landed with R8k. It reads the classification W2-0 shipped:
 *   {@link EVENT_KIND_CLASS} / {@link isAnsweringKind} (every kernel event kind is `answering`
 *   or `ignorable`, a required total map). No existing method changed, so a 2.0.0 store conforms.
 * 2.2.0: the optional `appendIfUnchanged(id, event, { head, fence, anchor })` (ADR 0116 amendment, R11:
 *   a late reward on a finished execution). ONE atomic step: append `event` iff the execution
 *   still EXISTS (sequence 0), its stored head is exactly `expect.head` AND its fence token is
 *   exactly `expect.fence`; otherwise change nothing and report the current tip. It never
 *   presents or adopts a fence token, so it can neither supersede a live holder nor be
 *   written under one it did not observe. A store that omits it makes `recordOutcome` refuse.
 *   No existing method changed, so a 2.1.0 store conforms.
 * 2.3.0: a SEMANTIC minor, no signature change (ADR 0129). The `anchor` of an observation MUST
 *   differ between two incarnations of an execution id, EVEN WHEN their sequence-0 envelopes
 *   are byte-identical (a delete followed by a re-creation under a frozen clock). A store
 *   claiming 2.3.0 therefore assigns a monotonic incarnation when it durably creates sequence 0
 *   and returns it as the anchor; it lives in STORE METADATA only, never in an event, a fold, a
 *   snapshot or a hash, so replay stays byte-identical. A log created before the store gained
 *   that metadata may keep the legacy {@link creationMarker} (`timestamp:id`) until it is
 *   deleted (no backfill). A store that cannot assign one keeps 2.2.0 behaviour and does not
 *   claim 2.3.0.
 * 2.4.0: the optional `storeNow(): Promise<number>` (ADR 0110 amendment, D10a) - the store's OWN
 *   clock in epoch ms, the one a multi-node fleet shares (Postgres: database time), the EventStore
 *   twin of `LeaseStore.storeNow()` (L29). It lets two nodes agree on an age (a message's TTL is
 *   judged against the instant it was stamped) without trusting either node's wall clock. A
 *   single-process store (memory, SQLite) need not implement it; a caller then falls back to its
 *   injected clock. Values must be finite, non-negative, and non-decreasing across sequential
 *   calls. Additive: no existing method changed, so a 2.3.0 store conforms.
 * 2.5.0: the optional `sealingCapability(): SealingCapability | undefined` (ADR 0130 residuals D7,
 *   RESERVED - no behaviour yet): what this node's store seals AND therefore opens, so the kernel
 *   can compare it to a `metadata.seal` marker ({@link SealMarker}) on a stored envelope. Absent, or
 *   returning `undefined`, means "seals nothing, opens nothing" (the correct reading for a store
 *   that cannot open sealed data). Every decorator forwards, overrides or refuses it (it is listed
 *   in {@link OPTIONAL_EVENT_STORE_METHODS}); `ShardedEventStore` returns a capability only when
 *   every shard agrees. Also reserves the control stream prefix {@link QUARANTINE_STREAM_PREFIX}
 *   (`__loom_quarantine__:<chainId>`). Also the optional `readAtRest(): AtRestEventReader` (ADR 0130
 *   D9): a read-only view of the envelopes AS STORED (never decrypted), so the quarantine verbs can
 *   step over a sealed value without asking the KeyStore; replaces a hidden symbol protocol. Every
 *   decorator forwards it (`EncryptingEventStore` overrides it with its inner store's raw reads,
 *   `ShardedEventStore` routes per stream). Additive: no existing method changed, so a 2.4.0 store
 *   conforms.
 *
 * Every optional method is listed in {@link OPTIONAL_EVENT_STORE_METHODS}; adding one here
 * without listing it there is a compile error. `OptionalEventStoreMethod` is derived from this
 * interface, and `DecoratorPlan` makes every one of its keys REQUIRED, so a new optional method
 * is also a compile error in every decorator whose plan `satisfies DecoratorPlan<EventStore,
 * OptionalEventStoreMethod>` until it forwards, overrides or refuses it. A decorator that uses
 * no plan at all is caught by the decorator conformance kit instead (and the `packages/spec`
 * fitness test makes every in-repo decorator run it).
 */
export const EVENT_STORE_SPI_VERSION = "2.5.0";

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
 * The reserved control stream a chain's durable inbox lives in (ADR 0110 D1):
 * `__loom_inbox__:<chainId>`. Defined here, beside {@link isReservedStream}, so a store decorator
 * (the crypto plugin's `EncryptingEventStore`) and the compliance erasure can recognise it without
 * depending on the workflow runtime.
 */
export const INBOX_STREAM_PREFIX = "__loom_inbox__:";

/**
 * (SPI 2.5.0, ADR 0130 residuals D9; written by `quarantineInbox`): the control stream holding the
 * verbatim copies of a chain's QUARANTINED inbox messages, `__loom_quarantine__:<chainId>`. It
 * belongs to the same chain as the inbox, so {@link inboxChainOf} maps it to the chain (the crypto
 * subject mapping, purge and delete-with-chain then cover it) and {@link InboxStreams.quarantine}
 * names it. Reserved by prefix like every `__loom_` stream.
 */
export const QUARANTINE_STREAM_PREFIX = "__loom_quarantine__:";

/** The reserved stream holding `chainId`'s quarantined messages (see {@link QUARANTINE_STREAM_PREFIX}). */
export function quarantineStreamId(chainId: string): string {
  return `${QUARANTINE_STREAM_PREFIX}${chainId}`;
}

/**
 * The seal marker an envelope may carry at `metadata.seal` (EVENT_SCHEMA 1.25.0, ADR 0130
 * residuals D7; RESERVED - no writer yet, the fold ignores it). Written by a sealing store
 * decorator in the SAME append that seals fields, on exactly the envelopes in which at least one
 * field was sealed.
 */
export interface SealMarker {
  readonly v: 1;
  /** The algorithm id the sealed envelopes carry, e.g. `loom/aes-256-gcm`. */
  readonly cipher: string;
  /** Sorted, deduped `EVENT_TYPE.dot.path` entries actually sealed in THIS envelope. */
  readonly covers: readonly string[];
}

/**
 * The read-only, at-rest view of an {@link EventStore} (SPI 2.5.0, see {@link EventStore.readAtRest}):
 * envelopes exactly as stored, never decrypted; no write, fence or subscribe.
 */
export type AtRestEventReader = Pick<EventStore, "read" | "readFrom" | "readRange" | "head">;

/** What a store seals and therefore opens (EventStore SPI 2.5.0, see {@link EventStore.sealingCapability}). */
export interface SealingCapability {
  readonly cipher: string;
  /** Every `EVENT_TYPE.path` this node's store seals AND therefore opens. */
  readonly covers: readonly string[];
  /** True iff this node can open an envelope stamped with `marker` (same cipher, every entry of `marker.covers` is opened here). */
  opens(marker: SealMarker): boolean;
}

/**
 * The chain an execution belongs to, read from its sequence 0 alone (the fold's own rule: a valid `forkChain` stamp wins,
 * else the start payload's `chainId`, else the execution itself) — so `send` needs no fold.
 */
export function chainIdOfFirst(first: EventEnvelope, executionId: string): string {
  const valid = (v: unknown): string | undefined => {
    if (v === null || typeof v !== "object") return undefined;
    const { chainId, generation } = v as { chainId?: unknown; generation?: unknown };
    return typeof chainId === "string" &&
      chainId.length > 0 &&
      Number.isSafeInteger(generation) &&
      (generation as number) >= 0
      ? chainId
      : undefined;
  };
  return valid(first.metadata?.forkChain) ?? valid(first.payload) ?? executionId;
}

/**
 * ADR 0110 amendment, D10b — per-topic inbox streams. A chain's inbox may hold one stream per topic,
 * beside the legacy single stream:
 *
 *  - `__loom_inbox__:<chainId>#<16 hex>` — the messages of ONE topic (the first 16 hex digits of the
 *    SHA-256 of the topic name);
 *  - `__loom_inbox__:<chainId>#reg` — the chain's REGISTRY: one `INBOX_TOPIC` event per topic that
 *    ever had a stream, so every stream of a chain is enumerable without `listExecutionsPage`.
 *
 * The cursors stay ONE number space (the fold is unchanged): a topic stream's sequences start at
 * {@link INBOX_TOPIC_SEQ_BASE}, far above any legacy-stream sequence, so a legacy message of a topic
 * (below the base) always precedes its topic-stream messages and the two can never collide.
 */
export const INBOX_TOPIC_SEQ_BASE = 2 ** 40;

/** The suffix of a chain's registry stream (see {@link INBOX_TOPIC_SEQ_BASE}). */
export const INBOX_REGISTRY_SUFFIX = "#reg";

/**
 * The control stream whose existence is the FLEET-WIDE opt-in to per-topic writing (ADR 0110 D10b):
 * one `INBOX_LAYOUT` event, written once by `runtime.enableInboxTopicStreams`. Reserved by prefix.
 */
export const INBOX_LAYOUT_STREAM = "__loom_inbox_layout__";

const TOPIC_STREAM_SUFFIX = /#[0-9a-f]{16}$/;

/** The 16-hex-digit stream suffix of `topic` (first 8 bytes of its SHA-256). */
export function inboxTopicHash(topic: string): string {
  return createHash("sha256").update(topic).digest("hex").slice(0, 16);
}

/** The reserved stream holding `topic`'s messages for `chainId` (see {@link INBOX_TOPIC_SEQ_BASE}). */
export function inboxTopicStreamId(chainId: string, topic: string): string {
  return `${INBOX_STREAM_PREFIX}${chainId}#${inboxTopicHash(topic)}`;
}

/** The chain's registry stream (see {@link INBOX_TOPIC_SEQ_BASE}). */
export function inboxRegistryStreamId(chainId: string): string {
  return `${INBOX_STREAM_PREFIX}${chainId}${INBOX_REGISTRY_SUFFIX}`;
}

/**
 * Would an id, taken as a CHAIN id, alias a topic or registry stream of another chain
 * (`<x>#<16 hex>` or `<x>#reg`)? Such an id is refused at `start` once the inbox is on.
 */
export function hasInboxStreamShape(id: string): boolean {
  return id.endsWith(INBOX_REGISTRY_SUFFIX) || TOPIC_STREAM_SUFFIX.test(id);
}

/**
 * The chain id an inbox stream belongs to, or `undefined` when `executionId` is not an inbox
 * stream (or names an empty chain). A chain's id is its generation-0 execution id (or a fork's
 * fresh one), so a decorator that maps executions to erasure subjects can map the chain's streams
 * (legacy, per-topic and registry alike) to the same subject as its owner.
 */
export function inboxChainOf(executionId: string): string | undefined {
  if (executionId.startsWith(QUARANTINE_STREAM_PREFIX)) {
    // ADR 0130 residuals D9 (reserved): the quarantine copy belongs to the chain, under the same owner subject.
    const quarantined = executionId.slice(QUARANTINE_STREAM_PREFIX.length);
    return quarantined.length > 0 ? quarantined : undefined;
  }
  if (!executionId.startsWith(INBOX_STREAM_PREFIX)) return undefined;
  let chain = executionId.slice(INBOX_STREAM_PREFIX.length);
  if (chain.endsWith(INBOX_REGISTRY_SUFFIX)) chain = chain.slice(0, -INBOX_REGISTRY_SUFFIX.length);
  else if (TOPIC_STREAM_SUFFIX.test(chain)) chain = chain.slice(0, -17);
  return chain.length > 0 ? chain : undefined;
}

/** The inbox streams of one chain, from {@link inboxStreamsOfChain}. */
export interface InboxStreams {
  /** The legacy single stream (always named, whether or not it holds anything). */
  legacy: string;
  /** The registry stream, only when it has entries (a chain never written per-topic has none). */
  registry: string | undefined;
  /** One stream per registered topic. */
  topics: string[];
  /** The chain's quarantine stream (ADR 0130 residuals D9, reserved: always named, whether or not it holds anything). */
  quarantine: string;
}

/**
 * Every inbox stream a chain has on `store`: the legacy stream, the registry (when it exists) and one
 * stream per registered topic. The registry is bounded by the per-chain topic cap, so this is one small
 * read. Used by every site that must reach ALL of a chain's streams (retirement, erasure, lifecycle
 * deletion) without a second copy of the naming rule. Delete `topics`, then `legacy`, then `registry`
 * LAST: a crash midway then leaves the remaining topic streams still findable.
 */
export async function inboxStreamsOfChain(
  store: Pick<EventStore, "read">,
  chainId: string
): Promise<InboxStreams> {
  const registry = inboxRegistryStreamId(chainId);
  const entries = await store.read(registry);
  const topics: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const topic = (e.payload as { topic?: unknown } | null)?.topic;
    if (typeof topic !== "string" || seen.has(topic)) continue;
    seen.add(topic);
    topics.push(inboxTopicStreamId(chainId, topic));
  }
  return {
    legacy: `${INBOX_STREAM_PREFIX}${chainId}`,
    registry: entries.length > 0 ? registry : undefined,
    topics,
    quarantine: quarantineStreamId(chainId),
  };
}

/**
 * {@link inboxStreamsOfChain} PLUS a prefix scan: the topic streams the registry does not name (a
 * sender that crashed between its append and its registration, a registry deleted underneath a
 * sender, a stale "already registered" cache). Reaches them through the store's keyset-paged
 * enumeration when it has one (`listExecutionsPage`, ids in code point order, so the chain's streams are
 * one contiguous run after its prefix); a store without it gets the registry's answer alone. It is a
 * BACKSTOP for erasure and the orphan sweep, not the hot path (the scan is one indexed range query).
 */
export async function inboxStreamsOfChainDeep(
  store: Pick<EventStore, "read"> & Partial<Pick<EventStore, "listExecutionsPage">>,
  chainId: string
): Promise<InboxStreams> {
  const found = await inboxStreamsOfChain(store, chainId);
  if (store.listExecutionsPage === undefined) return found;
  const prefix = `${INBOX_STREAM_PREFIX}${chainId}#`;
  const registry = inboxRegistryStreamId(chainId);
  const known = new Set(found.topics);
  let hasRegistry = found.registry !== undefined;
  let cursor = prefix;
  for (;;) {
    const page = await store.listExecutionsPage({ cursor, limit: 200 });
    let past = false;
    for (const id of page.executionIds) {
      if (!id.startsWith(prefix)) {
        past = true;
        break;
      }
      if (id === registry) hasRegistry = true;
      else if (TOPIC_STREAM_SUFFIX.test(id) && id.length === prefix.length + 16 && !known.has(id)) {
        known.add(id);
        found.topics.push(id);
      }
    }
    if (past || page.nextCursor === undefined || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  return {
    legacy: found.legacy,
    registry: hasRegistry ? registry : undefined,
    topics: found.topics,
    quarantine: found.quarantine,
  };
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
  /**
   * Live delivery of one execution's appends. Events committed by OTHER nodes arrive in commit
   * order relative to each other (the Postgres store queues each execution's cross-node emits
   * behind its predecessor's rather than emitting on lookup-completion order). A LOCAL append is
   * emitted synchronously and may overtake a cross-node event still in flight, so a subscriber that
   * needs total order should order by `sequence` (or read the log).
   */
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
   * OPTIONAL conditional fence (ADR 0118 D1, SPI 2.1.0) — "acquire, but only if the park I am
   * answering is still unanswered", as ONE atomic operation. Bumps and returns the next token iff
   *
   * (a) the execution's CURRENT token equals `expect.fence` (0 when it was never acquired), AND
   * (b) no ANSWERING event ({@link isAnsweringKind}) exists with `sequence > expect.parkSeq`;
   *
   * otherwise returns `{ stale: true, fence: <current> }` and changes nothing. (b) is what makes a
   * retry on a re-read token safe: a resume's append does not move the token, so only the log can
   * say "a resume for this park is already recorded" (a dead acquirer, by contrast, moves the
   * token and appends nothing). Audit appends after a park (`EXECUTION_DENIED`, `OUTCOME_RECORDED`,
   * application events, ...) do not answer it.
   *
   * Atomic against appends: an answering append that lands implies the acquire is `stale`; an
   * acquire that wins implies that append is a `StaleFenceError`, never both succeeding. A store
   * that fences implements it (memory: one synchronous step; Postgres: a transaction that locks
   * the fence row, with the answering appends taking it `FOR SHARE`); a store that does not fence
   * (single-node SQLite) omits it, and a caller falls back to `acquireFence` and the documented
   * residual.
   */
  acquireFenceIf?(
    executionId: string,
    expect: { fence: number; parkSeq: number }
  ): Promise<AcquireFenceIfResult>;
  /**
   * OPTIONAL conditional append (SPI 2.2.0, ADR 0116 amendment) — "append this ONE event iff the
   * execution is exactly as I observed it", atomically. With a non-null `event`
   * (`event.executionId === executionId`), appends it iff ALL hold at the instant of the write:
   *
   * (a) the execution EXISTS — its sequence-0 event is still stored (a retention sweep that
   *     deleted the log between the caller's read and now makes this `gone`, and NOTHING is
   *     written: no orphan log, whatever fence row a store keeps);
   * (b) the stored head (`MAX(sequence)`) equals `expect.head`;
   * (c) the fence token equals `expect.fence` (0 when it was never acquired).
   *
   * It does NOT check or present the envelope's own `metadata.fence` and never bumps or adopts a
   * token: the caller observed the token and the store proves it has not moved, so a holder that
   * acquires after the observation makes this `moved` (retryable) instead of being displaced, and
   * a holder whose appends landed makes (b) fail. `event.sequence` must exceed `expect.head`
   * (the caller may skip ahead of a compaction checkpoint; the slot must still be free).
   * A duplicate sequence / envelope id / injected failure throws exactly as `append` does.
   *
   * With `event === null` it is a pure OBSERVATION: nothing is written and the result is
   * `{ appended: false, reason: "observed" | "gone", head, fence, anchor }` (`expect` is ignored).
   *
   * Implementations hold the same lock/row the fence uses (ADR 0118): memory one synchronous
   * step; Postgres a transaction that takes the execution's fence row `FOR UPDATE`; SQLite
   * `BEGIN IMMEDIATE` (no fencing: the token is always 0). A decorator transforms the event
   * exactly as it does for `append` (tenant scope, encryption, externalisation, chain stamp).
   */
  appendIfUnchanged?(
    executionId: string,
    event: EventEnvelope | null,
    expect?: TipObservation
  ): Promise<AppendIfUnchangedResult>;
  /**
   * OPTIONAL (SPI 2.4.0, ADR 0110 amendment D10a): the store's own clock in epoch milliseconds - the
   * single clock every node of a fleet shares (Postgres: database time). A caller that must compare
   * an instant stamped by one node with "now" on another (an inbox message's TTL) uses this on both
   * sides instead of trusting the nodes' wall clocks. A store that is a single process (memory,
   * SQLite) omits it and callers fall back to their injected clock.
   */
  storeNow?(): Promise<number>;
  /**
   * OPTIONAL (SPI 2.5.0, ADR 0130 residuals D7; RESERVED - declared and forwarded, no caller yet):
   * what this store seals AND therefore opens. Absent, or returning `undefined`: it seals nothing
   * and opens nothing. Must be stable for an unchanged configuration (`cipher`, sorted deduped
   * `covers`), and `opens(marker)` true iff the cipher is equal and every `marker.covers` entry is
   * in `covers`. A decorator that does not seal forwards it; `ShardedEventStore` returns the
   * intersection across shards (undefined unless every shard agrees on the cipher).
   */
  sealingCapability?(): SealingCapability | undefined;
  /**
   * OPTIONAL (SPI 2.5.0, ADR 0130 D9): a READ-ONLY view of the envelopes exactly AS STORED - a
   * sealing decorator never decrypts what this view returns (a store that seals nothing may return
   * its ordinary reads; it need not implement the method). It exists so a caller that has decided a
   * sealed value is not its business (the quarantine verbs stepping over a `MESSAGE_CONSUMED.payload`
   * seal) reads WITHOUT asking the KeyStore. No write, no fence, no subscribe. Every envelope it
   * returns is byte-identical to what was appended through the store. A decorator forwards it (the
   * sealing one overrides it with its inner store's raw reads); `ShardedEventStore` routes each
   * call to the stream's shard, like `read`. "As stored" includes UNRESOLVED content refs (a
   * `ContentResolvingEventStore` above it never resolves them), so an admitted transient fold sees
   * `ContentRef`s and erased content does not raise `ContentMissingError` on this path; harmless for
   * routing fields unless an app externalizes one.
   */
  readAtRest?(): AtRestEventReader;
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
   * CODE POINT order (SPI 2.0.0, ADR 0108 — {@link compareExecutionIds}; SQL `COLLATE "C"`, never the
   * database's collation), `limit` per page. `cursor` is an executionId — any string, not
   * only one this store returned — and the page holds the ids strictly after it; `nextCursor`
   * is the page's last id. `ShardedEventStore` depends on all three: it merges shard pages in
   * this order and resumes EVERY shard from the merged page's last id. The guarantee covers
   * well-formed Unicode ids; a lone surrogate cannot round-trip through UTF-8 (node-postgres
   * sends U+FFFD), so no ordering or identity is promised for one. Bounded-memory alternative to {@link listExecutions} for maintenance passes
   * (retention, the K10.6 sweep, read-model catch-up) over year-scale stores. Executions
   * created DURING iteration whose ids sort before the cursor may be missed — acceptable
   * for periodic maintenance jobs (they are visited on the next pass); do not use this for
   * exactly-once semantics. Same reserved-stream note as `listExecutions`.
   */
  listExecutionsPage?(opts?: { cursor?: string; limit?: number }): Promise<ExecutionPage>;
  close(): Promise<void>;
}

/**
 * What a caller saw of an execution's tip: the stored head, the fence token (0 = never fenced) and
 * the `anchor` — an OPAQUE incarnation marker. Since SPI 2.3.0 (ADR 0129) it is a STORE-ASSIGNED,
 * monotonic incarnation that differs between two incarnations of an id even when their sequence-0
 * envelopes are byte-identical (before it: a marker derived from that envelope's id and
 * timestamp, which a pre-migration log keeps). The anchor is what tells "the log I observed" from
 * "a log deleted and re-created under the same id that happens to have the same head and token"
 * (the ABA case): envelope ids are deterministic (`<exec>-<seq>`), so the head and token alone
 * cannot.
 * Pass back exactly what an observation returned; a decorator forwards it untouched.
 */
export interface TipObservation {
  head: number;
  fence: number;
  anchor: string;
}

/** What {@link EventStore.appendIfUnchanged} answers. */
export type AppendIfUnchangedResult =
  | { appended: true }
  | {
      appended: false;
      /** `moved`: the head or the fence changed; `gone`: no sequence-0 event; `observed`: a pure observation. */
      reason: "moved" | "gone" | "observed";
      /** The tip now (`null` when the execution is gone). */
      head: number | null;
      fence: number;
      /** The creation marker now (`null` when the execution is gone). */
      anchor: string | null;
    };

/** What {@link EventStore.acquireFenceIf} answers: the new token, or the (unchanged) current one. */
export type AcquireFenceIfResult = { fence: number } | { stale: true; fence: number };

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
  "acquireFenceIf",
  "appendIfUnchanged",
  "storeNow",
  "sealingCapability",
  "readAtRest",
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
export async function headOf(
  store: Pick<EventStore, "read" | "head">,
  executionId: string
): Promise<number | null> {
  if (store.head) return store.head(executionId);
  const events = await store.read(executionId);
  return events.length === 0 ? null : (events[events.length - 1]?.sequence ?? null);
}

export async function readRangeOf(
  store: Pick<EventStore, "read" | "readFrom" | "readRange">,
  executionId: string,
  fromSequence: number,
  toSequence: number
): Promise<EventEnvelope[]> {
  if (toSequence < fromSequence) return [];
  if (store.readRange) return store.readRange(executionId, fromSequence, toSequence);
  const from = await store.readFrom(executionId, fromSequence);
  return from.filter((e) => e.sequence <= toSequence);
}
