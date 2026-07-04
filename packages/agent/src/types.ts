export interface AgentInput {
  prompt: string;
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
