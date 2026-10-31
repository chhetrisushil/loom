/**
 * R17 (ADR 0122) — one earlier message of a conversation, placed before the prompt. `origin` marks
 * the content as third-party (a user's words): it enters the transcript TAINTED with that origin
 * (ADR 0085), so the prompt boundary fences it and refuses it in an instruction position.
 */
export interface AgentHistoryMessage {
  role: "user" | "assistant";
  content: string;
  /** Taint origin for untrusted content. A tainted `assistant` message is refused by the prompt guard. */
  origin?: string;
}

export interface AgentInput {
  prompt: string;
  /**
   * R17 (ADR 0122) — earlier messages of the dialogue, oldest first, placed before `prompt`. The
   * caller owns their size (`@loom/conversation` fits them to a token budget); they are part of the
   * recorded request of every turn, so a resume rebuilds the identical transcript.
   */
  history?: readonly AgentHistoryMessage[];
  /**
   * R17 (ADR 0122) — the `prompt` is third-party content (an end user's message): it enters the
   * transcript tainted with this origin, fenced at the prompt boundary. Not combined with `context`
   * (which is interpolated into the same string and would launder the taint).
   */
  promptOrigin?: string;
  context?: unknown;
  // Scopes memory recall/write (e.g. a conversationId or userId). Defaults to
  // the execution id when omitted.
  memoryScope?: string;
}

/**
 * One tool call in `AgentOutput.toolCallLog`. In the default `toolCallLog: "full"` mode `toolOutput`
 * is the whole result (as ever). In `"lean"` mode (ADR 0141) `toolOutput` is ABSENT and the
 * `status`/`bytes`/`digest`/`stepId` fields describe it instead; narrow with `isLeanAgentStep`.
 */
export interface AgentStep {
  iteration: number;
  toolName: string;
  toolInput: unknown;
  /** The tool's full result. Absent on a lean entry. */
  toolOutput?: unknown;
  /** Lean mode only: `"error"` when the result was fed back to the model as an error. */
  status?: "ok" | "error";
  /** Lean mode only: UTF-8 byte length of the canonical JSON of the full output (0 when it has none). */
  bytes?: number;
  /** Lean mode only: sha256 hex of the canonical JSON of the full output; `null` when it has none (ADR 0141 D2). */
  digest?: string | null;
  /** Lean mode only: the tool frame id `<loop>#turn:<i>:tool:<j>`; the full output is resolvable from it. */
  stepId?: string;
}

/** A `toolCallLog: "lean"` entry (ADR 0141). */
export interface LeanAgentStep {
  iteration: number;
  toolName: string;
  toolInput: unknown;
  status: "ok" | "error";
  bytes: number;
  digest: string | null;
  stepId: string;
}

/** Whether a log entry is the lean shape (its full output is not carried). */
export function isLeanAgentStep(s: AgentStep): s is AgentStep & LeanAgentStep {
  return s.stepId !== undefined && s.status !== undefined && !("toolOutput" in s);
}

export interface AgentOutput {
  content: string;
  toolCallLog: AgentStep[];
  iterations: number;
}
