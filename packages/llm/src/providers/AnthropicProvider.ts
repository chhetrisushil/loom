import { type LlmCapabilities, assertRequestSupported } from "../capabilities";
import { type LlmContentPart, type LlmResultPart, textOf } from "../parts";
import { inlineData } from "../resolveContent";
import type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk,
  LlmToolCall,
} from "../types";

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
}

/** Messages API: images (JPEG/PNG/GIF/WebP) and PDF documents; no audio. */
const ANTHROPIC_CAPABILITIES: LlmCapabilities = {
  image: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  file: ["application/pdf"],
};

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
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: p.toolUseId,
        content: typeof p.content === "string" ? p.content : p.content.map(mapResultPart),
        ...(p.isError === true && { is_error: true }),
      };
  }
}

function mapContent(content: LlmMessage["content"]): string | Record<string, unknown>[] {
  if (typeof content === "string") return content;
  return content.map(mapPart);
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
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicMessageResponse {
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  readonly capabilities: LlmCapabilities;

  constructor(config: AnthropicProviderConfig = {}) {
    this.capabilities = config.capabilities ?? ANTHROPIC_CAPABILITIES;
    this.apiKey =
      config.apiKey ??
      (typeof process !== "undefined" ? (process.env.ANTHROPIC_API_KEY ?? "") : "");
    this.model = config.model ?? "claude-opus-4-8";
    this.baseUrl = config.baseUrl ?? "https://api.anthropic.com";
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

    return {
      content,
      ...(toolCalls.length > 0 && { toolCalls }),
      stopReason,
      usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
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
    let stopReason: LlmResponse["stopReason"] | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    const terminal = (): LlmStreamChunk => ({
      delta: "",
      done: true,
      ...(toolCalls.length > 0 && { toolCalls }),
      ...(stopReason !== undefined && { stopReason }),
      ...(inputTokens !== undefined &&
        outputTokens !== undefined && { usage: { inputTokens, outputTokens } }),
    });

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
            if (block?.type === "tool_use") {
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
              yield { delta: String(delta.text ?? ""), done: false };
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
