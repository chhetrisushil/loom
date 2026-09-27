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

/**
 * One increment of a streamed completion.
 *
 * The outcome fields ride the TERMINAL chunk (`done: true`). Without them a stream
 * can carry prose to a human and nothing else — a ReAct loop branches on
 * `toolCalls` and `stopReason`, and metering needs `usage` — which is why the
 * streaming path could not back an agent turn while it yielded `{ delta, done }`
 * alone.
 *
 * All three are OPTIONAL: a provider that streams text only leaves them undefined
 * and is unchanged (G2). What is NOT optional is honesty — when a field IS
 * reported it must equal what `complete` would have returned for the same request.
 * `runLlmProviderConformance` pins exactly that (see {@link assembleStream}).
 *
 * **`toolCalls` is optional in the type, but not silently so at the point of use.**
 * A provider that supports `stream` and is proven against `runLlmProviderConformance`
 * with a `toolRequest` (a request it is known to answer with a tool call) MUST report
 * `toolCalls` on the terminal chunk, matching `complete`'s — an omission there fails
 * the kit rather than passing as "not reported". Only a provider that opts out with
 * `{ toolRequest: null }` (because it genuinely never calls tools) is exempt.
 */
export interface LlmStreamChunk {
  delta: string;
  done: boolean;
  /** Tool calls the model made, assembled from the stream. Terminal chunk only. */
  toolCalls?: LlmToolCall[];
  /** Why generation stopped. Terminal chunk only. */
  stopReason?: LlmResponse["stopReason"];
  /** Token accounting — what K3 meters and what K8.4 needs to sever mid-flight. Terminal chunk only. */
  usage?: { inputTokens: number; outputTokens: number };
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
