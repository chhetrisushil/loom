export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Cooperative cancellation — forwarded to the underlying HTTP request. */
  signal?: AbortSignal;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface LlmResponse {
  content: string;
  toolCalls?: LlmToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmStreamChunk {
  delta: string;
  done: boolean;
}

export interface LlmProvider {
  complete(request: LlmRequest): Promise<LlmResponse>;
  stream?(request: LlmRequest): AsyncIterable<LlmStreamChunk>;
}
