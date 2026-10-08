import type { AgentStep } from "./types";

/** The channel an interrupted agent run fails on (ADR 0060). */
export const AGENT_INTERRUPTED = "agentInterrupted";

/**
 * What the turn had produced when the stop landed. The tool calls are the point:
 * they are the expensive, already-paid-for half of the work, and re-running the
 * agent from nothing repeats every one of them.
 */
export interface InterruptedAgentRun {
  /** Partial text from the interrupted generation. Empty unless the model was streamed. */
  content: string;
  /** Turns begun before the interruption. */
  iterations: number;
  /** Tool calls that completed, in the model's order. */
  toolCallLog: AgentStep[];
}
