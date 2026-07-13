import type { LlmProvider, LlmRequest, LlmResponse } from "../types";

export interface GeminiProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

interface GeminiPart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

// A Google Gemini (Generative Language API) provider — the same fetch-based shape as
// OpenAiProvider / AnthropicProvider, mapping the Loom `LlmRequest`/`LlmResponse` contract
// onto Gemini's `generateContent`. Gemini uses roles "user" / "model" (no "assistant") and
// carries the system prompt as a separate `systemInstruction`, so we translate accordingly.
export class GeminiProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(config: GeminiProviderConfig = {}) {
    this.apiKey =
      config.apiKey ??
      (typeof process !== "undefined"
        ? (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "")
        : "");
    this.model = config.model ?? "gemini-2.0-flash";
    this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com";
  }

  private buildBody(request: LlmRequest): Record<string, unknown> {
    // Collect any system messages + the request-level `system` into one instruction.
    const systemText = [
      ...request.messages.filter((m) => m.role === "system").map((m) => m.content),
      ...(request.system !== undefined ? [request.system] : []),
    ].join("\n\n");

    const contents = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const generationConfig: Record<string, unknown> = {};
    if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens;
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;

    return {
      contents,
      ...(systemText.length > 0 && { systemInstruction: { parts: [{ text: systemText }] } }),
      ...(Object.keys(generationConfig).length > 0 && { generationConfig }),
    };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const resp = await fetch(`${this.baseUrl}/v1beta/models/${this.model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(this.buildBody(request)),
      ...(request.signal !== undefined && { signal: request.signal }),
    });

    if (!resp.ok) {
      throw new Error(`Gemini API error ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    const content = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    const stopReason = candidate?.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn";

    return {
      content,
      stopReason,
      ...(data.usageMetadata !== undefined && {
        usage: {
          inputTokens: data.usageMetadata.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
        },
      }),
    };
  }
}
