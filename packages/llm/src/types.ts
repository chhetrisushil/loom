import type { TaintedValue } from "@loom/classify";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── The input side of the prompt boundary ────────────────────────────────────
//
// `buildRequest` may hand back content that is still tainted (`@loom/classify`);
// `guardRequest` refuses it outside a `user` message and fences it inside one,
// so what reaches an `LlmProvider` is always the plain-string `LlmRequest` above.
// Splitting the two types is what keeps every provider ignorant of taint — and
// `LlmRequest` is assignable to `LlmRequestInput`, so an application that never
// taints anything sees no change at all.

/** A content slot that may still carry provenance. */
export type LlmContent = string | TaintedValue<string>;

export interface LlmMessageInput {
  role: "system" | "user" | "assistant";
  content: LlmContent;
}

export interface LlmToolSpecInput {
  name: LlmContent;
  description: LlmContent;
  inputSchema: Record<string, unknown>;
}

export interface LlmRequestInput extends Omit<LlmRequest, "messages" | "tools" | "system"> {
  messages: LlmMessageInput[];
  tools?: LlmToolSpecInput[];
  system?: LlmContent;
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
  /**
   * Advisory pre-warm (latency-only): keep a connection / HTTP-2 session / model
   * cache hot so the next `complete` skips the cold handshake. Called via the
   * effect's `warm()` (which the kernel invokes ahead of use). MUST NOT change
   * outputs; a failure is a silent no-op → the next call runs cold.
   */
  warm?(): void | Promise<void>;
}
