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

/** `assembleStream` over a live stream — drains it, then folds. */
export async function collectStream(stream: AsyncIterable<LlmStreamChunk>): Promise<LlmResponse> {
  const chunks: LlmStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return assembleStream(chunks);
}
