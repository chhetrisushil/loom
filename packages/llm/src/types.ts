import type { LlmCapabilities } from "./capabilities";
import type {
  LlmContent,
  LlmLayoutEntry,
  LlmMessageContent,
  LlmMessageContentInput,
  LlmReasoning,
  LlmReasoningPart,
} from "./parts";

export type {
  LlmContent,
  LlmLayoutEntry,
  LlmReasoning,
  LlmReasoningKind,
  LlmReasoningPart,
} from "./parts";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  /**
   * R5 — a string (text only) or content parts (text, image, audio, file, `tool_use`,
   * `tool_result`). Use `textOf` / `toParts` to read it without caring which.
   */
  content: LlmMessageContent;
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

export interface LlmMessageInput {
  role: "system" | "user" | "assistant";
  content: LlmMessageContentInput;
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
  /** Provider-opaque continuation bytes that belong to this call (Gemini `thoughtSignature`); sent back unchanged (ADR 0133). */
  signature?: string;
}

export interface LlmResponse {
  content: string;
  toolCalls?: LlmToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * ADR 0133 - the reasoning the provider returned, as it returned it. ABSENT when the provider
   * returned none (G2). Readable `text` appears only on a provider's own response: `createLlmEffect`
   * replaces this with {@link LlmReasoningPart}s before `parseResponse`, so text never reaches a step value.
   */
  reasoning?: LlmReasoning[];
  /**
   * ADR 0133 D5 - the vendor's block order (reasoning, text and tool-call positions), present ONLY
   * when there is reasoning AND the order is not the canonical one. Lets a signature-binding provider
   * get its response back exactly. Positions only; absent otherwise (G2).
   */
  layout?: LlmLayoutEntry[];
}

/** What `parseResponse` receives: reasoning already reduced to its recorded form (ADR 0133 D3). */
export type LlmCapturedResponse = Omit<LlmResponse, "reasoning"> & {
  reasoning?: LlmReasoningPart[];
};

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
  /**
   * R5 — an increment of a tool call's INPUT, streamed as it is generated. The first
   * fragment of a call carries `id` and `name` (with `inputDelta` possibly `""`); later
   * fragments carry the `id` and the next slice of the JSON text. Transient by
   * construction, like `delta`: the assembled call still arrives whole on the terminal
   * chunk's `toolCalls`, which is the only thing that is journaled. A fragment is
   * partial JSON — never parse it.
   */
  toolDelta?: { id: string; name?: string; inputDelta: string };
  /** Tool calls the model made, assembled from the stream. Terminal chunk only. */
  toolCalls?: LlmToolCall[];
  /** Why generation stopped. Terminal chunk only. */
  stopReason?: LlmResponse["stopReason"];
  /** Token accounting — what K3 meters and what K8.4 needs to sever mid-flight. Terminal chunk only. */
  usage?: { inputTokens: number; outputTokens: number };
  /** ADR 0133 - the assembled reasoning; equals what `complete` returns. Terminal chunk only. */
  reasoning?: LlmReasoning[];
  /** ADR 0133 D5 - the block order; equals what `complete` returns. Terminal chunk only. */
  layout?: LlmLayoutEntry[];
  /**
   * ADR 0133 D6 - an increment of READABLE reasoning (a summary or text), streamed as it arrives.
   * A separate field from `delta` so no consumer of text deltas sees reasoning by accident.
   * Signatures and redacted data are never streamed. Transient: only the terminal `reasoning` is kept.
   */
  reasoningDelta?: string;
}

export interface LlmProvider {
  /**
   * R5 — which non-text modalities this provider accepts. ABSENT means text and tool
   * calls only: a request carrying an image/audio/file part is refused with
   * {@link UnsupportedModalityError} before any network call (fail closed — a provider
   * that never declared media must not be handed it and left to drop it silently).
   */
  readonly capabilities?: LlmCapabilities;
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
