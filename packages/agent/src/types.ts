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
 * One tool call in `AgentOutput.toolCallLog` in the default `toolCallLog: "full"` mode: `toolOutput` is
 * the whole result, as ever. (This type is UNCHANGED by the lean log; a `"lean"` run's entries are
 * {@link LeanAgentStep}.)
 */
export interface AgentStep {
  iteration: number;
  toolName: string;
  toolInput: unknown;
  toolOutput: unknown;
}

/**
 * A `toolCallLog: "lean"` entry (ADR 0142): the full output is NOT carried, it is described.
 * `toolOutput` is declared as an always-absent optional so code that reads `entry.toolOutput` off
 * `AgentOutput.toolCallLog` (a union of the two array types) still compiles; it is `undefined`.
 *
 * - `status`: `"error"` when the result was fed back to the model as an error.
 * - `bytes` / `digest`: UTF-8 length and sha256 hex of `canonicalJson` of the output's JSON round trip
 *   (what the log records); `0` / `null` when the output has no JSON form. With the claim-check on, the
 *   digested output is the envelope (the envelope's own `digest` is the blob hash).
 * - `stepId`: the tool frame `<loop>#turn:<i>:tool:<j>` whose `STEP_COMPLETED` output is the digested
 *   value. For `status: "error"` the frame has NO output: the fed-back failure is recorded in the
 *   `<stepId>:outcome` decision's `failed` field. A call settled without running (a refusal, `search_tools`,
 *   a skill activation) has no frame at all.
 */
export interface LeanAgentStep {
  iteration: number;
  toolName: string;
  toolInput: unknown;
  toolOutput?: undefined;
  status: "ok" | "error";
  bytes: number;
  digest: string | null;
  stepId: string;
}

/** Whether a log entry is the lean shape (its full output is not carried). */
export function isLeanAgentStep(s: AgentStep | LeanAgentStep): s is LeanAgentStep {
  return "stepId" in s && "status" in s && !("toolOutput" in s);
}

export interface AgentOutput {
  content: string;
  /** Entries are {@link AgentStep} by default, {@link LeanAgentStep} under `toolCallLog: "lean"`. */
  toolCallLog: AgentStep[] | LeanAgentStep[];
  iterations: number;
}
