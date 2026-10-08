import type { EventEnvelope } from "@loom/core";
import { type EventStore, headOf, readRangeOf } from "@loom/event-runtime";
import { createInboxSource, inboxStreamId } from "@loom/workflow-runtime";
import { senderKey } from "./access";
import { CONVERSATION_TOPIC } from "./types";

// ── What notices a message while a turn is running (ADR 0122 D2) ──────────────────────────────────
//
// A registered `ctx.receive` is NOT woken while the owner has a step in flight: the kernel delivers an
// inbox message at the owner's quiescence commit (ADR 0110 D5), and a model call IS an in-flight step.
// So the flow cannot learn of a barge-in from the inbox primitives it already has. The signal has to
// come from OUTSIDE the flow body: the process running the turn subscribes to the conversation's
// inbox stream (a store-level subscription, the same seam `liveQuery` uses) and fires the turn's
// AbortSignal when a message lands.
//
// That signal is not data and the flow never branches on it directly. `agentLoop$` reads it only
// through RECORDED checkpoints (ADR 0121 D3), so what the interruption did is in the log and a replay
// reproduces it without any subscription at all. The consumption of the interrupting message is the
// ordinary `ctx.receive` that follows the interrupted turn.
//
// A RETRY is not a barge-in. The kernel delivers a duplicate `messageId` once, but a subscription
// sees every append, so the signal must not fire for a message the conversation already took: the
// client stamps each turn with its idempotency key (`id`), the flow remembers the keys of recent
// turns (including the one running), and the source ignores a message whose key is known.

export interface BargeInHandlers {
  /** Fire the running turn's abort signal. */
  onMessage: () => void;
  /** Whether a client idempotency key belongs to a turn this conversation already took (or is running). */
  isKnown: (id: string) => boolean;
  /**
   * Whether a stored inbox message may interrupt the running turn at all. Default: any message on the
   * conversation topic. Shared mode passes a check that the envelope is signed AND from the SAME asker
   * as the running turn: a participant interrupts only their own turn.
   */
  accept?: (stored: StoredInboxMessage) => boolean;
  /**
   * The idempotency key a stored message claims. Default (owner mode): the payload `id`, honoured only
   * when it equals the kernel's dedupe identity of THIS message (`senderKey(sender, messageId)`), so a
   * different sender replaying someone's id is a new message, not a retry.
   */
  idOf?: (stored: StoredInboxMessage) => string | undefined;
}

/** What the inbox stream holds per message (the shape `runtime.send` appends). */
export interface StoredInboxMessage {
  topic?: unknown;
  messageId?: unknown;
  payload?: unknown;
  sender?: { tenant?: string; actor?: string; onBehalfOf?: string };
}

/**
 * Tell `handlers.onMessage` when a NEW message lands for `conversationId`, and return the way to stop
 * listening. `ownerId` is the execution (generation) running the turn. Supplied to
 * `ConversationConfig.bargeIn`; the standard source is {@link inboxBargeIn}. Without one a
 * conversation QUEUES: a message sent mid-turn waits for the turn to finish.
 */
export type BargeInSource = (
  conversationId: string,
  ownerId: string,
  handlers: BargeInHandlers
) => Promise<() => void> | (() => void);

/** How far back in the owner's log the consumed cursor is looked for, at most. */
const MAX_LOOKBACK = 8192;
const TAIL_BLOCK = 128;
/** How many waiting messages a peek inspects. */
const PEEK_LIMIT = 16;

const ownerModeId = (m: StoredInboxMessage): string | undefined => {
  const id = (m.payload as { id?: unknown } | null | undefined)?.id;
  if (typeof id !== "string" || typeof m.messageId !== "string") return undefined;
  return id === senderKey(m.sender ?? {}, m.messageId) ? id : undefined;
};

/** Whether `m` is a NEW message by the handlers' rules (on the topic, accepted, not a known retry). */
export function isNew(
  m: StoredInboxMessage,
  h: Pick<BargeInHandlers, "isKnown" | "accept" | "idOf">
): boolean {
  if (m.topic !== CONVERSATION_TOPIC) return false;
  if (h.accept !== undefined && !h.accept(m)) return false;
  const id = (h.idOf ?? ownerModeId)(m);
  return id === undefined || !h.isKnown(id);
}

/**
 * Whether the inbox holds a message the owner has not consumed and the conversation does not already
 * know: the stream past the newest `MESSAGE_CONSUMED` cursor in the owner's log. The owner's log is read
 * BACKWARDS in blocks until a consumption is found (bounded by {@link MAX_LOOKBACK} events), so a turn
 * with any amount of tool traffic, or a recovery re-running one, is still compared against the right
 * cursor. Conservative: when no consumption is found (a fresh generation whose first message rode the
 * carry) it says `false` and the message is simply handled after the turn.
 */
export async function pendingInbox(
  store: EventStore,
  conversationId: string,
  ownerId: string,
  h: Pick<BargeInHandlers, "isKnown" | "accept" | "idOf"> = { isKnown: () => false }
): Promise<boolean> {
  const waiting = await pendingMessages(store, conversationId, ownerId, PEEK_LIMIT);
  return waiting?.some((m) => isNew(m, h)) === true;
}

/**
 * The messages waiting in the inbox past the owner's consumed cursor (at most `limit`), or `undefined`
 * when the cursor cannot be established. The owner's log is read BACKWARDS in blocks until a consumption
 * is found, bounded by {@link MAX_LOOKBACK}.
 */
export async function pendingMessages(
  store: EventStore,
  conversationId: string,
  ownerId: string,
  limit: number
): Promise<StoredInboxMessage[] | undefined> {
  const newest = await headOf(store, inboxStreamId(conversationId));
  if (newest === null) return [];
  const tip = await headOf(store, ownerId);
  if (tip === null) return undefined;
  let consumed = -1;
  let upper = tip;
  while (upper >= 0 && tip - upper < MAX_LOOKBACK && consumed < 0) {
    const lo = Math.max(0, upper - TAIL_BLOCK + 1);
    const block = await readRangeOf(store, ownerId, lo, upper);
    for (const ev of block as EventEnvelope[]) {
      if (ev.eventType !== "MESSAGE_CONSUMED") continue;
      const seq = (ev.payload as { inboxSeq?: unknown } | null)?.inboxSeq;
      if (typeof seq === "number" && seq > consumed) consumed = seq;
    }
    upper = lo - 1;
  }
  if (consumed < 0) return undefined;
  if (newest <= consumed) return [];
  return createInboxSource(store)(conversationId, CONVERSATION_TOPIC, consumed, limit);
}

/**
 * The standard {@link BargeInSource}: subscribe to the conversation's inbox stream on `eventStore`
 * (an in-process notification for the in-memory store, LISTEN/NOTIFY for Postgres), and, once
 * subscribed, look for a message that is ALREADY waiting (one sent between the previous turn's
 * consumption and now), so a message cannot be missed by arriving a moment early.
 */
export function inboxBargeIn(eventStore: EventStore): BargeInSource {
  return async (conversationId, ownerId, handlers) => {
    const unsubscribe = await eventStore.subscribe(inboxStreamId(conversationId), (ev) => {
      if (isNew(ev.payload as StoredInboxMessage, handlers)) handlers.onMessage();
    });
    try {
      if (await pendingInbox(eventStore, conversationId, ownerId, handlers)) handlers.onMessage();
    } catch (err) {
      unsubscribe();
      throw err;
    }
    return unsubscribe;
  };
}
