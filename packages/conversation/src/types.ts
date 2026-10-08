import type { AgentLoopConfig } from "@loom/agent";
import type { BargeInSource } from "./bargeIn";
import type { TokenCounter } from "./budget";
import type { ConversationHub } from "./hub";

/** The inbox topic a conversation reads its turns from. */
export const CONVERSATION_TOPIC = "conversation:turn";
/**
 * How a message (user turn, reply, partial, rejection) and the close are recorded: a DECISION with this
 * `source`, one per fact, under a deterministic id (`conv#o<n>:user`, `conv#o<n>:reply`, `conv#closed`).
 * Not `ctx.emit`: an emit is served on a re-run only when the log PROVES the replay (ADR 0102 D2), and
 * an interrupted turn leaves an unsettled step behind that defeats the proof, so every re-run would
 * append the transcript again. A decision is served by its id, always: exactly once.
 */
export const RECORD_SOURCE = "conversation-record";
/** The taint origin of an end user's words (ADR 0085). */
export const USER_ORIGIN = "conversation:user";
/** The taint origin of the rolling summary of evicted turns (it is model output over untrusted text). */
export const SUMMARY_ORIGIN = "conversation:summary";

/** What travels on the inbox topic. */
export type TurnEnvelope =
  /** `id` is the client idempotency key (the `messageId` it was sent under); it lets the barge-in watcher tell a retry from a new message. */
  { kind: "user"; text: string; id?: string } | { kind: "close"; id?: string };

export type MessageStatus = "complete" | "interrupted" | "failed" | "rejected";

/** The payload of a {@link MESSAGE_EVENT}: the unit `history` returns. */
export interface MessageRecord {
  kind?: "message";
  /** The turn number, 1-based, global across the chain's generations. */
  turn: number;
  role: "user" | "assistant";
  /** The message. Untrusted when `role === "user"`: render it as TEXT, never as markup. */
  text: string;
  /**
   * user: `complete` (accepted) or `rejected` (malformed / too long / over budget, with `reason`);
   * assistant: `complete`, `interrupted` (a barge-in: `text` is the partial, possibly empty) or `failed`.
   */
  status: MessageStatus;
  reason?: string;
}

/** A message plus where it sits in the log: the cursor a client resumes from. */
export interface HistoryEntry extends MessageRecord {
  /** `<generation>.<sequence>` of the event; pass it back as `cursor` / `Last-Event-ID`. */
  cursor: string;
  /** The execution (generation) that holds the event. */
  executionId: string;
  /** Journal time of the event, epoch ms. */
  at?: number;
}

export interface BudgetConfig {
  /** The model's context window, in tokens. */
  contextWindow: number;
  /** Tokens held back for the reply. Default `min(4096, window / 4)`. */
  reserveOutputTokens?: number;
  /** Default {@link heuristicTokenCounter}. A provider's exact counter may be supplied. */
  counter?: TokenCounter;
  /**
   * An effect id (the same contract as `agentLoop$` `compaction.toolId`: `{ messages } -> { summary }`)
   * that folds evicted turns into the rolling summary. Without it, evicted turns are simply dropped
   * from the PROMPT (they stay in `history`).
   */
  summarizerToolId?: string;
}

export interface ConversationConfig {
  /**
   * The agent that answers each turn: any `agentLoop$` config. `signal`, `loopId` and
   * `requireApproval` are owned by the conversation (a parked approval cannot coexist with the
   * barge-in watcher, ADR 0122 D2) and refused here.
   */
  agent: Omit<AgentLoopConfig, "signal" | "loopId" | "requireApproval">;
  budget?: BudgetConfig;
  /** Turns per generation before the conversation continues as new. Default 100. */
  rotateEveryTurns?: number;
  /** Characters of one user turn accepted; a longer one is rejected. Default 32 000. */
  maxTurnChars?: number;
  /** Characters of one reply kept in history and the carry (the log keeps what the model said up to this). Default 64 000. */
  maxReplyChars?: number;
  /** Turns the prompt window holds at most (older ones are evicted, summarized when configured). Default 64. */
  maxWindowTurns?: number;
  /** The carried window is trimmed to this many serialized bytes at a rotation. Default 256 KiB. */
  maxCarryBytes?: number;
  /**
   * What fires the running turn's abort signal when a message lands (see {@link inboxBargeIn}).
   * Without it the conversation QUEUES: a message sent mid-turn waits for the turn to finish.
   */
  bargeIn?: BargeInSource;
  /** Where live model deltas go (see {@link ConversationHub.deltaSink}); only its turn bookkeeping is touched here. */
  hub?: ConversationHub;
}

/** One turn as the flow holds it between prompts. */
export interface CarriedTurn {
  n: number;
  user: string;
  assistant?: string;
  status: MessageStatus;
  /** Cached token cost of the turn's messages. */
  tokens?: number;
}

/** The conversation's working state: the input of every generation. */
export interface ConversationCarry {
  v: 1;
  /** Turns taken so far (the next turn is `seq + 1`). */
  seq: number;
  /** Messages consumed so far, accepted or not: the id space of the recorded facts. */
  ord: number;
  /** Client idempotency keys of the most recent turns (bounded): what the barge-in watcher recognises as a retry. */
  ids?: string[];
  summary?: string;
  turns: CarriedTurn[];
  /** A message already consumed from the inbox but not yet handled (the rotation point sits between the two). */
  pending?: unknown;
}

export interface ConversationResult {
  conversationId: string;
  turns: number;
  closed: boolean;
}
