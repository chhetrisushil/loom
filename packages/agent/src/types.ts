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

export interface AgentStep {
  iteration: number;
  toolName: string;
  toolInput: unknown;
  toolOutput: unknown;
}

export interface AgentOutput {
  content: string;
  toolCallLog: AgentStep[];
  iterations: number;
}
