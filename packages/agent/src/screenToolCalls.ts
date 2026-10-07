import type { LlmToolCall } from "@loom/llm";
import { TOOL_INPUT_NODE_CAP, exceedsNodeCap } from "@loom/llm";

/**
 * The refusal fed back for a model-emitted tool call whose input is too large to hold.
 * Static text: nothing the model sent is echoed.
 */
export const OVERSIZED_INPUT_REFUSAL = {
  error: {
    code: "invalid_tool_input",
    message: `The tool input has more than ${TOOL_INPUT_NODE_CAP} nodes; it was not run.`,
  },
} as const;

/**
 * Bound the calls of one model response before they enter the transcript.
 *
 * A tool call's input is MODEL output. One past the guard's walk cap cannot be checked for untrusted
 * content, so `guardRequest` refuses it, and it would refuse EVERY later request carrying the
 * assistant message that holds it: one hostile (or runaway) generation would brick the run for good.
 * So an over-cap call is replaced, for the transcript, the approval digest and the tool-call log, by
 * a small placeholder; the call is refused (never run) and answered with an `isError` result the
 * model can recover from. Pure function of the recorded response, so replay reproduces it.
 */
export function screenToolCalls(calls: readonly LlmToolCall[]): {
  calls: LlmToolCall[];
  oversized: Set<number>;
} {
  const oversized = new Set<number>();
  const bounded = calls.map((c, i) => {
    if (!exceedsNodeCap(c.input)) return c;
    oversized.add(i);
    return { ...c, input: { __oversizedInput: true, nodeCap: TOOL_INPUT_NODE_CAP } };
  });
  return { calls: bounded, oversized };
}
