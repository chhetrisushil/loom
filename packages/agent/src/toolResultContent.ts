import { isTainted, taintOf, tainted, unwrapTainted } from "@loom/classify";
import type {
  LlmContent,
  LlmResultPart,
  LlmResultPartInput,
  LlmToolResultPartInput,
} from "@loom/llm";
import { MAX_INLINE_BYTES, validateMediaPart } from "@loom/llm";

// ── R5 — a tool's output as a `tool_result` part ─────────────────────────────

/**
 * What a tool returns when its answer includes media (an image it rendered, a PDF it
 * fetched). Build it with {@link mediaResult}; the loop feeds the parts to the model as
 * the `tool_result`'s content. Put large bytes in the ContentStore and return a
 * `{ kind: "ref" }` source: an inline `data` source rides in the tool's output, which is
 * journaled, and is capped (`MAX_INLINE_BYTES`) for exactly that reason.
 */
export interface ToolMediaResult {
  readonly __loomMediaResult: true;
  readonly parts: readonly LlmResultPart[];
}

export function mediaResult(parts: readonly LlmResultPart[]): ToolMediaResult {
  return { __loomMediaResult: true, parts };
}

export function isMediaResult(value: unknown): value is ToolMediaResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __loomMediaResult?: unknown }).__loomMediaResult === true &&
    Array.isArray((value as { parts?: unknown }).parts)
  );
}

/**
 * Render one tool result as the message content fed back to the model, KEEPING the
 * taint on the outside of the serialization.
 *
 * A plain `JSON.stringify` of a tainted result is worse than an unenforced marker —
 * it is an erased one. `{__loomTainted, value}` flattens into ordinary text, so
 * `isTainted` is false afterwards and no guard added later, including one at the
 * provider, can recover the provenance. Stringifying the UNWRAPPED value and
 * re-tainting the string keeps the fact alive to the prompt boundary, where
 * `guardRequest` fences it.
 */
export function toolResultContent(toolName: string, toolOutput: unknown): LlmContent {
  if (!isTainted(toolOutput)) {
    return JSON.stringify({ tool: toolName, result: toolOutput });
  }
  const origin = taintOf(toolOutput)?.origin ?? "unknown";
  const body = JSON.stringify({ tool: toolName, result: unwrapTainted(toolOutput) });
  return tainted(body, origin);
}

/**
 * The `tool_result` part answering `toolUseId` with `toolOutput`.
 *
 * Text results keep the `{ tool, result }` JSON envelope and the taint rules above, now as a
 * `tool_result` part instead of a free-standing user message. A {@link ToolMediaResult}
 * becomes content parts; when the output is tainted, every text part is tainted and every
 * media part is marked `untrusted`, so `guardRequest` fences/brackets all of it. A media
 * part that fails validation (bad type, bad base64, inline over the cap) is NOT fed to the
 * model or the log: it becomes an `isError` result saying why, so the model can recover.
 */
export function toolResultPart(
  toolUseId: string,
  toolName: string,
  toolOutput: unknown,
  options: { isError?: boolean; maxInlineBytes?: number } = {}
): LlmToolResultPartInput {
  const isError = options.isError === true;
  const origin = taintOf(toolOutput)?.origin;
  const inner = isTainted(toolOutput) ? unwrapTainted(toolOutput) : toolOutput;
  if (!isMediaResult(inner)) {
    return {
      type: "tool_result",
      toolUseId,
      content: toolResultContent(toolName, toolOutput),
      ...(isError && { isError }),
    };
  }
  const content: LlmResultPartInput[] = [];
  try {
    for (const p of inner.parts) {
      if (p.type === "text") {
        content.push({
          type: "text",
          text: origin === undefined ? p.text : tainted(p.text, origin),
        });
      } else {
        validateMediaPart(p, options.maxInlineBytes ?? MAX_INLINE_BYTES);
        content.push(origin === undefined ? p : { ...p, untrusted: { origin } });
      }
    }
  } catch (err) {
    const body = JSON.stringify({
      tool: toolName,
      error: { code: "invalid_media_result", message: String((err as Error).message) },
    });
    return {
      type: "tool_result",
      toolUseId,
      content: origin === undefined ? body : tainted(body, origin),
      isError: true,
    };
  }
  return { type: "tool_result", toolUseId, content, ...(isError && { isError }) };
}
