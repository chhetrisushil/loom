import { fail } from "@loom/core";
import { LlmEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { assembleStream } from "./assembleStream";
import type {
  LlmProvider,
  LlmRequest,
  LlmRequestInput,
  LlmResponse,
  LlmStreamChunk,
} from "./types";
import { guardRequest } from "./untrusted";

/**
 * The channel an interrupted generation fails on (ADR 0060). Its payload is
 * {@link InterruptedGeneration} — the text produced before the abort, which is
 * usually the most expensive artifact the turn made and was previously discarded:
 * `complete` + abort throws with the response body unread, so there is nothing to
 * keep. Only a call that has been accumulating deltas has a partial to hand back.
 *
 * Declare it in the owning contract's `errors:` map to get the ADR 0060 treatment
 * (recorded as `STEP_FAILED { channel, payload }`, substituted on replay);
 * undeclared, it degrades to an ordinary failure exactly as before.
 */
export const LLM_INTERRUPTED = "llmInterrupted";

export interface InterruptedGeneration {
  /** Deltas received before the abort, concatenated. May be empty. */
  content: string;
  /** Usage, if the provider reported any before the interruption. */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface CreateLlmEffectOptions<TIn, TOut> {
  provider: LlmProvider;
  buildRequest: (input: TIn, ctx: EffectContext) => LlmRequestInput;
  parseResponse?: (response: LlmResponse, input: TIn) => TOut;
  /**
   * Consume the provider's `stream` instead of `complete` (R9). OPT-IN: the two
   * paths return the same outcome by the R8 parity contract, but they are
   * different wire calls, and an effect that silently changed which one it makes
   * would be a surprise for anyone already running this.
   *
   * Falls back to `complete` when the provider implements no `stream`, so a
   * provider swap cannot turn this into a runtime failure.
   *
   * What streaming buys, given the outcome is identical: deltas reach
   * {@link onDelta} as they arrive, and an interrupted generation keeps its
   * partial text ({@link LLM_INTERRUPTED}).
   */
  stream?: boolean;
  /**
   * Where deltas go. TRANSIENT by construction — this effect never journals them,
   * and must not: chunks-as-events is the fold-economics problem ST-R rejected,
   * and `ctx.stream` is durable PER DELTA (one permanent event each), so routing
   * a token stream through it is a choice an author makes deliberately, at a
   * granularity they pick.
   *
   * The natural sinks are `@loom/live-query` `subscribe` and `progressHub`.
   *
   * Not called on replay: a completed effect is served from the log and never
   * re-invoked, so a tail attached to a replay sees silence. That is true of every
   * effect, but streaming is where authors expect otherwise.
   */
  onDelta?: (delta: string, ctx: EffectContext) => void;
}

/** Drain a stream, feeding deltas out as they arrive, and fold what arrived. */
async function runStream<TIn>(
  stream: AsyncIterable<LlmStreamChunk>,
  ctx: EffectContext,
  onDelta: CreateLlmEffectOptions<TIn, unknown>["onDelta"]
): Promise<LlmResponse> {
  const chunks: LlmStreamChunk[] = [];
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
      if (chunk.delta !== "") onDelta?.(chunk.delta, ctx);
    }
  } catch (err) {
    // An abort is not a lost generation — it is a generation that got this far.
    // Anything else is a genuine transport failure and stays one: it propagates
    // untyped, so K9's in-doubt handling treats it as it always has (the durable
    // unit is the turn; a dead stream is retried whole, never resumed mid-way).
    if (ctx.signal?.aborted === true) {
      // Usage from the last chunk that reported any — providers send it late, so
      // an early abort simply has none, which is different from "zero".
      let usage: LlmStreamChunk["usage"];
      for (const c of chunks) if (c.usage !== undefined) usage = c.usage;
      const partial: InterruptedGeneration = {
        content: chunks.map((c) => c.delta).join(""),
        ...(usage !== undefined && { usage }),
      };
      fail(LLM_INTERRUPTED, partial, "generation interrupted");
    }
    throw err;
  }
  return assembleStream(chunks);
}

export function createLlmEffect<TIn = string, TOut = string>(
  options: CreateLlmEffectOptions<TIn, TOut>
): LlmEffect<TIn, TOut> {
  const parse = options.parseResponse ?? ((r: LlmResponse) => r.content as unknown as TOut);
  return new LlmEffect<TIn, TOut>(
    async (input: TIn, ctx: EffectContext) => {
      // The integrity check at the prompt boundary: tainted content is refused
      // outside a `user` message and fenced inside one, and what comes back is
      // plain strings — so no provider has to know taint exists.
      const request = guardRequest(options.buildRequest(input, ctx));
      // K8.1 — forward the effect's cooperative-cancellation signal to the
      // provider (unless buildRequest already set one), so a cancelled/timed-out
      // execution severs the in-flight HTTP call instead of orphaning it.
      if (request.signal === undefined && ctx.signal !== undefined) {
        request.signal = ctx.signal;
      }

      // ONE durable outcome either way. The streamed path returns the assembled
      // response, which the R8 conformance contract pins equal to what `complete`
      // would have returned — so the journal shape does not depend on which path
      // ran, and switching `stream` on cannot change what replay serves.
      const response = await (options.stream === true && options.provider.stream !== undefined
        ? runStream<TIn>(
            options.provider.stream(request as LlmRequest),
            ctx,
            options.onDelta as CreateLlmEffectOptions<TIn, unknown>["onDelta"]
          )
        : options.provider.complete(request));

      return parse(response, input);
    },
    // Wire pre-warm to the provider's own warm hook (connection/model cache),
    // only when the provider implements one.
    options.provider.warm !== undefined ? { warm: () => options.provider.warm?.() } : {}
  );
}
