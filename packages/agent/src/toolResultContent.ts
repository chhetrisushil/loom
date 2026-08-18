import { isTainted, taintOf, tainted, unwrapTainted } from "@loom/classify";
import type { LlmContent } from "@loom/llm";

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
