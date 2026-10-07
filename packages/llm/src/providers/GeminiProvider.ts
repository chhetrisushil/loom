import { type LlmCapabilities, assertRequestSupported } from "../capabilities";
import { type LlmMediaPart, textOf } from "../parts";
import { inlineData } from "../resolveContent";
import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmToolCall } from "../types";

export interface GeminiProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Override the declared modalities. */
  capabilities?: LlmCapabilities;
}

/** `generateContent` takes any inline mime type the model supports; declare the common ones. */
const GEMINI_CAPABILITIES: LlmCapabilities = {
  image: ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"],
  audio: ["audio/wav", "audio/mp3", "audio/mpeg", "audio/aac", "audio/ogg", "audio/flac"],
  file: ["application/pdf", "text/plain"],
};

/** Gemini returns no call id by default; the ones we synthesise carry this prefix and are never sent back. */
const SYNTHETIC_ID = "gemini-call-";

interface GeminiPart {
  text?: string;
  functionCall?: { id?: string; name: string; args?: unknown };
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function inlineBlock(p: LlmMediaPart): Record<string, unknown> {
  return { inlineData: { mimeType: p.mediaType, data: inlineData(p) } };
}

/**
 * SPI messages → Gemini `contents`. `functionResponse` is matched to its call by NAME, which
 * the SPI's `tool_result` does not carry, so names are recovered from the earlier `tool_use`
 * part with the same id. Media a tool returned rides as extra `inlineData` parts alongside.
 * Exported for tests.
 */
export function mapContents(messages: readonly LlmMessage[]): Record<string, unknown>[] {
  const names = new Map<string, string>();
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "model" : "user";
    if (typeof m.content === "string") {
      out.push({ role, parts: [{ text: m.content }] });
      continue;
    }
    const parts: Record<string, unknown>[] = [];
    const trailing: Record<string, unknown>[] = [];
    for (const p of m.content) {
      switch (p.type) {
        case "text":
          parts.push({ text: p.text });
          break;
        case "image":
        case "audio":
        case "file":
          parts.push(inlineBlock(p));
          break;
        case "tool_use":
          names.set(p.id, p.name);
          parts.push({
            functionCall: {
              ...(!p.id.startsWith(SYNTHETIC_ID) && { id: p.id }),
              name: p.name,
              args: p.input ?? {},
            },
          });
          break;
        case "tool_result": {
          const items =
            typeof p.content === "string"
              ? [{ type: "text" as const, text: p.content }]
              : p.content;
          const text = items.flatMap((r) => (r.type === "text" ? [r.text] : [])).join("\n");
          parts.push({
            functionResponse: {
              ...(!p.toolUseId.startsWith(SYNTHETIC_ID) && { id: p.toolUseId }),
              name: names.get(p.toolUseId) ?? p.toolUseId,
              response: p.isError === true ? { error: text } : { output: text },
            },
          });
          for (const r of items) if (r.type !== "text") trailing.push(inlineBlock(r));
          break;
        }
      }
    }
    out.push({ role, parts: [...parts, ...trailing] });
  }
  return out;
}

// A Google Gemini (Generative Language API) provider — the same fetch-based shape as
// OpenAiProvider / AnthropicProvider, mapping the Loom `LlmRequest`/`LlmResponse` contract
// onto Gemini's `generateContent`. Gemini uses roles "user" / "model" (no "assistant") and
// carries the system prompt as a separate `systemInstruction`, so we translate accordingly.
export class GeminiProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  readonly capabilities: LlmCapabilities;

  constructor(config: GeminiProviderConfig = {}) {
    this.capabilities = config.capabilities ?? GEMINI_CAPABILITIES;
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
      ...request.messages.filter((m) => m.role === "system").map((m) => textOf(m.content)),
      ...(request.system !== undefined ? [request.system] : []),
    ].join("\n\n");

    const contents = mapContents(request.messages);

    const generationConfig: Record<string, unknown> = {};
    if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens;
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;

    return {
      contents,
      ...(request.tools !== undefined &&
        request.tools.length > 0 && {
          tools: [
            {
              functionDeclarations: request.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.inputSchema,
              })),
            },
          ],
        }),
      ...(systemText.length > 0 && { systemInstruction: { parts: [{ text: systemText }] } }),
      ...(Object.keys(generationConfig).length > 0 && { generationConfig }),
    };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    assertRequestSupported(request, this.capabilities, "GeminiProvider");
    const body = this.buildBody(request);
    const resp = await fetch(`${this.baseUrl}/v1beta/models/${this.model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
      ...(request.signal !== undefined && { signal: request.signal }),
    });

    if (!resp.ok) {
      throw new Error(`Gemini API error ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const content = parts.map((p) => p.text ?? "").join("");
    const toolCalls: LlmToolCall[] = [];
    for (const p of parts) {
      if (p.functionCall !== undefined) {
        toolCalls.push({
          id: p.functionCall.id ?? `${SYNTHETIC_ID}${toolCalls.length}`,
          name: p.functionCall.name,
          input: p.functionCall.args ?? {},
        });
      }
    }
    const stopReason =
      toolCalls.length > 0
        ? "tool_use"
        : candidate?.finishReason === "MAX_TOKENS"
          ? "max_tokens"
          : "end_turn";

    return {
      content,
      ...(toolCalls.length > 0 && { toolCalls }),
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
