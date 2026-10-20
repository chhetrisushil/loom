import {
  type LlmCapabilities,
  assertRequestSupported,
  capabilitiesForModel,
} from "../capabilities";
import {
  type LlmContentPart,
  type LlmLayoutEntry,
  type LlmReasoning,
  type LlmReasoningPart,
  type LlmResultPart,
  layoutOf,
  textOf,
} from "../parts";
import { inlineData } from "../resolveContent";
import type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk,
  LlmToolCall,
} from "../types";
import { fenceUntrustedMedia } from "../untrusted";

/**
 * Anthropic's `stop_reason` → the SPI's. ONE implementation, used by both
 * `complete` and `stream`: a duplicated mapping is exactly where two paths to one
 * outcome start disagreeing, which is what the conformance parity check exists to
 * catch and what this makes structurally impossible.
 */
function normalizeStopReason(raw: unknown): LlmResponse["stopReason"] {
  return raw === "tool_use" ? "tool_use" : raw === "max_tokens" ? "max_tokens" : "end_turn";
}

export interface AnthropicProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Override the declared modalities (e.g. a model without vision). */
  capabilities?: LlmCapabilities;
  /**
   * Extended thinking, passed through as the request's `thinking` (ADR 0133). `display: "summarized"`
   * asks for a readable summary; the default is the API's (omitted on current models, where only the
   * signature is returned). Unset, no `thinking` is sent.
   */
  thinking?: { type: "adaptive"; display?: "summarized" | "omitted" };
}

/** Messages API: images (JPEG/PNG/GIF/WebP) and PDF documents; no audio. */
const ANTHROPIC_CAPABILITIES: LlmCapabilities = {
  image: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  file: ["application/pdf"],
  reasoning: true,
};

const PROVIDER_ID = "anthropic";

/** Model families that take images and PDFs: Claude 3 and later (2.x and Instant do not). */
const ANTHROPIC_MEDIA_MODELS = [/^claude-(3|[4-9]\d*|opus|sonnet|haiku)/];
const ANTHROPIC_DEFAULT_URL = "https://api.anthropic.com";

function mapResultPart(p: LlmResultPart): Record<string, unknown> {
  return mapPart(p);
}

/** SPI part → Anthropic content block. Exported for tests. */
export function mapPart(p: LlmContentPart): Record<string, unknown> {
  switch (p.type) {
    case "text":
      return { type: "text", text: p.text };
    case "image":
      return {
        type: "image",
        source: { type: "base64", media_type: p.mediaType, data: inlineData(p) },
      };
    case "file":
      return {
        type: "document",
        source: { type: "base64", media_type: p.mediaType, data: inlineData(p) },
        ...(p.name !== undefined && { title: p.name }),
      };
    case "audio":
      throw new Error("Anthropic Messages does not accept audio content");
    case "tool_use":
      return { type: "tool_use", id: p.id, name: p.name, input: p.input };
    case "reasoning":
      return mapReasoningPart(p);
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: p.toolUseId,
        content:
          typeof p.content === "string"
            ? p.content
            : fenceUntrustedMedia(p.content).map(mapResultPart),
        ...(p.isError === true && { is_error: true }),
      };
  }
}

/**
 * An assistant `reasoning` part -> the vendor block, UNCHANGED (ADR 0133 D5): a `thinking` block with
 * its text (resolved by `resolveRequestContent`, "" when omitted) and signature, or a
 * `redacted_thinking` block whose `data` is the recorded signature. Callers drop other providers'
 * parts first ({@link mapContent}); this is only reached for ours.
 */
function mapReasoningPart(p: LlmReasoningPart): Record<string, unknown> {
  if (p.kind === "redacted") return { type: "redacted_thinking", data: p.signature ?? "" };
  return {
    type: "thinking",
    thinking: p.text ?? "",
    ...(p.signature !== undefined && { signature: p.signature }),
  };
}

/**
 * Blocks go back in the order they were recorded (ADR 0133 D5): a signature binds the blocks before
 * it, so `thinking, text, tool_use, thinking, tool_use` must not be regrouped. A part from another
 * provider is omitted: its signature means nothing here.
 */
function mapContent(content: LlmMessage["content"]): string | Record<string, unknown>[] {
  if (typeof content === "string") return content;
  const own = content.filter((p) => p.type !== "reasoning" || p.provider === PROVIDER_ID);
  return fenceUntrustedMedia(own).map(mapPart);
}

/**
 * ADR 0133 D2 - ONE rule, pinned by a test: a non-empty `thinking` text is `summary` (current models
 * return only summaries; the raw chain of thought is never returned), an empty one is `text` with
 * `text: ""` (an omitted-display block, the signature carries the reasoning), and `redacted_thinking`
 * is `redacted` with its `data` as the signature. Shared by `complete` and `stream`.
 */
function reasoningOf(block: {
  type: string;
  thinking?: unknown;
  signature?: unknown;
  data?: unknown;
}): LlmReasoning | undefined {
  if (block.type === "redacted_thinking") {
    return {
      kind: "redacted",
      ...(typeof block.data === "string" && { signature: block.data }),
      provider: PROVIDER_ID,
    };
  }
  if (block.type !== "thinking") return undefined;
  const text = typeof block.thinking === "string" ? block.thinking : "";
  return {
    kind: text === "" ? "text" : "summary",
    text,
    ...(typeof block.signature === "string" && { signature: block.signature }),
    provider: PROVIDER_ID,
  };
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
interface AnthropicThinkingBlock {
  type: "thinking" | "redacted_thinking";
  thinking?: string;
  signature?: string;
  data?: string;
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicThinkingBlock;

interface AnthropicMessageResponse {
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly thinking: AnthropicProviderConfig["thinking"];
  readonly capabilities: LlmCapabilities;

  constructor(config: AnthropicProviderConfig = {}) {
    this.thinking = config.thinking;
    const model = config.model ?? "claude-opus-4-8";
    this.capabilities =
      config.capabilities ??
      (config.baseUrl !== undefined && config.baseUrl !== ANTHROPIC_DEFAULT_URL
        ? {}
        : capabilitiesForModel(model, ANTHROPIC_CAPABILITIES, ANTHROPIC_MEDIA_MODELS));
    this.apiKey =
      config.apiKey ??
      (typeof process !== "undefined" ? (process.env.ANTHROPIC_API_KEY ?? "") : "");
    this.model = config.model ?? "claude-opus-4-8";
    this.baseUrl = config.baseUrl ?? ANTHROPIC_DEFAULT_URL;
  }

  private buildBody(request: LlmRequest): Record<string, unknown> {
    const systemMsg = request.messages.find((m) => m.role === "system");
    const system =
      request.system ?? (systemMsg !== undefined ? textOf(systemMsg.content) : undefined);

    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: mapContent(m.content) }));

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? 4096,
      messages,
    };

    if (system !== undefined) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (this.thinking !== undefined) body.thinking = { ...this.thinking };

    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: { type: "object", ...t.inputSchema },
      }));
    }

    return body;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    assertRequestSupported(request, this.capabilities, "AnthropicProvider");
    const body = this.buildBody(request);
    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      ...(request.signal !== undefined && { signal: request.signal }),
    });

    if (!resp.ok) {
      throw new Error(`Anthropic API error ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as AnthropicMessageResponse;

    const content = data.content
      .filter((b): b is AnthropicTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const toolCalls = data.content
      .filter((b): b is AnthropicToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    const stopReason = normalizeStopReason(data.stop_reason);
    const reasoning: LlmReasoning[] = [];
    const entries: LlmLayoutEntry[] = [];
    for (const b of data.content) {
      const r = reasoningOf(b);
      if (r !== undefined) {
        reasoning.push(r);
        entries.push("reasoning");
      } else if (b.type === "text") entries.push({ text: (b as AnthropicTextBlock).text.length });
      else if (b.type === "tool_use") entries.push({ call: (b as AnthropicToolUseBlock).id });
    }
    const layout = layoutOf(entries);

    return {
      content,
      ...(toolCalls.length > 0 && { toolCalls }),
      stopReason,
      usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
      ...(reasoning.length > 0 && { reasoning }),
      ...(layout !== undefined && { layout }),
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    assertRequestSupported(request, this.capabilities, "AnthropicProvider");
    const body = { ...this.buildBody(request), stream: true };

    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      ...(request.signal !== undefined && { signal: request.signal }),
    });

    if (!resp.ok) {
      throw new Error(`Anthropic API error ${resp.status}: ${await resp.text()}`);
    }

    if (!resp.body) return;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Accumulated across the stream so the TERMINAL chunk can report the same
    // outcome `complete` would have. Tool-call arguments arrive as `input_json_delta`
    // fragments that are only valid JSON once concatenated, so a block is parsed at
    // `content_block_stop`, not per delta.
    const toolCalls: LlmToolCall[] = [];
    const openBlocks = new Map<number, { id: string; name: string; argsJson: string }>();
    // ADR 0133 - thinking blocks assemble from `thinking_delta` / `signature_delta`; a block is
    // closed (and mapped through the same {@link reasoningOf} as `complete`) at `content_block_stop`.
    const openThinking = new Map<
      number,
      {
        type: "thinking" | "redacted_thinking";
        thinking: string;
        signature?: string;
        data?: string;
      }
    >();
    const reasoning: LlmReasoning[] = [];
    // ADR 0133 D5 - block order, by `content_block_start`; a text block's entry grows with its deltas.
    const entries: LlmLayoutEntry[] = [];
    const textEntries = new Map<number, { text: number }>();
    let stopReason: LlmResponse["stopReason"] | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    const terminal = (): LlmStreamChunk => {
      const layout = layoutOf(entries);
      return {
        delta: "",
        done: true,
        ...(toolCalls.length > 0 && { toolCalls }),
        ...(stopReason !== undefined && { stopReason }),
        ...(inputTokens !== undefined &&
          outputTokens !== undefined && { usage: { inputTokens, outputTokens } }),
        ...(reasoning.length > 0 && { reasoning }),
        ...(layout !== undefined && { layout }),
      };
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const json = line.slice(6).trim();
        if (json === "[DONE]") {
          yield terminal();
          return;
        }
        try {
          const event = JSON.parse(json) as Record<string, unknown>;
          if (event.type === "content_block_start") {
            const block = event.content_block as Record<string, unknown> | undefined;
            if (block?.type === "text") {
              const entry = { text: 0 };
              textEntries.set(Number(event.index), entry);
              entries.push(entry);
            } else if (block?.type === "thinking" || block?.type === "redacted_thinking") {
              entries.push("reasoning");
              openThinking.set(Number(event.index), {
                type: block.type,
                thinking: typeof block.thinking === "string" ? block.thinking : "",
                ...(typeof block.signature === "string" && { signature: block.signature }),
                ...(typeof block.data === "string" && { data: block.data }),
              });
            } else if (block?.type === "tool_use") {
              entries.push({ call: String(block.id ?? "") });
              openBlocks.set(Number(event.index), {
                id: String(block.id ?? ""),
                name: String(block.name ?? ""),
                argsJson: "",
              });
              yield {
                delta: "",
                done: false,
                toolDelta: {
                  id: String(block.id ?? ""),
                  name: String(block.name ?? ""),
                  inputDelta: "",
                },
              };
            }
          } else if (event.type === "content_block_delta") {
            const delta = event.delta as Record<string, unknown> | undefined;
            if (delta?.type === "text_delta") {
              const text = String(delta.text ?? "");
              let entry = textEntries.get(Number(event.index));
              if (entry === undefined) {
                entry = { text: 0 };
                textEntries.set(Number(event.index), entry);
                entries.push(entry);
              }
              entry.text += text.length;
              yield { delta: text, done: false };
            } else if (delta?.type === "thinking_delta") {
              const open = openThinking.get(Number(event.index));
              const fragment = String(delta.thinking ?? "");
              if (open !== undefined) open.thinking += fragment;
              if (fragment !== "") yield { delta: "", done: false, reasoningDelta: fragment };
            } else if (delta?.type === "signature_delta") {
              const open = openThinking.get(Number(event.index));
              if (open !== undefined)
                open.signature = (open.signature ?? "") + String(delta.signature ?? "");
            } else if (delta?.type === "input_json_delta") {
              const open = openBlocks.get(Number(event.index));
              if (open !== undefined) {
                const fragment = String(delta.partial_json ?? "");
                open.argsJson += fragment;
                yield {
                  delta: "",
                  done: false,
                  toolDelta: { id: open.id, inputDelta: fragment },
                };
              }
            }
          } else if (event.type === "content_block_stop") {
            const thinking = openThinking.get(Number(event.index));
            if (thinking !== undefined) {
              openThinking.delete(Number(event.index));
              const r = reasoningOf(thinking);
              if (r !== undefined) reasoning.push(r);
            }
            const open = openBlocks.get(Number(event.index));
            if (open !== undefined) {
              openBlocks.delete(Number(event.index));
              // An empty argument object streams as no deltas at all, which is `{}`,
              // not a parse error.
              let input: unknown = {};
              try {
                input = open.argsJson === "" ? {} : JSON.parse(open.argsJson);
              } catch {
                // Malformed arguments are reported as-is rather than dropped: the
                // agent loop must be able to see WHY a call could not be made.
                input = { __unparsedArguments: open.argsJson };
              }
              toolCalls.push({ id: open.id, name: open.name, input });
            }
          } else if (event.type === "message_delta") {
            // Carries the stop reason and the OUTPUT token count (input tokens came
            // with message_start).
            const delta = event.delta as Record<string, unknown> | undefined;
            stopReason = normalizeStopReason(delta?.stop_reason);
            const usage = event.usage as Record<string, unknown> | undefined;
            if (usage?.output_tokens !== undefined) outputTokens = Number(usage.output_tokens);
          } else if (event.type === "message_start") {
            const message = event.message as Record<string, unknown> | undefined;
            const usage = message?.usage as Record<string, unknown> | undefined;
            if (usage?.input_tokens !== undefined) inputTokens = Number(usage.input_tokens);
            if (usage?.output_tokens !== undefined) outputTokens = Number(usage.output_tokens);
          } else if (event.type === "message_stop") {
            yield terminal();
            return;
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  }
}
