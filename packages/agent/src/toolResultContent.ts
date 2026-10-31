import { isTainted, nestedTaintOrigin, taintOf, tainted, unwrapTainted } from "@loom/classify";
import type {
  LlmContent,
  LlmResultPart,
  LlmResultPartInput,
  LlmToolResultPartInput,
} from "@loom/llm";
import {
  MAX_INLINE_BYTES,
  MAX_INLINE_TOTAL_BYTES,
  base64ByteLength,
  validateMediaPart,
} from "@loom/llm";

// ── R5 — a tool's output as a `tool_result` part ─────────────────────────────

/**
 * What a tool returns when its answer includes media (an image it rendered, a PDF it
 * fetched). Build it with {@link mediaResult}; the loop feeds the parts to the model as
 * the `tool_result`'s content. Put large bytes in the ContentStore and return a
 * `{ kind: "ref" }` source: an inline `data` source rides in the tool's output, which is
 * journaled, and is capped (`MAX_INLINE_BYTES`) for exactly that reason.
 *
 * Honoured only for a tool whose definition declares `returnsMedia: true`, and never for a tainted
 * output (see {@link toolResultPart}).
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
    // A wrapper buried INSIDE the result (an A2A reply taints `content` and leaves `raw` for control
    // flow) would flatten into plain text here. Fence the WHOLE tool_result and leave the structure
    // (and the inner markers, which show which parts are untrusted) visible inside the fence. The
    // stored value is untouched. A result too big/deep to scan is fenced too: fail closed (#735).
    const nested = nestedTaintOrigin(toolOutput);
    const text = JSON.stringify({ tool: toolName, result: toolOutput });
    return nested === undefined ? text : tainted(text, nested);
  }
  const origin = taintOf(toolOutput)?.origin ?? "unknown";
  const body = JSON.stringify({ tool: toolName, result: unwrapTainted(toolOutput) });
  return tainted(body, origin);
}

/** Decoded inline-media bytes in a `tool_result` part (refs cost nothing here). */
export function inlineBytesIn(part: LlmToolResultPartInput): number {
  if (!Array.isArray(part.content)) return 0;
  let n = 0;
  for (const r of part.content) {
    if (r.type !== "text" && r.source.kind === "data") n += base64ByteLength(r.source.data) ?? 0;
  }
  return n;
}

/**
 * The `tool_result` part answering `toolUseId` with `toolOutput`.
 *
 * Text results keep the `{ tool, result }` JSON envelope and the taint rules above, now as a
 * `tool_result` part instead of a free-standing user message.
 *
 * A {@link ToolMediaResult} becomes content parts ONLY when `allowMedia` is set (the loop passes the
 * tool definition's `returnsMedia`) AND the output is not tainted. The marker is a shape any JSON
 * can have, so honouring it unconditionally let a web page / MCP server / peer agent return
 * `{ __loomMediaResult, parts: [{ source: { kind: "ref", ref: { address } } }] }` and choose which
 * stored blob was fetched into the prompt (the ContentStore has no tenancy). Otherwise it is just data
 * and goes through the text path, tainted or not.
 *
 * A media part that fails validation (bad type, bad base64, inline over `maxInlineBytes` or over the
 * `inlineBudget` left in the transcript, an `untrusted` part naming a ref) is NOT fed to the model or
 * the log: it becomes an `isError` result saying why, so the model can recover.
 */
export function toolResultPart(
  toolUseId: string,
  toolName: string,
  toolOutput: unknown,
  options: {
    isError?: boolean;
    maxInlineBytes?: number;
    /** Inline media bytes the transcript can still take (default `MAX_INLINE_TOTAL_BYTES`). */
    inlineBudget?: number;
    allowMedia?: boolean;
  } = {}
): LlmToolResultPartInput {
  const isError = options.isError === true;
  if (options.allowMedia !== true || isTainted(toolOutput) || !isMediaResult(toolOutput)) {
    return {
      type: "tool_result",
      toolUseId,
      content: toolResultContent(toolName, toolOutput),
      ...(isError && { isError }),
    };
  }
  const content: LlmResultPartInput[] = [];
  let inline = 0;
  const budget = options.inlineBudget ?? MAX_INLINE_TOTAL_BYTES;
  try {
    for (const p of toolOutput.parts) {
      if (p.type === "text") {
        content.push({ type: "text", text: p.text });
        continue;
      }
      validateMediaPart(p, options.maxInlineBytes ?? MAX_INLINE_BYTES);
      if (p.untrusted !== undefined && p.source.kind === "ref") {
        throw new Error("an untrusted media part cannot name a stored ref");
      }
      if (p.source.kind === "data") {
        inline += base64ByteLength(p.source.data) ?? 0;
        if (inline > budget) {
          throw new Error(
            `inline media would exceed the ${budget} bytes the transcript can still hold; store it and return a ref`
          );
        }
      }
      content.push(p);
    }
  } catch (err) {
    return {
      type: "tool_result",
      toolUseId,
      content: JSON.stringify({
        tool: toolName,
        error: { code: "invalid_media_result", message: String((err as Error).message) },
      }),
      isError: true,
    };
  }
  return { type: "tool_result", toolUseId, content, ...(isError && { isError }) };
}
