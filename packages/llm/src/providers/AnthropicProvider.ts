import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamChunk } from "../types";

export interface AnthropicProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
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

  constructor(config: AnthropicProviderConfig = {}) {
    this.apiKey = config.apiKey ?? (typeof process !== "undefined" ? (process.env["ANTHROPIC_API_KEY"] ?? "") : "");
    this.model = config.model ?? "claude-opus-4-8";
    this.baseUrl = config.baseUrl ?? "https://api.anthropic.com";
  }

  private buildBody(request: LlmRequest): Record<string, unknown> {
    const systemMsg = request.messages.find((m) => m.role === "system");
    const system = request.system ?? systemMsg?.content;

    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? 4096,
      messages,
    };

    if (system !== undefined) body["system"] = system;
    if (request.temperature !== undefined) body["temperature"] = request.temperature;

    if (request.tools !== undefined && request.tools.length > 0) {
      body["tools"] = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: { type: "object", ...t.inputSchema },
      }));
    }

    return body;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(this.buildBody(request)),
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

    const stopReason =
      data.stop_reason === "tool_use"
        ? "tool_use"
        : data.stop_reason === "max_tokens"
          ? "max_tokens"
          : "end_turn";

    return {
      content,
      ...(toolCalls.length > 0 && { toolCalls }),
      stopReason,
      usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const body = { ...this.buildBody(request), stream: true };

    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new Error(`Anthropic API error ${resp.status}: ${await resp.text()}`);
    }

    if (!resp.body) return;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
          yield { delta: "", done: true };
          return;
        }
        try {
          const event = JSON.parse(json) as Record<string, unknown>;
          if (event["type"] === "content_block_delta") {
            const delta = event["delta"] as Record<string, unknown> | undefined;
            if (delta?.["type"] === "text_delta") {
              yield { delta: String(delta["text"] ?? ""), done: false };
            }
          } else if (event["type"] === "message_stop") {
            yield { delta: "", done: true };
            return;
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  }
}
