import {
  type LlmCapabilities,
  assertRequestSupported,
  capabilitiesForModel,
} from "../capabilities";
import {
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_STREAM_BYTES,
  LlmHttpError,
  drainBody,
  readBoundedJson,
  resolveLimit,
} from "../errors";
import {
  type LlmLayoutEntry,
  type LlmMediaPart,
  type LlmReasoning,
  type LlmResultPart,
  layoutOf,
  textOf,
} from "../parts";
import { inlineData } from "../resolveContent";
import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmToolCall } from "../types";
import { fenceUntrustedMedia } from "../untrusted";
import { validateExtraHeaders } from "./extraHeaders";

export interface GeminiProviderConfig {
  /**
   * Extra request headers sent on every request (for example `anthropic-workspace-id`). Header
   * names and values must be strings without CR/LF; a header the provider sets itself (auth,
   * protocol, content type) cannot be overridden and throws at construction. Unset, the request
   * is unchanged.
   */
  headers?: Readonly<Record<string, string>>;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /**
   * Cap on a complete response body, in bytes after decompression (default 8 MiB). Over it the
   * body is cancelled and `LlmResponseLimitError` (provider and reason only) is thrown.
   */
  maxResponseBytes?: number;
  /** Cap on the total bytes read from a stream (default 128 MiB); same error. */
  maxStreamBytes?: number;
  /** Cap on one line of a stream, in UTF-8 bytes (default 1 MiB); same error. */
  maxLineBytes?: number;
  /** Override the declared modalities. */
  capabilities?: LlmCapabilities;
  /**
   * Ask for thought summaries (`generationConfig.thinkingConfig.includeThoughts`, ADR 0133).
   * Unset, nothing is sent.
   */
  includeThoughts?: boolean;
  /**
   * Cap on thinking tokens (`generationConfig.thinkingConfig.thinkingBudget`). Thinking tokens
   * count against `maxOutputTokens`, so without a cap a small output budget can be spent entirely
   * on thinking (`MAX_TOKENS`, no text). An integer: `-1` lets the model decide (dynamic), `0`
   * disables thinking on models that allow it. The accepted range is per model and enforced by the
   * server (Gemini 2.5: Pro 128-32768, cannot be disabled; Flash 0-24576; Flash-Lite 512-24576, `0`
   * disables). Unset, nothing is sent.
   */
  thinkingBudget?: number;
}

/** `generateContent` takes any inline mime type the model supports; declare the common ones. */
export const GEMINI_CAPABILITIES: LlmCapabilities = {
  image: ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"],
  audio: ["audio/wav", "audio/mp3", "audio/mpeg", "audio/aac", "audio/ogg", "audio/flac"],
  file: ["application/pdf", "text/plain"],
  reasoning: true,
};

const PROVIDER_ID = "gemini";

/** Model families that take media: Gemini 1.5 and later, and the `-latest` aliases (1.0 Pro does not). */
export const GEMINI_MEDIA_MODELS = [/^gemini-(1\.5|[2-9])/, /^gemini-(flash|pro)(-lite)?-latest$/];
const GEMINI_DEFAULT_URL = "https://generativelanguage.googleapis.com";

/** Gemini returns no call id by default; the ones we synthesise carry this prefix and are never sent back. */
const SYNTHETIC_ID = "gemini-call-";

interface GeminiPart {
  text?: string;
  /** ADR 0133 - a thought SUMMARY part (returned when `includeThoughts` is set). */
  thought?: boolean;
  thoughtSignature?: string;
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
    for (const p of fenceUntrustedMedia(m.content)) {
      switch (p.type) {
        case "text":
          parts.push({ text: p.text });
          break;
        case "reasoning":
          // Only our own thought parts go back, unchanged; another provider's signature means
          // nothing here. A redacted part has no Gemini form.
          if (p.provider === PROVIDER_ID && p.kind !== "redacted") {
            parts.push({
              text: p.text ?? "",
              thought: true,
              ...(p.signature !== undefined && { thoughtSignature: p.signature }),
            });
          }
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
            // Gemini 3 400s a current-turn functionCall sent back without its signature.
            ...(p.signature !== undefined && { thoughtSignature: p.signature }),
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
          for (const r of items) {
            if (r.type === "text") continue;
            // The fence travels with the media into the trailing parts; the functionResponse
            // holds text only.
            for (const q of fenceUntrustedMedia<LlmResultPart>([r])) {
              trailing.push(q.type === "text" ? { text: q.text } : inlineBlock(q));
            }
          }
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
  private readonly maxResponseBytes: number;
  private readonly maxStreamBytes: number;
  private readonly maxLineBytes: number;
  private readonly includeThoughts: boolean | undefined;
  private readonly thinkingBudget: number | undefined;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  readonly capabilities: LlmCapabilities;

  constructor(config: GeminiProviderConfig = {}) {
    this.extraHeaders = validateExtraHeaders(
      config.headers,
      ["x-goog-api-key", "content-type", "authorization"],
      "GeminiProvider"
    );
    this.includeThoughts = config.includeThoughts;
    if (
      config.thinkingBudget !== undefined &&
      !(Number.isInteger(config.thinkingBudget) && config.thinkingBudget >= -1)
    )
      throw new RangeError("thinkingBudget must be an integer >= -1 (-1 = dynamic)");
    this.thinkingBudget = config.thinkingBudget;
    const model = config.model ?? "gemini-2.0-flash";
    this.capabilities =
      config.capabilities ??
      (config.baseUrl !== undefined && config.baseUrl !== GEMINI_DEFAULT_URL
        ? {}
        : capabilitiesForModel(model, GEMINI_CAPABILITIES, GEMINI_MEDIA_MODELS));
    this.apiKey =
      config.apiKey ??
      (typeof process !== "undefined"
        ? (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "")
        : "");
    this.model = config.model ?? "gemini-2.0-flash";
    this.baseUrl = config.baseUrl ?? GEMINI_DEFAULT_URL;
    this.maxResponseBytes = resolveLimit(
      config.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes"
    );
    this.maxStreamBytes = resolveLimit(
      config.maxStreamBytes,
      DEFAULT_MAX_STREAM_BYTES,
      "maxStreamBytes"
    );
    this.maxLineBytes = resolveLimit(config.maxLineBytes, DEFAULT_MAX_LINE_BYTES, "maxLineBytes");
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
    const thinking: Record<string, unknown> = {};
    if (this.includeThoughts !== undefined) thinking.includeThoughts = this.includeThoughts;
    if (this.thinkingBudget !== undefined) thinking.thinkingBudget = this.thinkingBudget;
    if (Object.keys(thinking).length > 0) generationConfig.thinkingConfig = thinking;

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
      headers: {
        ...this.extraHeaders,
        "content-type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
      ...(request.signal !== undefined && { signal: request.signal }),
      // Never follow a redirect (it would re-send the body and credentials to another origin): a 3xx
      // comes back as a response and becomes `LlmHttpError(provider, status)` below.
      redirect: "manual",
    });

    if (!resp.ok) {
      await drainBody(resp);
      throw new LlmHttpError("gemini", resp.status);
    }

    const data = (await readBoundedJson(resp, "gemini", this.maxResponseBytes)) as GeminiResponse;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    // A thought part is reasoning, never answer text: it must not leak into `content`.
    const content = parts.map((p) => (p.thought === true ? "" : (p.text ?? ""))).join("");
    const toolCalls: LlmToolCall[] = [];
    const reasoning: LlmReasoning[] = [];
    // ADR 0133 D5 - the vendor's part order, so thought / text / functionCall positions round-trip.
    const entries: LlmLayoutEntry[] = [];
    for (const p of parts) {
      if (p.thought === true) {
        reasoning.push({
          kind: "summary",
          text: p.text ?? "",
          ...(p.thoughtSignature !== undefined && { signature: p.thoughtSignature }),
          provider: PROVIDER_ID,
        });
        entries.push("reasoning");
        continue;
      }
      if (p.text !== undefined) entries.push({ text: p.text.length });
      if (p.functionCall !== undefined) {
        const id = p.functionCall.id ?? `${SYNTHETIC_ID}${toolCalls.length}`;
        toolCalls.push({
          id,
          name: p.functionCall.name,
          input: p.functionCall.args ?? {},
          ...(p.thoughtSignature !== undefined && { signature: p.thoughtSignature }),
        });
        entries.push({ call: id });
      }
    }
    const layout = layoutOf(entries);
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
      ...(reasoning.length > 0 && { reasoning }),
      ...(layout !== undefined && { layout }),
    };
  }
}
