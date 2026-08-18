import { fail } from "@loom/core";
import type { LlmResponse, LlmStreamChunk } from "./types";

// ── The streamed-≡-completed contract ─────────────────────────────────────────
//
// Two paths to one outcome need a rule saying they agree, or they drift and the
// drift shows up as an agent that behaves differently once streaming is switched
// on. ADR 0059 D1 set the precedent for content: a streamed address MUST equal
// the whole-buffer address. This is the same discipline for the model call —
// assembling a stream MUST produce what `complete` would have returned.
//
// Assembly is deliberately dumb: concatenate the deltas, take the outcome fields
// from the terminal chunk. Anything cleverer would be a place for the two paths
// to disagree.

/** Thrown when a stream violates its shape contract (no terminal chunk, or more than one). */
export class MalformedStreamError extends Error {
  constructor(message: string) {
    super(`Malformed LLM stream: ${message}`);
    this.name = "MalformedStreamError";
  }
}

/**
 * Fold a completed stream into the `LlmResponse` it represents.
 *
 * `stopReason` defaults to `"end_turn"` when the provider does not report one —
 * the same value `complete` yields for an unrecognised stop reason, so a
 * text-only streaming provider assembles to the same shape it always would.
 * `toolCalls` and `usage` stay ABSENT rather than becoming empty: `undefined`
 * means "not reported", `[]` would mean "reported none", and metering must be
 * able to tell a provider that omits usage from one that charged nothing.
 */
export function assembleStream(chunks: readonly LlmStreamChunk[]): LlmResponse {
  const terminals = chunks.filter((c) => c.done);
  if (terminals.length === 0) {
    throw new MalformedStreamError("no terminal chunk (none had done: true)");
  }
  if (terminals.length > 1) {
    throw new MalformedStreamError(`${terminals.length} terminal chunks (exactly one is allowed)`);
  }
  const last = chunks[chunks.length - 1];
  if (last?.done !== true) {
    throw new MalformedStreamError("the terminal chunk is not last");
  }

  const content = chunks.map((c) => c.delta).join("");
  return {
    content,
    ...(last.toolCalls !== undefined && { toolCalls: last.toolCalls }),
    stopReason: last.stopReason ?? "end_turn",
    ...(last.usage !== undefined && { usage: last.usage }),
  };
}

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

/** What a stream has produced so far, offered to {@link CollectStreamOptions.guard}. */
export interface StreamProgress {
  /** Everything received so far, concatenated. */
  text: string;
  /** Number of deltas received. */
  deltas: number;
  /** Usage, if the provider has reported any yet. Most report only at the end. */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface CollectStreamOptions {
  /** When this is aborted, the partial is captured instead of being thrown away. */
  signal?: AbortSignal;
  /** Transient sink for deltas as they arrive. Never journaled by this function. */
  onDelta?: (delta: string) => void;
  /**
   * Called after every delta. THROW to sever the generation mid-flight — the
   * throw propagates, the `for await` exits, and the underlying HTTP call is
   * released.
   *
   * This is the seam K8.4 needs and the only one a stream can offer: providers
   * report usage once at the end, so the sole thing observable *while* a
   * generation runs is its own output. A guard that throws here is the
   * difference between paying for a runaway generation and stopping it.
   *
   * Deliberately generic — no budget vocabulary lives in this package.
   * `@loom/middleware`'s `streamTokenBudget` builds the budget-shaped one.
   */
  guard?: (progress: StreamProgress) => void;
}

/**
 * `assembleStream` over a live stream — drains it, feeds deltas out as they
 * arrive, and folds what arrived.
 *
 * With a `signal`, an abort mid-generation is NOT a lost generation: what was
 * produced is captured as an {@link LLM_INTERRUPTED} typed failure. Anything else
 * propagates untyped, so a transport failure stays one — K9 retries the turn
 * whole, and a network blip never reads as a user stop.
 *
 * Shared by `createLlmEffect` and `AgentRunner` deliberately: two copies of an
 * accumulate-and-capture loop is two chances to differ about what "interrupted"
 * means, and the whole point is that the partial survives identically either way.
 */
export async function collectStream(
  stream: AsyncIterable<LlmStreamChunk>,
  options: CollectStreamOptions = {}
): Promise<LlmResponse> {
  const chunks: LlmStreamChunk[] = [];
  // A guard breach is NOT an interruption, and the two are easy to confuse: a
  // guard that severs typically aborts the execution too, so by the time the
  // catch below runs, `signal.aborted` is true and the budget error would be
  // rewritten into "interrupted" — losing the reason the generation stopped.
  // The caller has to be able to tell "a human stopped this" from "this cost too
  // much", so the guard's own error is remembered and rethrown untouched.
  let guardError: unknown;
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
      if (chunk.delta !== "") options.onDelta?.(chunk.delta);
      if (options.guard !== undefined) {
        let usage: LlmStreamChunk["usage"];
        for (const c of chunks) if (c.usage !== undefined) usage = c.usage;
        try {
          options.guard({
            text: chunks.map((c) => c.delta).join(""),
            deltas: chunks.length,
            ...(usage !== undefined && { usage }),
          });
        } catch (err) {
          guardError = err;
          throw err;
        }
      }
    }
  } catch (err) {
    if (guardError !== undefined) throw guardError;
    if (options.signal?.aborted === true) {
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
