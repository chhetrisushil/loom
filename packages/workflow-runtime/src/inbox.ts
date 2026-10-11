import { createHash } from "node:crypto";
import type { EventEnvelope, ExecutionState } from "@loom/core";
import {
  DuplicateEnvelopeIdError,
  DuplicateSequenceError,
  INBOX_LAYOUT_STREAM,
  INBOX_STREAM_PREFIX,
  INBOX_TOPIC_SEQ_BASE,
  chainIdOfFirst,
  headOf,
  inboxRegistryStreamId,
  inboxStreamsOfChain,
  inboxStreamsOfChainDeep,
  inboxTopicStreamId,
  readRangeOf,
} from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { SealedPayloadUnreadableError } from "./types";
import type { InboxMessage, InboxSource } from "./types";

// ── ADR 0110 D1 — the inbox stream ───────────────────────────────────────────────────────────
//
// An execution's inbox is a SEPARATE reserved control stream, `__loom_inbox__:<chainId>`. The only
// writer is the kernel's `runtime.send`; the owner PULLS (a read past its per-topic cursor) and
// journals consumption into its OWN log as `MESSAGE_CONSUMED`. The owner's log is therefore never
// appended to by a sender, which is what removes the sequence race the audit measured.

export {
  INBOX_LAYOUT_STREAM,
  INBOX_STREAM_PREFIX,
  INBOX_TOPIC_SEQ_BASE,
  inboxRegistryStreamId,
  inboxTopicStreamId,
};
/** The stream's event kind. Not an `EVENT_SCHEMA` kind: it exists only in the control stream. */
export const INBOX_MESSAGE_KIND = "INBOX_MESSAGE";
const INBOX_WORKFLOW_ID = "__loom_inbox__";

/**
 * The `TimerRecord.wakeAt` of an inbox wake row. A FIXED instant, so the store's per-
 * `(executionId, wakeAt)` upsert coalesces a burst of N sends into ONE row without a query
 * (ADR 0110 D5.3's "a due-now row already exists" test, made free). `TimerService` recognises the
 * value and runs the notify path instead of judging `suspendedOn.wakeAt`.
 */
export const INBOX_WAKE_AT = -1;

/** The `condition.on` of a park whose legacy single-gate fields cannot describe it (several waits). */
export const WAITS_PARK_ON = "__loom_waits__";

export const DEFAULT_INBOX_MAX_BACKLOG = 10_000;
export const DEFAULT_INBOX_MAX_PAYLOAD_BYTES = 65_536;
/**
 * The longest `messageId` a sender may supply. The id (with the sender, see {@link dedupeKeyOf})
 * lands in the fold's dedupe window, which is part of folded state and every snapshot.
 */
export const MAX_MESSAGE_ID_LENGTH = 256;
const MAX_TOPIC_LENGTH = 256;
const APPEND_ATTEMPTS = 64;

/** The chain an execution's inbox is keyed by: its folded chain id, else the execution itself. */
export function chainIdOf(state: ExecutionState, executionId: string): string {
  const chain = state.variables._chain as { chainId?: unknown } | undefined;
  return typeof chain?.chainId === "string" && chain.chainId.length > 0
    ? chain.chainId
    : executionId;
}

export { chainIdOfFirst };

export function inboxStreamId(chainId: string): string {
  return `${INBOX_STREAM_PREFIX}${chainId}`;
}

/** A topic a flow may wait on and a sender may address: bounded, not a prototype name, not reserved. */
export function topicProblem(topic: unknown): string | undefined {
  if (typeof topic !== "string" || topic.length === 0)
    return "the topic must be a non-empty string";
  if (topic.length > MAX_TOPIC_LENGTH)
    return `the topic is longer than ${MAX_TOPIC_LENGTH} characters`;
  if (topic.startsWith("__loom_")) return 'a topic may not start with "__loom_" (reserved)';
  if (topic === "__proto__" || topic === "constructor" || topic === "prototype") {
    return `"${topic}" is not a usable topic name`;
  }
  return undefined;
}

/**
 * The idempotency key the owner's fold dedupes on, journaled as `MESSAGE_CONSUMED.messageId`.
 * Keyed by `(sender, messageId)`, never by the bare id: two senders that both number their messages
 * `1, 2, 3` must not swallow each other's. It is the lowercase hex SHA-256 of the JSON array
 * `[tenant, actor, onBehalfOf, messageId]`: deterministic, unambiguous whatever the fields contain,
 * free of control characters, and a FIXED 64 characters however long the principal's fields are
 * (the key lands in the fold's dedupe window, which is part of folded state and every snapshot).
 * The fold treats the field as an opaque string, so no fold change is needed. The runtime's
 * duplicate test is "is this key in the folded window" and nothing else, so it is exactly the
 * fold's own (ADR 0110 D6). The sender is only as trustworthy as the principal that sent it: with
 * no authorizer wired it is whatever the caller claimed.
 */
export function dedupeKeyOf(m: { messageId: string; sender: InboxMessage["sender"] }): string {
  const s = m.sender;
  return createHash("sha256")
    .update(JSON.stringify([s.tenant ?? "", s.actor ?? "", s.onBehalfOf ?? "", m.messageId]))
    .digest("hex");
}

// ── ADR 0130 — the sealed-payload guard ──────────────────────────────────────────────────────

/**
 * The most nodes the guard visits in one payload. Sized like the other untrusted-content walkers
 * (`blankStream`'s `carriesKey`): the walk is iterative (no stack to blow) and breadth-first, so a
 * top-level or shallow envelope is found before the budget matters.
 */
export const SEALED_WALK_BUDGET = 100_000;

/**
 * Does `payload` hold a ciphertext envelope (a plain object with an OWN `__loomEnc` key), at the top
 * or nested at any depth (a deployment may seal a nested field, `payload.secret`)? `"unverified"`
 * when the walk ran out of budget before finishing: the caller must treat it as not-clean (fail
 * closed). The kernel does not depend on the crypto plugin, so this is the envelope's SHAPE only.
 */
export function sealedEnvelopeIn(payload: unknown): "clean" | "sealed" | "unverified" {
  if (typeof payload !== "object" || payload === null) return "clean";
  let queue: unknown[] = [payload];
  let seen = 0;
  while (queue.length > 0) {
    const next: unknown[] = [];
    for (const x of queue) {
      if (++seen > SEALED_WALK_BUDGET) return "unverified";
      if (Object.hasOwn(x as object, "__loomEnc")) return "sealed";
      for (const child of Object.values(x as object)) {
        if (typeof child === "object" && child !== null) next.push(child);
      }
    }
    queue = next;
  }
  return "clean";
}

/**
 * THE delivery check, shared by every site that consumes an inbox message into a flow
 * (`WorkflowContext.satisfyFromInbox` and the notify scan). At delivery time any envelope the store
 * recognised has already been opened, so one that survives is sealed and not openable here: throws
 * {@link SealedPayloadUnreadableError} BEFORE anything is journaled. Duplicates deliver nothing
 * (their payload is not copied into the log), so they need no check.
 */
export function assertDeliverable(executionId: string, m: InboxMessage): void {
  const verdict = sealedEnvelopeIn(m.payload);
  if (verdict !== "clean") {
    throw new SealedPayloadUnreadableError(
      executionId,
      m.messageId,
      m.topic,
      verdict === "unverified"
    );
  }
}

/** The stored shape of one stream entry. */
interface StoredMessage {
  topic: string;
  messageId: string;
  payload: unknown;
  sender: InboxMessage["sender"];
}

function asMessage(e: EventEnvelope): InboxMessage | undefined {
  if (e.eventType !== INBOX_MESSAGE_KIND) return undefined;
  const p = e.payload as Partial<StoredMessage> | null | undefined;
  if (p === null || typeof p !== "object") return undefined;
  if (typeof p.topic !== "string" || typeof p.messageId !== "string") return undefined;
  return {
    inboxSeq: e.sequence,
    topic: p.topic,
    messageId: p.messageId,
    payload: p.payload,
    sender: p.sender !== null && typeof p.sender === "object" ? p.sender : {},
  };
}

/** How many stream sequences one bounded range read of the default source covers. */
const READ_CHUNK = 128;

/**
 * The default {@link InboxSource}: bounded range reads over the stream's retained tail past
 * `afterSeq`, filtered to `topic`, stopping as soon as `limit` messages are found. A hot topic whose
 * cursor sits near the head costs one `head()` and one small range read, however long the stream
 * has been; a cold topic scans at most the retained stream (bounded by `inboxMaxBacklog` plus
 * whatever consumption has not yet been trimmed). A trimmed gap (a range that comes back empty
 * below the head) falls back to one `readFrom`, which returns everything retained from there.
 */
export function createInboxSource(store: EventStore): InboxSource {
  return async (chainId, topic, afterSeq, limit) => {
    // The topic's own stream FIRST, then the legacy one (ADR 0110 D10b). A topic-stream message is
    // visible only after its fleet switch, which happened after every legacy message that precedes
    // it, so reading the later stream first can never miss an earlier legacy message that the
    // second read would then find. The cursors are one number space and the topic streams sit above
    // INBOX_TOPIC_SEQ_BASE, so legacy messages (below it) come first in the result.
    const fromTopic = await readTopicMessages(
      store,
      inboxTopicStreamId(chainId, topic),
      topic,
      Math.max(afterSeq, INBOX_TOPIC_SEQ_BASE - 1),
      limit
    );
    // A cursor already in the topic range is past every legacy message: skip the legacy read.
    const fromLegacy =
      afterSeq >= INBOX_TOPIC_SEQ_BASE
        ? []
        : await readTopicMessages(store, inboxStreamId(chainId), topic, afterSeq, limit);
    return fromLegacy.length === 0
      ? fromTopic.slice(0, limit)
      : [...fromLegacy, ...fromTopic].slice(0, limit);
  };
}

async function readTopicMessages(
  store: EventStore,
  stream: string,
  topic: string,
  afterSeq: number,
  limit: number
): Promise<InboxMessage[]> {
  const out: InboxMessage[] = [];
  const take = (events: readonly EventEnvelope[]): void => {
    for (const e of events) {
      if (e.sequence <= afterSeq || out.length >= limit) continue;
      const m = asMessage(e);
      if (m !== undefined && m.topic === topic) out.push(m);
    }
  };
  const head = await headOf(store, stream);
  if (head === null) return out;
  let lo = Math.max(0, afterSeq + 1);
  while (lo <= head && out.length < limit) {
    const page = await readRangeOf(store, stream, lo, Math.min(head, lo + READ_CHUNK - 1));
    if (page.length === 0) {
      take(await store.readFrom(stream, lo)); // a trimmed gap: everything retained from here
      break;
    }
    take(page);
    lo = (page[page.length - 1] as EventEnvelope).sequence + 1;
  }
  return out;
}

/** Per store, per chain: the in-process queue that serializes this process's own sends. */
const sendQueues = new WeakMap<EventStore, Map<string, Promise<unknown>>>();

/**
 * Append one message at `head + 1` (an O(1) point read, never `read().length`). Concurrent senders
 * serialize on the store's `(executionId, sequence)` uniqueness, so per-topic FIFO is the stream's
 * own order. Senders in THIS process queue behind one another (no pointless CAS storm for a burst);
 * a sender in another process races on the uniqueness and retries with jitter.
 */
export function appendInboxMessage(
  store: EventStore,
  chainId: string,
  message: StoredMessage,
  now: () => number | Promise<number>,
  /** ADR 0110 D10b: write the message into its TOPIC's stream (sequences from INBOX_TOPIC_SEQ_BASE). */
  perTopic = false
): Promise<number> {
  let queues = sendQueues.get(store);
  if (queues === undefined) {
    queues = new Map();
    sendQueues.set(store, queues);
  }
  const stream = perTopic ? inboxTopicStreamId(chainId, message.topic) : inboxStreamId(chainId);
  const prior = queues.get(stream) ?? Promise.resolve();
  const run = prior
    .catch(() => undefined)
    .then(() => appendOnce(store, stream, perTopic ? INBOX_TOPIC_SEQ_BASE : 0, message, now));
  const tail = run.catch(() => undefined);
  queues.set(stream, tail);
  void tail.then(() => {
    if (queues.get(stream) === tail) queues.delete(stream);
  });
  return run;
}

async function appendOnce(
  store: EventStore,
  stream: string,
  firstSequence: number,
  message: StoredMessage,
  now: () => number | Promise<number>
): Promise<number> {
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
    const head = await headOf(store, stream);
    const sequence = head === null ? firstSequence : Math.max(head + 1, firstSequence);
    const envelope: EventEnvelope = {
      id: `${stream}-${sequence}`,
      workflowId: INBOX_WORKFLOW_ID,
      executionId: stream,
      eventType: INBOX_MESSAGE_KIND,
      sequence,
      timestamp: await now(),
      payload: message,
    };
    try {
      await store.append(envelope);
      return sequence;
    } catch (err) {
      if (err instanceof DuplicateSequenceError || err instanceof DuplicateEnvelopeIdError) {
        // Another sender (another process) reached the slot: re-read the head, with jitter so a
        // burst of rivals does not retry in lockstep.
        if (attempt >= 2) await new Promise((r) => setTimeout(r, Math.random() * 2 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `inbox stream "${stream}": could not allocate a sequence after ${APPEND_ATTEMPTS} attempts`
  );
}

/** The cursors an owner has folded (`_inbox.cursors`), read with own-property semantics. */
export function cursorsOf(variables: Record<string, unknown>): Record<string, number> {
  const inbox = variables._inbox as { cursors?: Record<string, number> } | undefined;
  return inbox?.cursors ?? {};
}

export function cursorFor(cursors: Record<string, number>, topic: string): number {
  return Object.hasOwn(cursors, topic) ? (cursors[topic] as number) : -1;
}

/**
 * The `waitId` of an operator discard's `MESSAGE_CONSUMED` (ADR 0110 amendment, D8). No `ctx` wait can
 * carry it (those are `<scopePath>#<ordinal>`), and the fold's first-answer-wins rule means a chain's
 * log records ONE answer under it however many discards run, so discards add no unbounded state.
 */
export const DISCARD_WAIT_ID = "__loom_discard__";

/**
 * The dedupe key of a discard fact: the lowercase hex SHA-256 of `["discard", topic, throughSeq]`.
 * Fixed size like {@link dedupeKeyOf}'s, and the same discard repeated is a duplicate (the cursor
 * advance is idempotent anyway).
 */
export function discardKeyOf(topic: string, throughSeq: number): string {
  return createHash("sha256")
    .update(JSON.stringify(["discard", topic, throughSeq]))
    .digest("hex");
}

/** The kind of the marker a fork writes so its allocation starts above every inherited cursor. */
export const INBOX_FLOOR_KIND = "INBOX_FLOOR";

/**
 * Make sure the chain's inbox stream's head is at least `floor`, so the next `send` allocates
 * `floor + 1` or later. A FORK inherits its parent's per-topic cursors through the copied
 * `MESSAGE_CONSUMED` prefix but owns a fresh, empty stream; without this its first sends would
 * land at sequences the inherited cursors already passed, be skipped forever, and be trimmed. One
 * marker at `floor` (not a message: readers ignore it) is the whole seed. Idempotent, and safe to
 * race: a sender that already pushed the head to `floor` or beyond makes it a no-op.
 */
export async function ensureInboxFloor(
  store: EventStore,
  chainId: string,
  floor: number,
  now: () => number
): Promise<void> {
  await ensureStreamFloor(store, inboxStreamId(chainId), floor, now);
}

/** {@link ensureInboxFloor} for any inbox stream (the legacy one or a topic's). */
export async function ensureStreamFloor(
  store: EventStore,
  stream: string,
  floor: number,
  now: () => number
): Promise<void> {
  if (!Number.isSafeInteger(floor) || floor < 0) return;
  const head = await headOf(store, stream);
  if (head !== null && head >= floor) return;
  try {
    await store.append({
      id: `${stream}-${floor}`,
      workflowId: INBOX_WORKFLOW_ID,
      executionId: stream,
      eventType: INBOX_FLOOR_KIND,
      sequence: floor,
      timestamp: now(),
      payload: { floor },
    });
  } catch (err) {
    if (err instanceof DuplicateSequenceError || err instanceof DuplicateEnvelopeIdError) return;
    throw err;
  }
}

/**
 * Seed every stream a chain's inherited cursors need (a FORK, or a RE-OPEN, ADR 0110 D1/D10b): the
 * legacy stream at the highest legacy-range cursor, and each topic stream whose cursor is in the
 * topic range at that cursor (registering the topic so the chain's streams stay enumerable). A new
 * topic stream is otherwise seeded lazily at its first send, and starts above every legacy sequence.
 */
export async function seedInboxFloors(
  store: EventStore,
  chainId: string,
  cursors: Record<string, number>,
  now: () => number
): Promise<void> {
  await ensureInboxFloor(store, chainId, maxCursor(cursors), now);
  for (const [topic, cursor] of Object.entries(cursors)) {
    if (typeof cursor !== "number" || cursor < INBOX_TOPIC_SEQ_BASE) continue;
    await registerInboxTopic(store, chainId, topic, Number.POSITIVE_INFINITY, now);
    await ensureStreamFloor(store, inboxTopicStreamId(chainId, topic), cursor, now);
  }
}

/**
 * The largest LEGACY-stream cursor of `cursors` (the highest sequence this owner has consumed from the
 * single inbox stream), or -1. A cursor in the topic range (>= INBOX_TOPIC_SEQ_BASE) belongs to a
 * topic's own stream and says nothing about the legacy one.
 */
export function maxCursor(cursors: Record<string, number>): number {
  let max = -1;
  for (const v of Object.values(cursors)) {
    if (typeof v === "number" && v < INBOX_TOPIC_SEQ_BASE && v > max) max = v;
  }
  return max;
}

/**
 * Scan the retained stream from `from` (inclusive) for UNCONSUMED messages (past their topic's
 * cursor), in bounded pages. The caller passes a `from` below which everything is known consumed
 * (or trimmed), so the cost follows the unconsumed backlog plus the consumed-but-untrimmed run, never
 * the lifetime of the stream. `stopAtFirst` returns at the oldest unconsumed message (what trim
 * needs); `limit` returns once that many are counted (what backpressure needs). A trimmed gap
 * (a page that comes back empty below the head) falls back to one `readFrom`, which returns
 * everything retained from there.
 */
export async function scanInbox(
  store: EventStore,
  chainId: string,
  cursors: Record<string, number>,
  opts: { from?: number; stopAtFirst?: boolean; limit?: number; stream?: string } = {}
): Promise<{
  unconsumed: number;
  oldest: number | undefined;
  /** The topic of `oldest`: the message pinning everything above it. */
  oldestTopic: string | undefined;
  head: number | null;
}> {
  const stream = opts.stream ?? inboxStreamId(chainId);
  const head = await headOf(store, stream);
  if (head === null) return { unconsumed: 0, oldest: undefined, oldestTopic: undefined, head };
  let unconsumed = 0;
  let oldest: number | undefined;
  let oldestTopic: string | undefined;
  const visit = (events: readonly EventEnvelope[]): boolean => {
    for (const e of events) {
      const m = asMessage(e);
      if (m === undefined || e.sequence <= cursorFor(cursors, m.topic)) continue;
      unconsumed++;
      if (oldest === undefined) {
        oldest = e.sequence;
        oldestTopic = m.topic;
      }
      if (opts.stopAtFirst === true) return true;
      if (opts.limit !== undefined && unconsumed >= opts.limit) return true;
    }
    return false;
  };
  let lo = Math.max(0, opts.from ?? 0);
  while (lo <= head) {
    const page = await readRangeOf(store, stream, lo, Math.min(head, lo + READ_CHUNK - 1));
    if (page.length === 0) {
      visit(await store.readFrom(stream, lo));
      break;
    }
    if (visit(page)) break;
    lo = (page[page.length - 1] as EventEnvelope).sequence + 1;
  }
  return { unconsumed, oldest, oldestTopic, head };
}

/**
 * Delete the consumed prefix of the stream (ADR 0110 D1): everything below the OLDEST UNCONSUMED
 * message, never the head itself. Keeping the head makes `head + 1` allocation monotonic: truncating
 * through it would let a store whose `head()` is a `MAX(sequence)` hand a later send a sequence
 * a consumer's cursor already passed, and the message would be skipped forever. Safe because
 * `MESSAGE_CONSUMED` copies the payload into the owner's log. No-op on a store without
 * `truncatePrefixKeeping` / `truncatePrefix`.
 *
 * Bounded: the scan starts just above `floor` (the highest sequence a previous trim, or a
 * backpressure scan, proved consumed) and stops at the first unconsumed message, so one trim costs
 * the entries it deletes plus one page, not the retained stream.
 */
export async function trimInbox(
  store: EventStore,
  chainId: string,
  cursors: Record<string, number>,
  floor = -1
): Promise<number | undefined> {
  const truncate = store.truncatePrefixKeeping
    ? (id: string, through: number) => store.truncatePrefixKeeping?.(id, through, [])
    : store.truncatePrefix
      ? (id: string, through: number) => store.truncatePrefix?.(id, through)
      : undefined;
  if (truncate === undefined) return undefined;
  const { oldest, head } = await scanInbox(store, chainId, cursors, {
    from: floor + 1,
    stopAtFirst: true,
  });
  if (head === null) return undefined;
  const through = Math.min(oldest === undefined ? head : oldest - 1, head - 1);
  if (through < 1 || through <= floor) return undefined; // sequence 0 is preserved by the store regardless
  await truncate(inboxStreamId(chainId), through);
  return through;
}

/**
 * Delete every inbox stream of the chain (it was reclaimed): the topic streams, the legacy stream and,
 * LAST, the registry that names the topic streams (a crash midway leaves them findable). Idempotent.
 */
export async function deleteInbox(
  store: EventStore,
  chainId: string,
  /** Also find topic streams the registry does not name (a prefix scan; the orphan sweep's backstop). */
  deep = false
): Promise<void> {
  if (store.deleteExecution === undefined) return;
  const { legacy, registry, topics } = await (deep ? inboxStreamsOfChainDeep : inboxStreamsOfChain)(
    store,
    chainId
  );
  for (const stream of topics) await store.deleteExecution(stream);
  await store.deleteExecution(legacy);
  if (registry !== undefined) await store.deleteExecution(registry);
}

/** Delete the consumed prefix of one TOPIC's stream (every entry up to the cursor, never the head). */
export async function trimTopicStream(
  store: EventStore,
  stream: string,
  cursor: number,
  floor = INBOX_TOPIC_SEQ_BASE - 1
): Promise<number | undefined> {
  const truncate = store.truncatePrefixKeeping
    ? (id: string, through: number) => store.truncatePrefixKeeping?.(id, through, [])
    : store.truncatePrefix
      ? (id: string, through: number) => store.truncatePrefix?.(id, through)
      : undefined;
  if (truncate === undefined) return undefined;
  const head = await headOf(store, stream);
  if (head === null) return undefined;
  const through = Math.min(cursor, head - 1);
  if (through < INBOX_TOPIC_SEQ_BASE || through <= floor) return undefined;
  await truncate(stream, through);
  return through;
}

// ── ADR 0110 amendment, D10b — the topic registry and the fleet switch ───────────────────────

/** The kind of a registry entry: one per topic that has a stream. Not a message, never delivered. */
export const INBOX_TOPIC_KIND = "INBOX_TOPIC";
/** The kind of the fleet-switch entry in {@link INBOX_LAYOUT_STREAM}. */
export const INBOX_LAYOUT_KIND = "INBOX_LAYOUT";

/** The kind of a tombstone: the topic's stream is drained, so it no longer counts as a LIVE topic. */
export const INBOX_TOPIC_RETIRED_KIND = "INBOX_TOPIC_RETIRED";

/**
 * The LIVE topics registered for a chain, in registration order: a topic added and not retired since.
 * (A retired topic's stream still exists, one drained entry holding the allocation head; it is found
 * for deletion by {@link inboxStreamsOfChain}, which names every topic ever added.)
 */
export async function readRegisteredTopics(store: EventStore, chainId: string): Promise<string[]> {
  const live = new Map<string, true>();
  for (const e of await store.read(inboxRegistryStreamId(chainId))) {
    const topic = (e.payload as { topic?: unknown } | null)?.topic;
    if (typeof topic !== "string") continue;
    if (e.eventType === INBOX_TOPIC_KIND) {
      live.delete(topic); // re-adding moves it to the end; order is registration order
      live.set(topic, true);
    } else if (e.eventType === INBOX_TOPIC_RETIRED_KIND) live.delete(topic);
  }
  return [...live.keys()];
}

async function appendRegistry(
  store: EventStore,
  chainId: string,
  eventType: string,
  topic: string,
  now: () => number
): Promise<void> {
  const registry = inboxRegistryStreamId(chainId);
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
    const head = await headOf(store, registry);
    const sequence = head === null ? 0 : head + 1;
    try {
      await store.append({
        id: `${registry}-${sequence}`,
        workflowId: INBOX_WORKFLOW_ID,
        executionId: registry,
        eventType,
        sequence,
        timestamp: now(),
        payload: { topic },
      });
      return;
    } catch (err) {
      if (err instanceof DuplicateSequenceError || err instanceof DuplicateEnvelopeIdError)
        continue;
      throw err;
    }
  }
  throw new Error(
    `inbox registry "${registry}": could not write an entry after ${APPEND_ATTEMPTS} attempts`
  );
}

/**
 * Make sure `topic` is a LIVE topic of the chain BEFORE its first message is written (every stream with
 * a message is therefore enumerable). `"full"` when the chain already has `maxTopics` other LIVE
 * topics (a drained topic does not count, see {@link retireInboxTopic}). Concurrent first sends of a
 * topic may both append an entry; readers dedupe.
 */
export async function registerInboxTopic(
  store: EventStore,
  chainId: string,
  topic: string,
  maxTopics: number,
  now: () => number
): Promise<"registered" | "present" | "full"> {
  const topics = await readRegisteredTopics(store, chainId);
  if (topics.includes(topic)) return "present";
  if (topics.length >= maxTopics) return "full";
  await appendRegistry(store, chainId, INBOX_TOPIC_KIND, topic, now);
  return "registered";
}

/**
 * A drained topic stops counting against the topic cap: a tombstone first, then a re-check of the
 * stream (`pending()`: has a message arrived past the cursor?). A sender appends THEN verifies the
 * registry; this retirer tombstones THEN re-checks the stream: whichever way they interleave, one of
 * them sees the other (the same protocol as the lost-wakeup), and the topic is made live again. The
 * topic re-registers on its next send. Returns whether the topic stayed retired.
 */
export async function retireInboxTopic(
  store: EventStore,
  chainId: string,
  topic: string,
  now: () => number,
  pending: () => Promise<boolean>
): Promise<boolean> {
  if (!(await readRegisteredTopics(store, chainId)).includes(topic)) return false;
  await appendRegistry(store, chainId, INBOX_TOPIC_RETIRED_KIND, topic, now);
  if (!(await pending())) return true;
  await appendRegistry(store, chainId, INBOX_TOPIC_KIND, topic, now);
  return false;
}

/** Has the fleet switched to per-topic writing? (A point read; the answer is monotone, so cache `true`.) */
export async function inboxLayoutActive(store: EventStore): Promise<boolean> {
  return (await headOf(store, INBOX_LAYOUT_STREAM)) !== null;
}

/** Write the fleet switch. Idempotent; returns whether THIS call wrote it. */
export async function activateInboxLayout(
  store: EventStore,
  now: () => number,
  by: { tenant?: string; actor?: string; onBehalfOf?: string }
): Promise<boolean> {
  try {
    await store.append({
      id: `${INBOX_LAYOUT_STREAM}-0`,
      workflowId: INBOX_WORKFLOW_ID,
      executionId: INBOX_LAYOUT_STREAM,
      eventType: INBOX_LAYOUT_KIND,
      sequence: 0,
      timestamp: now(),
      payload: { layout: "per-topic", by },
    });
    return true;
  } catch (err) {
    if (err instanceof DuplicateSequenceError || err instanceof DuplicateEnvelopeIdError)
      return false;
    throw err;
  }
}

/** The first retained sequence at or above `from` (a probe for tests and bounded reads). */
export async function firstRetained(
  store: EventStore,
  chainId: string,
  from: number,
  to: number
): Promise<number | undefined> {
  const got = await readRangeOf(store, inboxStreamId(chainId), from, to);
  return got[0]?.sequence;
}

/**
 * Would a delivery batch record a consumption at or below its topic's cursor (ADR 0110 D8)? The
 * batch is judged in order against the folded cursors, each entry advancing its own topic, exactly
 * as the fold will apply it. A well-formed batch is strictly increasing per topic and above the
 * cursor; anything else was built from a fold that has since moved (an operator discard).
 */
export function staleInboxBatch(
  state: ExecutionState,
  pre: ReadonlyArray<{ eventType: string; payload: unknown }>
): boolean {
  const cursors = { ...cursorsOf(state.variables) };
  for (const e of pre) {
    if (e.eventType !== "MESSAGE_CONSUMED") continue;
    const p = e.payload as { topic?: unknown; inboxSeq?: unknown };
    if (typeof p.topic !== "string" || typeof p.inboxSeq !== "number") continue;
    if (p.inboxSeq <= cursorFor(cursors, p.topic)) return true;
    cursors[p.topic] = p.inboxSeq;
  }
  return false;
}

// ── ADR 0110 amendment, D10a — journaled TTL expiry ──────────────────────────────────────────

/** The identity recorded as the `sender` of an expiry fact: the runtime itself, never an operator. */
export const INBOX_TTL_ACTOR = "__loom_inbox_ttl__";

/**
 * The smallest TTL a config may name (ms). A message is aged against a clock another node may have
 * stamped, so a TTL near the fleet's clock skew would expire fresh messages; like ADR 0055's
 * `MIN_ORPHAN_ERASE_MARGIN_MS`, a floor keeps the TTL an order of magnitude above any sane skew.
 */
export const MIN_INBOX_TTL_MS = 60_000;

/** What `messageTtlMs` accepts: one TTL for every topic, or per-topic with an optional default. */
export type InboxTtlConfig =
  | number
  | { default?: number; topics?: Readonly<Record<string, number>> };

/** The TTL (ms) of `topic`, or `undefined` when it never expires. Own-property lookup (a topic is caller data). */
export function ttlOfTopic(config: InboxTtlConfig | undefined, topic: string): number | undefined {
  if (config === undefined) return undefined;
  if (typeof config === "number") return config;
  const topics = config.topics;
  if (topics !== undefined && Object.hasOwn(topics, topic)) return topics[topic];
  return config.default;
}

/** Validate a TTL config at composition: every TTL a safe integer of at least {@link MIN_INBOX_TTL_MS}. */
export function assertTtlConfig(config: InboxTtlConfig | undefined): void {
  if (config === undefined) return;
  const check = (name: string, v: unknown): void => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < MIN_INBOX_TTL_MS) {
      throw new Error(
        `inbox messageTtlMs${name} must be an integer number of milliseconds of at least ${MIN_INBOX_TTL_MS} (got ${String(v)}): it expires unconsumed inbox messages, judged across nodes' clocks, so a smaller TTL could expire a fresh message (ADR 0110 D10a)`
      );
    }
  };
  if (typeof config === "number") {
    check("", config);
    return;
  }
  if (config.default !== undefined) check(".default", config.default);
  for (const [t, v] of Object.entries(config.topics ?? {})) check(`.topics["${t}"]`, v);
}

/** One expired, still-unconsumed message found by {@link scanExpired}. */
export interface ExpiredMessage {
  topic: string;
  seq: number;
  /** Its dedupe key ({@link dedupeKeyOf}): a resend of the id is a duplicate after the discard. */
  key: string;
}

/**
 * Find the unconsumed messages whose TTL has run out at `now`, oldest first, at most `maxExpired`.
 * Per topic only a PREFIX of the unconsumed messages is reported (the first unexpired message of a
 * topic closes it): a discard advances a topic's cursor THROUGH a sequence, so it can only skip a
 * prefix, and a sender with a skewed clock must not be able to get a younger message dropped ahead of
 * an older one. The scan starts above `from` (the known consumed floor) and runs to the head, so its
 * cost follows the retained stream, which `inboxMaxRetained` bounds. `nextAt` is the earliest instant
 * a message still unexpired will expire (the next wake), `more` says `maxExpired` cut the list short.
 * The decision reads the injected clock the caller passes in `now`; nothing here is ever folded.
 */
export async function scanExpired(
  store: EventStore,
  chainId: string,
  cursors: Record<string, number>,
  opts: {
    from: number;
    now: number;
    ttlOf: (topic: string) => number | undefined;
    maxExpired: number;
    /** ADR 0110 D10b: the chain's registered topics, each of which also has its own stream to scan. */
    topics?: readonly string[];
  }
): Promise<{ expired: ExpiredMessage[]; nextAt: number | undefined; more: boolean }> {
  const expired: ExpiredMessage[] = [];
  const closed = new Set<string>();
  let nextAt: number | undefined;
  let more = false;
  const scanStream = async (stream: string, from: number): Promise<void> => {
    const head = await headOf(store, stream);
    if (head === null) return;
    const visit = (events: readonly EventEnvelope[]): boolean => {
      for (const e of events) {
        const m = asMessage(e);
        if (m === undefined || e.sequence <= cursorFor(cursors, m.topic)) continue;
        const ttl = opts.ttlOf(m.topic);
        if (ttl === undefined || closed.has(m.topic)) continue;
        // A stamp AHEAD of the judge's clock (a sender whose clock runs fast, or a different clock than
        // the judge's) is suspect: it is never expired before `now` has passed the stamp itself, and
        // then only after its full TTL (`stamp + ttl`), so it is never dropped early. It stays "young"
        // exactly until the judge's clock passes `stamp + ttl`, not forever; and while it is young it
        // closes its topic (a prefix scan), so older messages behind it wait.
        const expiresAt = e.timestamp + ttl;
        if (e.timestamp > opts.now || expiresAt > opts.now) {
          closed.add(m.topic);
          if (nextAt === undefined || expiresAt < nextAt) nextAt = expiresAt;
          continue;
        }
        if (expired.length >= opts.maxExpired) {
          more = true;
          return true;
        }
        expired.push({ topic: m.topic, seq: e.sequence, key: dedupeKeyOf(m) });
      }
      return false;
    };
    let lo = Math.max(0, from);
    while (lo <= head) {
      const page = await readRangeOf(store, stream, lo, Math.min(head, lo + READ_CHUNK - 1));
      if (page.length === 0) {
        visit(await store.readFrom(stream, lo));
        return;
      }
      if (visit(page)) return;
      lo = (page[page.length - 1] as EventEnvelope).sequence + 1;
    }
  };
  // The legacy stream first (its sequences are below every topic stream's), then each topic's own.
  await scanStream(inboxStreamId(chainId), opts.from);
  for (const topic of opts.topics ?? []) {
    if (more || opts.ttlOf(topic) === undefined) continue;
    await scanStream(
      inboxTopicStreamId(chainId, topic),
      Math.max(INBOX_TOPIC_SEQ_BASE, cursorFor(cursors, topic) + 1)
    );
  }
  return { expired, nextAt, more };
}

/**
 * The `MESSAGE_CONSUMED` facts of one topic's discard (D8 and D10a share them): one per skipped
 * message (its own dedupe key, no payload), the last carrying the whole discard; with nothing to skip,
 * one fact under a fixed key still advances the cursor. The fold is untouched: the reserved
 * {@link DISCARD_WAIT_ID} records one answer ever, and the extra fields ride in the payload.
 */
export function discardFacts(
  topic: string,
  skipped: ReadonlyArray<{ key: string; seq: number }>,
  through: number,
  sender: InboxMessage["sender"],
  summary: object
): Array<{ eventType: string; payload: unknown }> {
  const fact = (messageId: string, inboxSeq: number, extra: object) => ({
    eventType: "MESSAGE_CONSUMED",
    payload: {
      // A fixed id no wait can have: the fold records ONE answer under it, ever (first wins).
      waitId: DISCARD_WAIT_ID,
      topic,
      messageId,
      inboxSeq,
      sender,
      payload: null,
      discarded: true,
      ...extra,
    },
  });
  if (skipped.length === 0) return [fact(discardKeyOf(topic, through), through, summary)];
  return skipped.map((k, i) =>
    i === skipped.length - 1 ? fact(k.key, through, summary) : fact(k.key, k.seq, {})
  );
}
