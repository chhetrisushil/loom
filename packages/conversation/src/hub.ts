import { AsyncLocalStorage } from "node:async_hooks";
import { type TaintedValue, unwrapTainted } from "@loom/classify";
import { fail } from "@loom/core";
import { LLM_INTERRUPTED } from "@loom/llm";
import type { LlmProvider, LlmRequest, LlmStreamChunk } from "@loom/llm";

// ── The live (transient) channel of a conversation (ADR 0122 D5) ───────────────────────────────
//
// A turn's tokens are NOT durable (ADR 0119: a delta is never journaled and is not called on replay),
// so they cannot be read back from the log; they are pushed to whoever is attached RIGHT NOW. This
// hub is that fan-out, in process, bounded and lossy by design: a subscriber that attaches late, or
// is too slow, misses deltas and recovers from the DURABLE record (the turn's `conversation.message`
// event carries the whole reply). It never carries anything the log does not eventually hold.

/** A live event for a conversation. Deltas and resets only: everything durable comes from the log. */
export type LiveEvent =
  | { type: "delta"; conversationId: string; turn: number; text: string; asker?: string }
  /**
   * ADR 0133 D6 - a readable reasoning increment of the turn's model call. A channel of its own, so no
   * consumer of reply text sees it by accident; a transport serves it to the turn's ASKER and the conversation's OWNER only (`asker`
   * is always set in shared mode) and only when the host opted in.
   */
  | { type: "reasoning"; conversationId: string; turn: number; text: string; asker?: string }
  /** The turn's stream restarted from zero (a crash-recovered re-run asked the model again): discard the partial. */
  | { type: "reset"; conversationId: string; turn: number; asker?: string };

/** What the model effect's `onDelta` needs to know about the call it is serving. */
interface TurnScope {
  conversationId: string;
  turn: number;
  /** Distinguishes one execution of the turn body from a re-run of it after a crash. */
  run: number;
  /** Fires when a newer user message barges in on this turn. */
  signal: AbortSignal;
  /** Called before a LIVE model request: starts whatever watches for a barge-in (a replayed turn never gets here). */
  ensure?: () => Promise<unknown>;
  /** Shared mode: the identity key of the asker. Live deltas are published for THIS viewer only. */
  asker?: string;
}

const scope = new AsyncLocalStorage<TurnScope>();
let runCounter = 0;

/** Run `fn` as the body of `turn` of `conversationId`: model deltas produced inside it are attributed to it. */
export function withTurnScope<T>(
  conversationId: string,
  turn: number,
  signal: AbortSignal,
  fn: () => T,
  ensure?: () => Promise<unknown>,
  asker?: string
): T {
  return scope.run(
    {
      conversationId,
      turn,
      run: ++runCounter,
      signal,
      ...(ensure !== undefined && { ensure }),
      ...(asker !== undefined && { asker }),
    },
    fn
  );
}

/** The request with the running turn's barge-in signal merged into its own, if there is a turn. */
function withTurnSignal(request: LlmRequest): LlmRequest {
  const turn = scope.getStore()?.signal;
  if (turn === undefined) return request;
  return {
    ...request,
    signal: request.signal === undefined ? turn : AbortSignal.any([request.signal, turn]),
  };
}

/** Maximum live subscribers per conversation. A further subscribe is refused (the caller answers 429). */
export const DEFAULT_MAX_SUBSCRIBERS = 64;

const MAX_TRACKED_TURNS = 1024;

export class SubscriberLimitError extends Error {
  readonly code = "SUBSCRIBER_LIMIT";
  constructor(conversationId: string, limit: number) {
    super(`conversation "${conversationId}" already has ${limit} live subscribers`);
    this.name = "SubscriberLimitError";
  }
}

export interface ConversationHubOptions {
  /** Live subscribers allowed per conversation. Default {@link DEFAULT_MAX_SUBSCRIBERS}. */
  maxSubscribersPerConversation?: number;
  /**
   * Characters of the in-progress reply kept per conversation so a subscriber that attaches (or
   * reconnects) mid-stream can be caught up with {@link ConversationHub.partialOf}. 0 disables it.
   * Default 65 536; beyond it the head of the partial is dropped (the catch-up is a convenience, the
   * durable reply is the record).
   */
  maxPartialChars?: number;
}

/** The reasoning a conversation's model call has streamed so far (ADR 0133 D6). Same bound and lifetime as {@link PartialReply}. */
export interface PartialReasoning {
  turn: number;
  text: string;
  /** Shared mode: whose turn it is. For that viewer alone, always. */
  asker?: string;
}

/** The reply a conversation is streaming right now. */
export interface PartialReply {
  turn: number;
  text: string;
  /** Shared mode: whose turn it is. The partial is for that viewer alone until the turn is classified. */
  asker?: string;
}

interface Partial {
  turn: number;
  run: number;
  text: string;
  /** In-progress reasoning (ADR 0133 D6): superseded with the reply when the turn's durable message lands, cleared by a re-run. */
  reasoning: string;
  asker?: string;
}

export class ConversationHub {
  private readonly subs = new Map<string, Set<(event: LiveEvent) => void>>();
  /** The reply each conversation is streaming: also what tells a RE-RUN of a turn (a different run) from its continuation. Bounded to live turns. */
  private readonly partials = new Map<string, Partial>();
  private readonly max: number;
  private readonly maxPartial: number;

  constructor(options: ConversationHubOptions = {}) {
    this.max = options.maxSubscribersPerConversation ?? DEFAULT_MAX_SUBSCRIBERS;
    this.maxPartial = options.maxPartialChars ?? 65_536;
  }

  /**
   * Attach a listener to ONE conversation. Events of other conversations are never delivered to it
   * (the map is keyed by id; there is no wildcard). A throwing listener is isolated.
   */
  subscribe(conversationId: string, listener: (event: LiveEvent) => void): () => void {
    let set = this.subs.get(conversationId);
    if (set === undefined) {
      set = new Set();
      this.subs.set(conversationId, set);
    }
    if (set.size >= this.max) throw new SubscriberLimitError(conversationId, this.max);
    set.add(listener);
    return () => {
      const cur = this.subs.get(conversationId);
      if (cur === undefined) return;
      cur.delete(listener);
      if (cur.size === 0) this.subs.delete(conversationId);
    };
  }

  subscriberCount(conversationId: string): number {
    return this.subs.get(conversationId)?.size ?? 0;
  }

  /** What the conversation has streamed of the reply in progress, if one is. Read it right after {@link subscribe}. */
  partialOf(conversationId: string): PartialReply | undefined {
    const p = this.partials.get(conversationId);
    return p === undefined || p.text === ""
      ? undefined
      : { turn: p.turn, text: p.text, ...(p.asker !== undefined && { asker: p.asker }) };
  }

  /** What the turn's model call has streamed of its reasoning, if any. Read it right after {@link subscribe}. */
  reasoningPartialOf(conversationId: string): PartialReasoning | undefined {
    const p = this.partials.get(conversationId);
    return p === undefined || p.reasoning === ""
      ? undefined
      : { turn: p.turn, text: p.reasoning, ...(p.asker !== undefined && { asker: p.asker }) };
  }

  publish(conversationId: string, event: LiveEvent): void {
    const set = this.subs.get(conversationId);
    if (set === undefined) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // a listener cannot hurt the turn
      }
    }
  }

  /** The turn's reply is durable: forget its stream bookkeeping. */
  endTurn(conversationId: string, turn: number): void {
    if (this.partials.get(conversationId)?.turn === turn) this.partials.delete(conversationId);
  }

  /**
   * Wrap a provider so a barge-in CUTS the generation. The turn's abort signal (set by
   * `conversation$` in the turn scope) is merged into every request's `signal`, so a streaming
   * provider stops at the next chunk and its partial text is captured (`LLM_INTERRUPTED`); a
   * request outside a turn scope is passed through untouched. Register the wrapped provider:
   * `createAgentModelEffect(hub.wrapProvider(provider), { stream: true, onDelta: hub.deltaSink() })`.
   * Without it a barge-in still lands, but only at the next checkpoint after the model call returns.
   */
  wrapProvider(provider: LlmProvider): LlmProvider {
    /** A barge-in landed on THIS request (as opposed to a caller's own abort or a transport failure). */
    const bargedIn = (request: LlmRequest): boolean =>
      scope.getStore()?.signal.aborted === true && request.signal?.aborted !== true;
    const wrapped: LlmProvider = {
      ...(provider.capabilities !== undefined && { capabilities: provider.capabilities }),
      complete: async (request) => {
        try {
          await scope.getStore()?.ensure?.();
          return await provider.complete(withTurnSignal(request));
        } catch (err) {
          if (bargedIn(request)) fail(LLM_INTERRUPTED, { content: "" }, "generation interrupted");
          throw err;
        }
      },
    };
    if (provider.stream !== undefined) {
      const stream = provider.stream.bind(provider);
      // The kernel's own capture of a partial (`collectStream`) watches the EFFECT's signal, which a
      // barge-in does not touch; so the wrapper accumulates what it forwards and raises the typed
      // interruption itself, whether the provider honoured the signal or kept on yielding.
      wrapped.stream = async function* (request): AsyncGenerator<LlmStreamChunk> {
        const turn = scope.getStore()?.signal;
        let text = "";
        try {
          await scope.getStore()?.ensure?.();
          for await (const chunk of stream(withTurnSignal(request))) {
            if (turn?.aborted === true && request.signal?.aborted !== true) {
              fail(LLM_INTERRUPTED, { content: text }, "generation interrupted");
            }
            text += chunk.delta;
            yield chunk;
          }
        } catch (err) {
          if (bargedIn(request)) fail(LLM_INTERRUPTED, { content: text }, "generation interrupted");
          throw err;
        }
      };
    }
    return wrapped;
  }

  /**
   * The `onDelta` to register on the model effect:
   * `createAgentModelEffect(provider, { stream: true, onDelta: hub.deltaSink() })`.
   *
   * It attributes each delta to the conversation turn whose body is running the call (an
   * AsyncLocalStorage scope set by `conversation$`), so ONE shared effect serves every
   * conversation without crossing their streams. A delta outside any turn scope (a call that did not
   * come from a conversation, or an effect running in another process) has no conversation and is
   * dropped, never broadcast. No subscriber means no work.
   */
  deltaSink(): (delta: string) => void {
    return (delta: string) => {
      const s = scope.getStore();
      if (s === undefined || delta === "") return;
      const part = this.partialFor(s);
      if (this.maxPartial > 0) {
        const text = part.text + delta;
        part.text =
          text.length > this.maxPartial ? text.slice(text.length - this.maxPartial) : text;
      }
      this.publish(s.conversationId, {
        type: "delta",
        conversationId: s.conversationId,
        turn: s.turn,
        text: delta,
        ...(s.asker !== undefined && { asker: s.asker }),
      });
    };
  }

  /**
   * ADR 0133 D6 - the live reasoning sink, for the model effect's reasoning option:
   * `createAgentModelEffect(provider, { reasoning: { store, live: true, onDelta: hub.reasoningSink() } })`.
   * Attributed to the turn exactly as {@link deltaSink} is, kept in a bounded in-progress buffer (the
   * same cap as the reply, head dropped) and published as `reasoning` events. This is the transport
   * edge: the increment arrives wrapped as untrusted content and is unwrapped HERE, into the buffer and
   * the event, which a transport must serve to the turn's asker and the conversation's owner alone.
   */
  reasoningSink(): (delta: TaintedValue<string>) => void {
    return (wrapped: TaintedValue<string>) => {
      const s = scope.getStore();
      const delta = unwrapTainted(wrapped);
      if (s === undefined || delta === "") return;
      const part = this.partialFor(s);
      if (this.maxPartial > 0) {
        const text = part.reasoning + delta;
        part.reasoning =
          text.length > this.maxPartial ? text.slice(text.length - this.maxPartial) : text;
      }
      this.publish(s.conversationId, {
        type: "reasoning",
        conversationId: s.conversationId,
        turn: s.turn,
        text: delta,
        ...(s.asker !== undefined && { asker: s.asker }),
      });
    };
  }

  /**
   * The in-progress entry of the running turn, created on its first delta. A different RUN of the same
   * turn (a crash-recovered process asked the model again) supersedes it - text AND reasoning - with ONE
   * `reset`, whichever channel notices first.
   */
  private partialFor(s: TurnScope): Partial {
    const cur = this.partials.get(s.conversationId);
    if (cur !== undefined && cur.turn === s.turn && cur.run === s.run) return cur;
    if (cur !== undefined && cur.turn === s.turn) {
      // The same turn, a different run: a crash-recovered process asked the model again.
      this.publish(s.conversationId, {
        type: "reset",
        conversationId: s.conversationId,
        turn: s.turn,
        ...(s.asker !== undefined && { asker: s.asker }),
      });
    }
    if (cur === undefined && this.partials.size >= MAX_TRACKED_TURNS) {
      // Bounded: a turn that finished in another process never calls `endTurn` here.
      const oldest = this.partials.keys().next().value;
      if (oldest !== undefined) this.partials.delete(oldest);
    }
    const part: Partial = {
      turn: s.turn,
      run: s.run,
      text: "",
      reasoning: "",
      ...(s.asker !== undefined && { asker: s.asker }),
    };
    this.partials.set(s.conversationId, part);
    return part;
  }
}
