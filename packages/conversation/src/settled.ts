import type { EventEnvelope } from "@loomwork/core";
import type { Identity } from "./access";
import { conversationIdOf } from "./ids";
import { recordOf } from "./reader";

// ── Turn settled: start work once a reply is in the log ───────────────────────────────────────
//
// A host often has work to do after a turn: a title, an index entry, a notification, something
// composed from the finished answer. The hub cannot say "a turn of SOME conversation settled"
// (it is per conversation, and lossy), and the flow body cannot say "and it is durable" (a record
// is folded before its write lands). The runtime's `onDurableEvent` (ADR 0147) can: it fires once a
// write has resolved, never for an event replay or recovery serves from the log. This turns that
// stream into one callback per settled turn.

/** A turn of a conversation whose closing record is in the log. Ids and status only, never text. */
export interface TurnSettledEvent {
  conversationId: string;
  /** The generation that wrote the record (`<conversationId>` or `<conversationId>~<n>`). */
  executionId: string;
  /** The turn number. A rejected message belongs to no turn and carries `0`. */
  turn: number;
  /** The closing record's `ord`: unique within the conversation, so a good idempotency key. */
  ord: number;
  /**
   * `complete`, `interrupted` (a barge-in) or `failed` close an answered turn (the assistant record);
   * `rejected` is a user message refused before any model call (the user record).
   */
  status: "complete" | "interrupted" | "failed" | "rejected";
  /** Shared mode only: who asked. */
  asker?: Identity;
}

export type TurnSettledListener = (event: TurnSettledEvent) => void | Promise<void>;

const SETTLED = new Set<string>(["complete", "interrupted", "failed"]);

/**
 * An `onDurableEvent` observer that calls `listener` once for each turn of `flow` whose closing
 * record has been written: the assistant reply (`complete` / `interrupted` / `failed`), or a user
 * message recorded as `rejected`. A read made from the listener sees the record.
 *
 * ```ts
 * new WorkflowRuntime({ ..., onDurableEvent: turnSettledObserver(flow, (e) => queue.push(e)) });
 * // or: defineConfig({ observability: { onDurableEvent: turnSettledObserver(flow, listener) } })
 * ```
 *
 * The guarantees are `onDurableEvent`'s:
 * - **After the write, at most once.** Replay and recovery serve the record from the log and append
 *   nothing, so they do not call it again. A process that dies after the write but before the call
 *   never makes it: if the work must happen, keep a recovery path (read `history` from your last
 *   handled `ord`). A fork of a conversation execution copies its prefix through the runtime, and those
 *   copies can be reported again under the fork's id: key idempotent work by `conversationId` + `ord`.
 * - **Isolated.** A throw or a rejected promise is reported through the runtime's `onWarn` and never
 *   reaches the turn. An async listener is not awaited. Its SYNCHRONOUS part runs on the write chain,
 *   though, and delays the next write: start the work and return, do not do it inline.
 * - **Only this runtime's writes.** A turn answered by another process is reported there.
 *
 * One runtime has one `onDurableEvent`: to observe several things, call each observer from one function.
 */
export function turnSettledObserver(
  flow: { readonly definition: { readonly id: string } },
  listener: TurnSettledListener
): (event: EventEnvelope) => void | Promise<void> {
  const flowId = flow.definition.id;
  return (event) => {
    if (event.workflowId !== flowId) return;
    const rec = recordOf(event);
    if (rec === undefined || rec.ord === undefined) return;
    const settled = rec.role === "assistant" ? SETTLED.has(rec.status) : rec.status === "rejected";
    if (!settled) return;
    return listener({
      conversationId: conversationIdOf(event.executionId),
      executionId: event.executionId,
      turn: rec.turn,
      ord: rec.ord,
      status: rec.status as TurnSettledEvent["status"],
      ...(rec.asker !== undefined && { asker: rec.asker }),
    });
  };
}
