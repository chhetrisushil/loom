import { randomUUID } from "node:crypto";
import type { PrincipalChain } from "@loom/effect-runtime";
import type { EventStore } from "@loom/event-runtime";
import type { RegisteredFlow, SendResult, WorkflowRuntime } from "@loom/workflow-runtime";
import { generationOf, isValidConversationId } from "./ids";
import {
  type ConversationReader,
  type ReadOptions,
  type ReadResult,
  createConversationReader,
} from "./reader";
import { CONVERSATION_TOPIC, type TurnEnvelope } from "./types";

// ── The client API of a conversation (ADR 0122 D1) ────────────────────────────────────────────
//
// Thin on purpose: every operation is an existing, authorized runtime call. `start` is a start of
// the conversation flow under the caller's principal (so the conversation OWNS that authority: its
// tool calls run as the owner, ADR 0111); `sendTurn`/`close` are `runtime.send`, judged as the
// `send` op against the chain head's owner; `history`/`status` are a `query` on the conversation.
// A caller the runtime's execution authorizer refuses gets the runtime's own refusal, unchanged.

export class ConversationNotFoundError extends Error {
  readonly code = "CONVERSATION_NOT_FOUND";
  constructor(readonly conversationId: string) {
    super(`conversation "${conversationId}" not found`);
    this.name = "ConversationNotFoundError";
  }
}

export class InvalidTurnError extends Error {
  readonly code = "INVALID_TURN";
  constructor(detail: string) {
    super(`invalid turn: ${detail}`);
    this.name = "InvalidTurnError";
  }
}

export interface ConversationsDeps {
  runtime: WorkflowRuntime;
  /** The store the runtime appends to (history is read from it with bounded range reads). */
  eventStore: EventStore;
  /** The registered `conversation$` flow (registered here if the runtime does not know it yet). */
  flow: RegisteredFlow<never, unknown> | RegisteredFlow<unknown, unknown>;
  /** Characters a sent turn may have (the flow enforces its own `maxTurnChars` too). Default 32 000. */
  maxTurnChars?: number;
}

export interface CallOptions {
  /** The authenticated caller. Required when the runtime fails closed (`security.strict`). */
  principal?: PrincipalChain;
}

export interface SendTurnOptions extends CallOptions {
  /**
   * The idempotency key. A retry with the SAME id is consumed once (at-least-once send, exactly-once
   * consume, within the kernel's dedupe window); minted when omitted.
   */
  messageId?: string;
}

export type ConversationState = "open" | "closed" | "failed" | "cancelled";

export interface ConversationStatus {
  conversationId: string;
  /** The generation that currently holds the conversation (it advances at each rotation). */
  executionId: string;
  generation: number;
  state: ConversationState;
  /** A turn is being answered right now (the last recorded message is an unanswered user turn). */
  running: boolean;
  /** Turns accepted so far (the highest turn number in the transcript), 0 if none. */
  turns: number;
}

export interface Conversations {
  start(options?: CallOptions & { conversationId?: string }): Promise<{ conversationId: string }>;
  sendTurn(conversationId: string, text: string, options?: SendTurnOptions): Promise<SendResult>;
  close(conversationId: string, options?: SendTurnOptions): Promise<SendResult>;
  history(conversationId: string, options?: ReadOptions & CallOptions): Promise<ReadResult>;
  status(conversationId: string, options?: CallOptions): Promise<ConversationStatus>;
  /**
   * Prove the caller may read the conversation and return its head generation, WITHOUT reading any
   * history: the gate a streaming transport runs once per connection. Throws the runtime's denial,
   * or {@link ConversationNotFoundError}.
   */
  authorizeRead(conversationId: string, options?: CallOptions): Promise<{ generation: number }>;
  readonly reader: ConversationReader;
}

export function createConversations(deps: ConversationsDeps): Conversations {
  const { runtime, eventStore } = deps;
  const maxTurnChars = deps.maxTurnChars ?? 32_000;
  const reader = createConversationReader(eventStore);
  let registered = false;
  const ensureRegistered = (): void => {
    if (registered) return;
    // Idempotent for the same id + version + content (the kernel's own rule).
    runtime.registerFlow(deps.flow.definition as never, deps.flow.runner as never);
    registered = true;
  };

  const principalOpt = (o?: CallOptions) =>
    o?.principal !== undefined ? { principal: o.principal } : {};

  async function head(conversationId: string, o?: CallOptions) {
    if (!isValidConversationId(conversationId)) throw new ConversationNotFoundError(conversationId);
    // Authorizes `query` against the conversation (and then its head), hides "not found".
    const h = await runtime.followToHead(conversationId, principalOpt(o));
    if (h === null) throw new ConversationNotFoundError(conversationId);
    return h;
  }

  async function sendEnvelope(
    conversationId: string,
    payload: TurnEnvelope,
    o?: SendTurnOptions
  ): Promise<SendResult> {
    if (!isValidConversationId(conversationId)) throw new ConversationNotFoundError(conversationId);
    const messageId = o?.messageId ?? randomUUID();
    try {
      return await runtime.send(
        conversationId,
        { topic: CONVERSATION_TOPIC, payload: { ...payload, id: messageId }, messageId },
        principalOpt(o)
      );
    } catch (err) {
      // The runtime throws a plain Error for an unknown id (after the authorization-hiding step).
      if (err instanceof Error && err.message.startsWith("No execution found for id")) {
        throw new ConversationNotFoundError(conversationId);
      }
      throw err;
    }
  }

  return {
    reader,
    async start(options = {}) {
      ensureRegistered();
      const conversationId = options.conversationId ?? `conv-${randomUUID()}`;
      if (!isValidConversationId(conversationId)) {
        throw new InvalidTurnError(`conversation id "${conversationId}" is not valid`);
      }
      // Start-once for a caller-chosen id (ADR 0103): a duplicate start rejects, nothing re-runs.
      await runtime.start(deps.flow as never, {} as never, {
        executionId: conversationId,
        ...principalOpt(options),
      });
      return { conversationId };
    },
    async sendTurn(conversationId, text, options) {
      if (typeof text !== "string" || text.trim() === "") throw new InvalidTurnError("empty text");
      if (text.length > maxTurnChars) throw new InvalidTurnError(`over ${maxTurnChars} characters`);
      return sendEnvelope(conversationId, { kind: "user", text }, options);
    },
    close(conversationId, options) {
      return sendEnvelope(conversationId, { kind: "close" }, options);
    },
    async authorizeRead(conversationId, options) {
      const h = await head(conversationId, options);
      return { generation: generationOf(h.executionId) };
    },
    async history(conversationId, options = {}) {
      await head(conversationId, options); // the authorization gate: throws the runtime's refusal
      return reader.read(conversationId, options);
    },
    async status(conversationId, options) {
      const h = await head(conversationId, options);
      const generation = generationOf(h.executionId);
      const last = await reader.read(conversationId, { direction: "backward", limit: 1 });
      const newest = last.entries[0];
      const st = h.state.status;
      const state: ConversationState =
        st === "completed"
          ? "closed"
          : st === "failed"
            ? "failed"
            : st === "cancelled"
              ? "cancelled"
              : "open";
      return {
        conversationId,
        executionId: h.executionId,
        generation,
        state,
        running: state === "open" && newest?.role === "user" && newest.status === "complete",
        turns: newest?.turn ?? 0,
      };
    },
  };
}
