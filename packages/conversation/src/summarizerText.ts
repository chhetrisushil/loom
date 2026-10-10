import { unwrapTainted } from "@loom/classify";
import { type LlmMessageContent, textOf } from "@loom/llm";

/**
 * The text of one message handed to a conversation summarizer effect (`budget.summarizerToolId`).
 *
 * The summarizer receives `{ messages: { role, content }[] }` where the user's words (and the
 * previous summary) are `tainted()` wrappers, so `textOf(m.content)` alone throws
 * `TaintedContentError`. This unwraps the taint and applies `textOf`; strings and parts pass through.
 *
 * The result is UNTRUSTED DATA. Summarize it, quote it, count it - never place it in an instruction
 * position (system prompt, assistant role, tool description). If you hand it to a model, wrap it
 * again with `tainted(text, origin)` so it rides fenced in a `user` message. The summary you return
 * is itself re-injected into later prompts as a fenced `user` message (`SUMMARY_ORIGIN`), never the
 * system prompt.
 */
export function summarizerText(content: unknown): string {
  return textOf(unwrapTainted(content) as LlmMessageContent);
}
