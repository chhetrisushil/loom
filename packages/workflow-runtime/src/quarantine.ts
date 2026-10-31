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
import type { ReservedStreamArchive } from "./archiveMove";
import { ReservedStreamArchiveRequiredError } from "./checkpointGuard";
import {
  INBOX_MESSAGE_KIND,
  INBOX_WORKFLOW_ID,
  type QuarantineEntry,
  SEALED_WALK_BUDGET,
  asMessage,
  cursorFor,
  dedupeKeyOf,
  inboxStreamId,
  sealedEnvelopeIn,
} from "./inbox";
import type { ArchiveFloor } from "./inbox";
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
/**
 * A copy's envelope id is `quarantine:<chainId>:<dedupe key>:<inboxSeq>`: deterministic, so a retry of the copy
 * is a duplicate append. The chain is part of it because a SQL store keeps envelope ids unique across
 * ALL streams, and the same sender/message id (hence the same dedupe key) legitimately recurs in
 * different chains.
 */
export const QUARANTINE_ENVELOPE_PREFIX = "quarantine:";

/**
 * The deterministic envelope id of the copy of `key` (the message at `inboxSeq`) in `chainId`'s
 * quarantine stream. `inboxSeq` is part of it: the same key legitimately recurs (a sender's retry,
 * a key the dedupe window evicted), and a copy must never be reused for a DIFFERENT message that
 * merely shares the key.
 */
export function quarantineCopyId(chainId: string, key: string, inboxSeq: number): string {
  return `${QUARANTINE_ENVELOPE_PREFIX}${chainId}:${key}:${inboxSeq}`;
}

/** What a copy's `metadata.quarantine` records: the message's origin (topic and original `inboxSeq`). */
export interface QuarantineStamp {
  topic: string;
  inboxSeq: number;
}

/** The stamp of a copy, or `undefined` (a copy made by nothing in this module). */
export function stampOf(env: EventEnvelope): QuarantineStamp | undefined {
  const q = (env.metadata as { quarantine?: unknown } | undefined)?.quarantine;
  if (q === null || typeof q !== "object") return undefined;
  const { topic, inboxSeq } = q as { topic?: unknown; inboxSeq?: unknown };
  return typeof topic === "string" && typeof inboxSeq === "number"
    ? { topic, inboxSeq }
    : undefined;
}
const APPEND_ATTEMPTS = 64;

/**
 * Sequence 0 of a quarantine stream is a payload-free anchor, never a message: a store keeps sequence 0
 * through every prefix truncation (the bootstrap-anchor contract), so a message copied there could never
 * be freed. Idempotent (a rival's anchor is the same anchor).
 */
async function ensureAnchor(store: EventStore, chainId: string): Promise<void> {
  const stream = quarantineStreamId(chainId);
  try {
    await store.append({
      id: `${QUARANTINE_ENVELOPE_PREFIX}${chainId}:anchor`,
      executionId: stream,
      workflowId: INBOX_WORKFLOW_ID,
      eventType: INBOX_MESSAGE_KIND,
      sequence: 0,
      timestamp: Date.now(),
      payload: { anchor: true },
    } as EventEnvelope);
  } catch (err) {
    if (!(err instanceof DuplicateSequenceError || err instanceof DuplicateEnvelopeIdError))
      throw err;
  }
}

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
  // The copy must be THIS entry's message: the same key AND the same original position (a stale copy
  // of an earlier message that shared the key is a mismatch, never a delivery). A fork re-ids the
  // copies, so the match is on the stamp, not the id.
  if (
    message === undefined ||
    dedupeKeyOf(message) !== entry.key ||
    stampOf(env)?.inboxSeq !== entry.inboxSeq
  ) {
    return { ok: false, why: "mismatch" };
  }
  if (readsAsRedacted(message.payload)) return { ok: false, why: "redacted", message };
  if (sealedEnvelopeIn(message.payload) !== "clean") return { ok: false, why: "sealed", message };
  // The copy keeps the message's ORIGINAL position, so a delivery journals the original inboxSeq.
  return { ok: true, message: { ...message, inboxSeq: entry.inboxSeq } };
}

/** The copy of `key`'s message at `inboxSeq` already in the stream (an orphan of a crashed attempt), by its deterministic id. */
export async function findQuarantineCopy(
  store: EventStore,
  chainId: string,
  key: string,
  inboxSeq: number
): Promise<EventEnvelope | undefined> {
  const id = quarantineCopyId(chainId, key, inboxSeq);
  return (await store.read(quarantineStreamId(chainId))).find((e) => e.id === id);
}

/**
 * Copy the held message VERBATIM (payload still sealed, `metadata.seal` kept) into the chain's
 * quarantine stream, at the next free sequence, with the deterministic id {@link quarantineCopyId}. Returns
 * its sequence (`heldAt`). Idempotent: a copy that already exists (a crashed earlier attempt, a rival
 * quarantiner of the same message) is reused, never duplicated.
 */
export async function appendQuarantineCopy(
  store: EventStore,
  chainId: string,
  original: EventEnvelope,
  key: string,
  topic: string,
  inboxSeq: number,
  archiveFloor?: ArchiveFloor
): Promise<number> {
  const stream = quarantineStreamId(chainId);
  const id = quarantineCopyId(chainId, key, inboxSeq);
  const stamp: QuarantineStamp = { topic, inboxSeq };
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
    const existing = await findQuarantineCopy(store, chainId, key, inboxSeq);
    if (existing !== undefined) return existing.sequence;
    let head = await headOf(store, stream);
    if (head === null) {
      await ensureAnchor(store, chainId);
      head = await headOf(store, stream);
    }
    // ADR 0139: a quarantine stream trimmed to its anchor (sequence 0) restarts at 1; the archive holds
    // those sequences already, so the next copy goes above the last one it holds.
    const sequence = Math.max(
      head === null ? 1 : head + 1,
      head === null || head === 0 ? ((await archiveFloor?.(stream)) ?? 1) : 1
    );
    try {
      await store.append({
        ...original,
        id,
        executionId: stream,
        workflowId: INBOX_WORKFLOW_ID,
        eventType: INBOX_MESSAGE_KIND,
        sequence,
        metadata: { ...original.metadata, quarantine: stamp },
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
 * The RETAINED span of the quarantine stream: its head minus the oldest copy that is still PINNED
 * (live, or in flight - see {@link trimQuarantine}), or 0 when nothing is retained. `quarantineMax`
 * bounds it.
 */
export function retainedSpan(head: number | null, oldestPinned: number | null | undefined): number {
  if (head === null || oldestPinned === null || oldestPinned === undefined) return 0;
  return Math.max(1, head - oldestPinned + 1);
}

/** What a trim left behind: the stream's head and its oldest still-pinned copy (both `null` when it is gone). */
export interface TrimResult {
  head: number | null;
  oldestPinned: number | null;
}

/**
 * Free what is POSITIVELY disposed of in the quarantine stream, and nothing else (ADR 0130 D9). A
 * copy is disposed of when no live `_quarantined` entry references it AND its original message is at
 * or below its topic's cursor (it was released and consumed, discarded, or lost the race to a plain
 * delivery, so no fact can ever name it). Any other copy is PINNED: it is live, or it is in flight
 * (appended by a quarantiner whose `INBOX_QUARANTINED` has not landed yet; its original is still above
 * the cursor), and trimming it would strand that message. The caller's fold may be stale: a stale
 * cursor only pins more, and a fact landing after the fold moves the cursor onto an original that this
 * fold still reads as above it, so a stale view never frees a copy a fact is about to name.
 *
 * Frees the disposed PREFIX (below the oldest pinned copy). Sequence 0 survives `truncatePrefix` by the
 * store contract, so it holds a payload-free ANCHOR ({@link ensureAnchor}) and no message ever sits there:
 * when nothing is pinned, no message bytes remain at rest. Best effort; a no-op on a store without prefix
 * truncation.
 */
export async function trimQuarantine(
  store: EventStore,
  chainId: string,
  live: readonly QuarantineEntry[],
  cursors: Record<string, number>,
  archive?: ReservedStreamArchive
): Promise<TrimResult> {
  const stream = quarantineStreamId(chainId);
  const copies = await store.read(stream);
  const head = copies.length === 0 ? null : (copies[copies.length - 1] as EventEnvelope).sequence;
  if (head === null) return { head: null, oldestPinned: null };
  const liveAt = new Set(live.map((x) => x.heldAt));
  let oldestPinned: number | null = null;
  for (const c of copies) {
    if (liveAt.has(c.sequence)) {
      oldestPinned = c.sequence;
      break;
    }
    const stamp = stampOf(c);
    // An unstamped copy (nothing here writes one) is disposed once nothing live names it.
    if (stamp !== undefined && stamp.inboxSeq > cursorFor(cursors, stamp.topic)) {
      oldestPinned = c.sequence;
      break;
    }
  }
  const truncate = store.truncatePrefixKeeping
    ? (through: number) => store.truncatePrefixKeeping?.(stream, through, [])
    : store.truncatePrefix
      ? (through: number) => store.truncatePrefix?.(stream, through)
      : undefined;
  // Nothing pinned: free everything observed, the head included (a copy that lands after the read has
  // a higher sequence and survives). Only the payload-free anchor at sequence 0 stays.
  const through = oldestPinned === null ? head : oldestPinned - 1;
  if (truncate !== undefined && through >= 1) {
    // ADR 0139: the copies MOVE to the archive first; no archive, no trim.
    if (archive === undefined) throw new ReservedStreamArchiveRequiredError(stream);
    await archive.moveThrough(stream, through);
    await truncate(through);
  }
  return { head, oldestPinned: oldestPinned === null ? null : oldestPinned };
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
