import type { EventEnvelope } from "@loom/core";
import {
  DuplicateEnvelopeIdError,
  DuplicateSequenceError,
  INBOX_TOPIC_SEQ_BASE,
  headOf,
  inboxTopicStreamId,
  quarantineStreamId,
  readRangeOf,
} from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { QUARANTINE_FOLD_CAP } from "@loom/replay-vm";
import {
  INBOX_MESSAGE_KIND,
  INBOX_WORKFLOW_ID,
  type QuarantineEntry,
  SEALED_WALK_BUDGET,
  asMessage,
  dedupeKeyOf,
  inboxStreamId,
  sealedEnvelopeIn,
} from "./inbox";
import type { InboxMessage } from "./types";

// ── ADR 0130 residuals D9 - the quarantine stream and its facts ───────────────────────────────
//
// `quarantineInbox` copies the held message, still sealed, into `__loom_quarantine__:<chainId>` BEFORE
// journaling `INBOX_QUARANTINED`; the copy is the retained record once the cursor moves past the
// original. Everything here is mechanism: the delivery rule is `inboxDeliverable` (inbox.ts), the
// verbs and the delivery points live in WorkflowRuntime / WorkflowContext.

/** The runtime default for `kernel.inbox.quarantineMax`: held messages per chain. */
export const DEFAULT_QUARANTINE_MAX = 256;
/** The ceiling of `quarantineMax`: the fold's own cap (a fold cannot read a runtime setting). */
export const QUARANTINE_MAX_CEILING = QUARANTINE_FOLD_CAP;
/** A copy's envelope id is `quarantine:<dedupe key>`: a retry of the copy is a duplicate append. */
export const QUARANTINE_ENVELOPE_PREFIX = "quarantine:";
const APPEND_ATTEMPTS = 64;

/** `kernel.inbox.quarantineMax`, validated: a positive integer no larger than the fold cap. */
export function assertQuarantineMax(v: number | undefined): void {
  if (v === undefined) return;
  if (!Number.isSafeInteger(v) || v < 1 || v > QUARANTINE_MAX_CEILING) {
    throw new Error(
      `inbox quarantineMax must be an integer from 1 to ${QUARANTINE_MAX_CEILING} (the fold's cap, ADR 0130 residuals D9; got ${String(v)})`
    );
  }
}

/** The inbox stream (legacy or the topic's own) a message at `inboxSeq` was written to. */
export function inboxStreamOfSeq(chainId: string, topic: string, inboxSeq: number): string {
  return inboxSeq >= INBOX_TOPIC_SEQ_BASE
    ? inboxTopicStreamId(chainId, topic)
    : inboxStreamId(chainId);
}

/** The stored envelope of the inbox message at `inboxSeq` (metadata and all), or `undefined`. */
export async function readInboxEnvelope(
  store: EventStore,
  chainId: string,
  topic: string,
  inboxSeq: number
): Promise<EventEnvelope | undefined> {
  return (
    await readRangeOf(store, inboxStreamOfSeq(chainId, topic, inboxSeq), inboxSeq, inboxSeq)
  )[0];
}

/**
 * Is `payload` (or any node of it) the erasure marker `{ $shredded: true }` a non-loud inbox read
 * leaves where it could not open a sealed field (ADR 0110 D9)? A REDACTED read is not evidence that
 * a message is plain or openable, and it must never be delivered. The walk is bounded and iterative
 * like {@link sealedEnvelopeIn}; running out of budget answers "redacted" (fail closed).
 */
export function readsAsRedacted(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  let queue: unknown[] = [payload];
  let seen = 0;
  while (queue.length > 0) {
    const next: unknown[] = [];
    for (const x of queue) {
      if (++seen > SEALED_WALK_BUDGET) return true;
      if ((x as { $shredded?: unknown }).$shredded === true) return true;
      for (const child of Object.values(x as object)) {
        if (typeof child === "object" && child !== null) next.push(child);
      }
    }
    queue = next;
  }
  return false;
}

/** Why a held copy cannot be delivered by THIS node. */
export type CopyUnavailable =
  /** Not in the quarantine stream at `heldAt` (trimmed, deleted, or never copied): an operator must discard. */
  | "missing"
  /** The envelope at `heldAt` is not the entry's message. */
  | "mismatch"
  /** Read as REDACTED (a key this node does not hold): key-unavailable, never delivered. */
  | "redacted"
  /** Still carries a ciphertext envelope this node did not open. */
  | "sealed";

export type CopyRead =
  | { ok: true; message: InboxMessage }
  | { ok: false; why: CopyUnavailable; message?: InboxMessage };

/**
 * Read the held copy of `entry` from the chain's quarantine stream and judge it: deliverable only
 * when it is the entry's message AND it reads as a real, opened payload. A copy that reads as the
 * REDACTED marker (the stream's reads are non-loud) is a key-unavailable refusal, not a message.
 */
export async function readQuarantineCopy(
  store: EventStore,
  chainId: string,
  entry: QuarantineEntry
): Promise<CopyRead> {
  const env = (
    await readRangeOf(store, quarantineStreamId(chainId), entry.heldAt, entry.heldAt)
  )[0];
  if (env === undefined) return { ok: false, why: "missing" };
  const message = asMessage(env);
  if (message === undefined || dedupeKeyOf(message) !== entry.key) {
    return { ok: false, why: "mismatch" };
  }
  if (readsAsRedacted(message.payload)) return { ok: false, why: "redacted", message };
  if (sealedEnvelopeIn(message.payload) !== "clean") return { ok: false, why: "sealed", message };
  // The copy keeps the message's ORIGINAL position, so a delivery journals the original inboxSeq.
  return { ok: true, message: { ...message, inboxSeq: entry.inboxSeq } };
}

/** The copy of `key` already in the stream (an orphan of a crashed attempt), by its deterministic id. */
export async function findQuarantineCopy(
  store: EventStore,
  chainId: string,
  key: string
): Promise<EventEnvelope | undefined> {
  const id = `${QUARANTINE_ENVELOPE_PREFIX}${key}`;
  return (await store.read(quarantineStreamId(chainId))).find((e) => e.id === id);
}

/**
 * Copy the held message VERBATIM (payload still sealed, `metadata.seal` kept) into the chain's
 * quarantine stream, at the next free sequence, with the deterministic id `quarantine:<key>`. Returns
 * its sequence (`heldAt`). Idempotent: a copy that already exists (a crashed earlier attempt, a rival
 * quarantiner of the same message) is reused, never duplicated.
 */
export async function appendQuarantineCopy(
  store: EventStore,
  chainId: string,
  original: EventEnvelope,
  key: string
): Promise<number> {
  const stream = quarantineStreamId(chainId);
  const id = `${QUARANTINE_ENVELOPE_PREFIX}${key}`;
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
    const existing = await findQuarantineCopy(store, chainId, key);
    if (existing !== undefined) return existing.sequence;
    const head = await headOf(store, stream);
    const sequence = head === null ? 0 : head + 1;
    try {
      await store.append({
        ...original,
        id,
        executionId: stream,
        workflowId: INBOX_WORKFLOW_ID,
        eventType: INBOX_MESSAGE_KIND,
        sequence,
      });
      return sequence;
    } catch (err) {
      if (err instanceof DuplicateSequenceError || err instanceof DuplicateEnvelopeIdError) {
        if (attempt >= 2) await new Promise((r) => setTimeout(r, Math.random() * 2 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `quarantine stream "${stream}": could not copy a message after ${APPEND_ATTEMPTS} attempts`
  );
}

/**
 * The RETAINED span of the quarantine stream: its head minus the oldest still-live copy (orphans of
 * a crashed attempt included), or 1 (the kept head) when nothing is held. `quarantineMax` bounds it.
 */
export function retainedSpan(head: number | null, liveHeldAts: readonly number[]): number {
  if (head === null) return 0;
  if (liveHeldAts.length === 0) return 1;
  return Math.max(1, head - Math.min(...liveHeldAts) + 1);
}

/**
 * Delete the fully released/discarded PREFIX of the quarantine stream: every copy below the oldest
 * live entry's `heldAt`, never the head itself (so the next copy allocates `head + 1`, monotonic).
 * Best effort; a no-op on a store without prefix truncation.
 */
export async function trimQuarantine(
  store: EventStore,
  chainId: string,
  liveHeldAts: readonly number[]
): Promise<number | undefined> {
  const truncate = store.truncatePrefixKeeping
    ? (id: string, through: number) => store.truncatePrefixKeeping?.(id, through, [])
    : store.truncatePrefix
      ? (id: string, through: number) => store.truncatePrefix?.(id, through)
      : undefined;
  if (truncate === undefined) return undefined;
  const stream = quarantineStreamId(chainId);
  const head = await headOf(store, stream);
  if (head === null) return undefined;
  const oldest = liveHeldAts.length === 0 ? head : Math.min(...liveHeldAts);
  const through = Math.min(oldest - 1, head - 1);
  if (through < 1) return undefined; // sequence 0 is preserved by the store regardless
  await truncate(stream, through);
  return through;
}

/** The duplicate-advance fact a quarantine batch journals for each already-seen message ahead of the head. */
export function skippedDuplicateFact(
  topic: string,
  key: string,
  inboxSeq: number,
  sender: InboxMessage["sender"],
  waitId: string
): { eventType: string; payload: unknown } {
  return {
    eventType: "MESSAGE_CONSUMED",
    payload: { waitId, topic, messageId: key, inboxSeq, sender, payload: null },
  };
}
