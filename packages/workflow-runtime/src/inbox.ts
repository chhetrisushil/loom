import { createHash } from "node:crypto";
import type { EventEnvelope, ExecutionState } from "@loom/core";
import {
  DuplicateEnvelopeIdError,
  DuplicateSequenceError,
  headOf,
  readRangeOf,
} from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import type { InboxMessage, InboxSource } from "./types";

// ── ADR 0110 D1 — the inbox stream ───────────────────────────────────────────────────────────
//
// An execution's inbox is a SEPARATE reserved control stream, `__loom_inbox__:<chainId>`. The only
// writer is the kernel's `runtime.send`; the owner PULLS (a read past its per-topic cursor) and
// journals consumption into its OWN log as `MESSAGE_CONSUMED`. The owner's log is therefore never
// appended to by a sender, which is what removes the sequence race the audit measured.

export const INBOX_STREAM_PREFIX = "__loom_inbox__:";
/** The stream's event kind. Not an `EVENT_SCHEMA` kind: it exists only in the control stream. */
export const INBOX_MESSAGE_KIND = "INBOX_MESSAGE";
const INBOX_WORKFLOW_ID = "__loom_inbox__";

/**
 * The `TimerRecord.wakeAt` of an inbox wake row. A FIXED instant, so the store's per-
 * `(executionId, wakeAt)` upsert coalesces a burst of N sends into ONE row without a query
 * (ADR 0110 D5.3's "a due-now row already exists" test, made free). `TimerService` recognises the
 * value and runs the notify path instead of judging `suspendedOn.wakeAt`.
 */
export const INBOX_WAKE_AT = 0;

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

/**
 * {@link chainIdOf} read from sequence 0 alone (the fold's own rule: a valid `forkChain` stamp wins,
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
    const stream = inboxStreamId(chainId);
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
  };
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
  now: () => number
): Promise<number> {
  let queues = sendQueues.get(store);
  if (queues === undefined) {
    queues = new Map();
    sendQueues.set(store, queues);
  }
  const prior = queues.get(chainId) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(() => appendOnce(store, chainId, message, now));
  const tail = run.catch(() => undefined);
  queues.set(chainId, tail);
  void tail.then(() => {
    if (queues.get(chainId) === tail) queues.delete(chainId);
  });
  return run;
}

async function appendOnce(
  store: EventStore,
  chainId: string,
  message: StoredMessage,
  now: () => number
): Promise<number> {
  const stream = inboxStreamId(chainId);
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
    const head = await headOf(store, stream);
    const sequence = head === null ? 0 : head + 1;
    const envelope: EventEnvelope = {
      id: `${stream}-${sequence}`,
      workflowId: INBOX_WORKFLOW_ID,
      executionId: stream,
      eventType: INBOX_MESSAGE_KIND,
      sequence,
      timestamp: now(),
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
    `inbox "${chainId}": could not allocate a sequence after ${APPEND_ATTEMPTS} attempts`
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
  if (!Number.isSafeInteger(floor) || floor < 0) return;
  const stream = inboxStreamId(chainId);
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

/** The largest cursor of `cursors` (the highest inbox sequence this owner has consumed), or -1. */
export function maxCursor(cursors: Record<string, number>): number {
  let max = -1;
  for (const v of Object.values(cursors)) if (typeof v === "number" && v > max) max = v;
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
  opts: { from?: number; stopAtFirst?: boolean; limit?: number } = {}
): Promise<{ unconsumed: number; oldest: number | undefined; head: number | null }> {
  const stream = inboxStreamId(chainId);
  const head = await headOf(store, stream);
  if (head === null) return { unconsumed: 0, oldest: undefined, head };
  let unconsumed = 0;
  let oldest: number | undefined;
  const visit = (events: readonly EventEnvelope[]): boolean => {
    for (const e of events) {
      const m = asMessage(e);
      if (m === undefined || e.sequence <= cursorFor(cursors, m.topic)) continue;
      unconsumed++;
      oldest ??= e.sequence;
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
  return { unconsumed, oldest, head };
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

/** Delete the whole stream (the chain was reclaimed). Idempotent. */
export async function deleteInbox(store: EventStore, chainId: string): Promise<void> {
  await store.deleteExecution?.(inboxStreamId(chainId));
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
