import { createHash } from "node:crypto";
import type { EventEnvelope, ExecutionState } from "@loom/core";
import {
  DuplicateEnvelopeIdError,
  DuplicateSequenceError,
  INBOX_STREAM_PREFIX,
  chainIdOfFirst,
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

export { INBOX_STREAM_PREFIX };
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
  now: () => number | Promise<number>
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
  now: () => number | Promise<number>
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
): Promise<{
  unconsumed: number;
  oldest: number | undefined;
  /** The topic of `oldest`: the message pinning everything above it. */
  oldestTopic: string | undefined;
  head: number | null;
}> {
  const stream = inboxStreamId(chainId);
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
  }
): Promise<{ expired: ExpiredMessage[]; nextAt: number | undefined; more: boolean }> {
  const stream = inboxStreamId(chainId);
  const expired: ExpiredMessage[] = [];
  const closed = new Set<string>();
  let nextAt: number | undefined;
  let more = false;
  const head = await headOf(store, stream);
  if (head === null) return { expired, nextAt, more };
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
  let lo = Math.max(0, opts.from);
  while (lo <= head) {
    const page = await readRangeOf(store, stream, lo, Math.min(head, lo + READ_CHUNK - 1));
    if (page.length === 0) {
      visit(await store.readFrom(stream, lo));
      break;
    }
    if (visit(page)) break;
    lo = (page[page.length - 1] as EventEnvelope).sequence + 1;
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
