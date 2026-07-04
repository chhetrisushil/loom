import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamChunk } from "../types";

export interface OpenAiProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

interface OpenAiChoice {
  message?: {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
  };
  delta?: { content?: string | null };
  finish_reason?: string | null;
}

interface OpenAiChatResponse {
  choices: OpenAiChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export class OpenAiProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(config: OpenAiProviderConfig = {}) {
    this.apiKey = config.apiKey ?? (typeof process !== "undefined" ? (process.env["OPENAI_API_KEY"] ?? "") : "");
    this.model = config.model ?? "gpt-4o";
    this.baseUrl = config.baseUrl ?? "https://api.openai.com";
  }

  private buildBody(request: LlmRequest, stream = false): Record<string, unknown> {
    const messages = request.messages.map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream,
    };

    if (request.maxTokens !== undefined) body["max_tokens"] = request.maxTokens;
    if (request.temperature !== undefined) body["temperature"] = request.temperature;

    if (request.tools !== undefined && request.tools.length > 0) {
      body["tools"] = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    return body;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(this.buildBody(request)),
    });

    if (!resp.ok) {
      throw new Error(`OpenAI API error ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as OpenAiChatResponse;
    const choice = data.choices[0];
    if (!choice?.message) {
      return { content: "", stopReason: "end_turn" };
    }

    const content = choice.message.content ?? "";
    const toolCalls = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments) as unknown,
    }));

    const stopReason =
      choice.finish_reason === "tool_calls"
        ? "tool_use"
        : choice.finish_reason === "length"
          ? "max_tokens"
          : "end_turn";

    return {
      content,
      ...(toolCalls.length > 0 && { toolCalls }),
      stopReason,
      ...(data.usage !== undefined && {
        usage: {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
        },
      }),
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(this.buildBody(request, true)),
    });

    if (!resp.ok) {
      throw new Error(`OpenAI API error ${resp.status}: ${await resp.text()}`);
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
          const chunk = JSON.parse(json) as OpenAiChatResponse;
          const delta = chunk.choices[0]?.delta?.content ?? "";
          const isFinished = chunk.choices[0]?.finish_reason != null;
          if (delta !== "") {
            yield { delta, done: false };
          }
          if (isFinished) {
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
