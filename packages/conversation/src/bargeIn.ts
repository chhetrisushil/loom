import type { EventEnvelope } from "@loom/core";
import { type EventStore, headOf, readRangeOf } from "@loom/event-runtime";
import { createInboxSource, inboxStreamId } from "@loom/workflow-runtime";
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

/** How far back in the owner's log the consumed cursor is looked for. */
const TAIL_WINDOW = 64;
/** How many waiting messages a peek inspects. */
const PEEK_LIMIT = 16;

const idOf = (payload: unknown): string | undefined => {
  const id = (payload as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" ? id : undefined;
};

/**
 * Whether the inbox holds a message the owner has not consumed and the conversation does not already
 * know: the stream past the newest `MESSAGE_CONSUMED` cursor in the tail of the owner's log. A few
 * point reads and one bounded range. Conservative: when the owner's tail holds no consumption at all
 * (nothing to compare with) it says `false`, and the message is simply handled after the turn.
 */
export async function pendingInbox(
  store: EventStore,
  conversationId: string,
  ownerId: string,
  isKnown: (id: string) => boolean = () => false
): Promise<boolean> {
  const newest = await headOf(store, inboxStreamId(conversationId));
  if (newest === null) return false;
  const tip = await headOf(store, ownerId);
  if (tip === null) return false;
  const tail = await readRangeOf(store, ownerId, Math.max(0, tip - TAIL_WINDOW + 1), tip);
  let consumed = -1;
  for (const ev of tail as EventEnvelope[]) {
    if (ev.eventType !== "MESSAGE_CONSUMED") continue;
    const seq = (ev.payload as { inboxSeq?: unknown } | null)?.inboxSeq;
    if (typeof seq === "number" && seq > consumed) consumed = seq;
  }
  if (consumed < 0 || newest <= consumed) return false;
  const waiting = await createInboxSource(store)(
    conversationId,
    CONVERSATION_TOPIC,
    consumed,
    PEEK_LIMIT
  );
  return waiting.some((m) => {
    const id = idOf(m.payload);
    return id === undefined || !isKnown(id);
  });
}

/**
 * The standard {@link BargeInSource}: subscribe to the conversation's inbox stream on `eventStore`
 * (an in-process notification for the in-memory store, LISTEN/NOTIFY for Postgres), and, once
 * subscribed, look for a message that is ALREADY waiting (one sent between the previous turn's
 * consumption and now), so a message cannot be missed by arriving a moment early.
 */
export function inboxBargeIn(eventStore: EventStore): BargeInSource {
  return async (conversationId, ownerId, { onMessage, isKnown }) => {
    const unsubscribe = await eventStore.subscribe(inboxStreamId(conversationId), (ev) => {
      const p = ev.payload as { topic?: unknown; payload?: unknown } | null;
      if (p?.topic !== CONVERSATION_TOPIC) return;
      const id = idOf(p.payload);
      if (id !== undefined && isKnown(id)) return;
      onMessage();
    });
    try {
      if (await pendingInbox(eventStore, conversationId, ownerId, isKnown)) onMessage();
    } catch (err) {
      unsubscribe();
      throw err;
    }
    return unsubscribe;
  };
}
