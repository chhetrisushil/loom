import { isTainted } from "@loom/classify";

/** Bound on wrapper-in-wrapper and part nesting, matching loom's other content walkers. */
const MAX_DEPTH = 16;

/**
 * The text of one message handed to a summarizer effect: `budget.summarizerToolId` AND
 * `agent.compaction.toolId` (one effect may serve both).
 *
 * Either input may carry `tainted()` wrappers - at the top level (the user's words and the previous
 * summary), in a text part's `text`, and in a `tool_result`'s `content` (failed tool calls and MCP
 * results are always tainted) - so `textOf(m.content)` alone throws `TaintedContentError`. This walks
 * the known part kinds, unwraps every level (bounded depth) and joins the text. Media and `tool_use`
 * parts contribute nothing. It returns plain text and never throws on legitimate input.
 *
 * The result is UNTRUSTED DATA. Summarize it, quote it, count it - never place it in an instruction
 * position (system prompt, assistant role, tool description). If the summarizer calls an LLM with
 * this text, re-wrap it with `tainted(text, origin)` and put it in a user message, never the system
 * prompt: after unwrapping, `guardRequest` can no longer refuse it. The summary you return is itself
 * re-injected into later prompts as a fenced `user` message (`SUMMARY_ORIGIN`).
 */
export function summarizerText(content: unknown): string {
  return walk(content, 0);
}

function unwrap(v: unknown, depth: number): unknown {
  let cur = v;
  for (let i = depth; isTainted(cur) && i < MAX_DEPTH; i++) cur = cur.value;
  return cur;
}

function walk(v: unknown, depth: number): string {
  const x = unwrap(v, depth);
  if (typeof x === "string") return x;
  if (!Array.isArray(x) || depth >= MAX_DEPTH) return "";
  let out = "";
  for (const p of x as { type?: unknown; text?: unknown; content?: unknown }[]) {
    if (p === null || typeof p !== "object") continue;
    if (p.type === "text") out += walk(p.text, depth + 1);
    else if (p.type === "tool_result") out += walk(p.content, depth + 1);
  }
  return out;
}
