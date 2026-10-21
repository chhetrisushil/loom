import {
  type LlmCapabilities,
  assertRequestSupported,
  capabilitiesForModel,
} from "../capabilities";
import { LlmHttpError } from "../errors";
import { type LlmMediaPart, type LlmReasoning, type LlmResultPart, textOf } from "../parts";
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
import { validateExtraHeaders } from "./extraHeaders";

/**
 * OpenAI's `finish_reason` → the SPI's. ONE implementation shared by `complete`
 * and `stream`: a duplicated mapping is where two paths to one outcome start
 * disagreeing, which is what the conformance parity check exists to catch.
 */
function normalizeFinishReason(raw: unknown): LlmResponse["stopReason"] {
  return raw === "tool_calls" ? "tool_use" : raw === "length" ? "max_tokens" : "end_turn";
}

/** Parse tool arguments, surfacing malformed JSON rather than dropping the call. */
function parseArguments(argsJson: string): unknown {
  if (argsJson === "") return {};
  try {
    return JSON.parse(argsJson) as unknown;
  } catch {
    return { __unparsedArguments: argsJson };
  }
}

export interface OpenAiProviderConfig {
  /** Sent as `reasoning_effort` when set; servers that support reasoning return it only when asked. */
  reasoningEffort?: "low" | "medium" | "high";
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
  /** Override the declared modalities (e.g. a model without vision or audio input). */
  capabilities?: LlmCapabilities;
}

/** Chat Completions: images, `input_audio` (wav/mp3) and PDF `file` inputs. */
const OPENAI_CAPABILITIES: LlmCapabilities = {
  image: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  audio: ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"],
  file: ["application/pdf"],
};

/**
 * Model families that take images (and PDFs): gpt-4o, gpt-4.1, gpt-5, o1 / o3 (not the -mini and
 * -preview variants), o4, and dated gpt-4-turbo (not the -preview ones). Plain gpt-4 and its dated
 * snapshots, gpt-3.5 and anything unlisted are text-only.
 */
const OPENAI_MEDIA_MODELS = [
  /^gpt-4o/,
  /^gpt-4\.1/,
  /^gpt-5/,
  /^o1(-(?!mini|preview)|$)/,
  /^o3(-(?!mini)|$)/,
  /^o4/,
  /^gpt-4-turbo(-\d{4}-\d{2}-\d{2})?$/,
];
const OPENAI_DEFAULT_URL = "https://api.openai.com";

/** ADR 0133 - `reasoning_content` (an OpenAI-compatible server's field) -> reasoning. Shared by `complete` and `stream`. */
function compatReasoning(text: string): LlmReasoning[] {
  return text === "" ? [] : [{ kind: "text", text, provider: "openai-compat" }];
}

/** `reasoning_content` (DeepSeek-style servers) or `reasoning` (Ollama and others); the first non-empty wins. */
function readReasoningField(x: {
  reasoning_content?: string | null;
  reasoning?: string | null;
}): string {
  return x.reasoning_content || x.reasoning || "";
}

function dataUrl(p: LlmMediaPart): string {
  return `data:${p.mediaType};base64,${inlineData(p)}`;
}

function mediaBlock(p: LlmMediaPart): Record<string, unknown> {
  switch (p.type) {
    case "image":
      return { type: "image_url", image_url: { url: dataUrl(p) } };
    case "audio": {
      const mt = p.mediaType.toLowerCase();
      const format = mt.endsWith("wav")
        ? "wav"
        : mt.endsWith("mpeg") || mt.endsWith("mp3")
          ? "mp3"
          : undefined;
      if (format === undefined)
        throw new Error(`OpenAI does not accept audio of type "${p.mediaType}"`);
      return { type: "input_audio", input_audio: { data: inlineData(p), format } };
    }
    case "file":
      return {
        type: "file",
        file: { filename: p.name ?? "file.pdf", file_data: dataUrl(p) },
      };
  }
}

/**
 * SPI messages → Chat Completions messages. Exported for tests.
 *
 * `tool_result` parts become `role: "tool"` messages (which must directly follow the
 * assistant message that made the calls, hence they come first); a tool message holds text
 * only, so media a tool returned rides in a trailing `user` message. Other user parts become
 * one content-array `user` message; an assistant's `tool_use` parts become `tool_calls`.
 */
export function mapMessages(messages: readonly LlmMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const toolCalls = m.content
        .filter((p) => p.type === "tool_use")
        .map((p) => {
          const u = p as { id: string; name: string; input: unknown };
          return {
            id: u.id,
            type: "function",
            function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) },
          };
        });
      const text = textOf(m.content);
      out.push({
        role: "assistant",
        content: text === "" && toolCalls.length > 0 ? null : text,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      });
      continue;
    }
    if (m.role === "system") {
      out.push({ role: "system", content: textOf(m.content) });
      continue;
    }
    const userBlocks: Record<string, unknown>[] = [];
    const toolMedia: Record<string, unknown>[] = [];
    for (const p of fenceUntrustedMedia(m.content)) {
      if (p.type === "tool_result") {
        const items =
          typeof p.content === "string" ? [{ type: "text" as const, text: p.content }] : p.content;
        const text = items.flatMap((r) => (r.type === "text" ? [r.text] : [])).join("\n");
        out.push({ role: "tool", tool_call_id: p.toolUseId, content: text });
        let headed = false;
        for (const r of items) {
          if (r.type === "text") continue;
          // One header per media-returning call, so the model can tell whose media follows.
          if (!headed) {
            toolMedia.push({ type: "text", text: `Media returned by tool call ${p.toolUseId}:` });
            headed = true;
          }
          // The fence travels WITH the media into the trailing user message; the `tool` message
          // (text only) never holds the bytes, so a bracket left there would fence nothing.
          for (const q of fenceUntrustedMedia<LlmResultPart>([r])) {
            toolMedia.push(q.type === "text" ? { type: "text", text: q.text } : mediaBlock(q));
          }
        }
      } else if (p.type === "text") userBlocks.push({ type: "text", text: p.text });
      else if (p.type === "tool_use")
        throw new Error("tool_use parts belong in assistant messages");
      else if (p.type === "reasoning")
        throw new Error("reasoning parts belong in assistant messages");
      else userBlocks.push(mediaBlock(p));
    }
    const blocks = [...toolMedia, ...userBlocks];
    if (blocks.length > 0) out.push({ role: "user", content: blocks });
  }
  return out;
}

interface OpenAiChoice {
  message?: {
    content?: string | null;
    /** Some OpenAI-compatible servers return reasoning here; OpenAI's own Chat Completions does not (ADR 0133). */
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
  };
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
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
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly reasoningEffort: OpenAiProviderConfig["reasoningEffort"];
  readonly capabilities: LlmCapabilities;

  constructor(config: OpenAiProviderConfig = {}) {
    this.reasoningEffort = config.reasoningEffort;
    this.extraHeaders = validateExtraHeaders(
      config.headers,
      ["authorization", "content-type"],
      "OpenAiProvider"
    );
    const model = config.model ?? "gpt-4o";
    // `input_audio` is only accepted by the audio-preview family, not by gpt-4o proper.
    const { audio: _audio, ...noAudio } = OPENAI_CAPABILITIES;
    this.capabilities =
      config.capabilities ??
      (config.baseUrl !== undefined && config.baseUrl !== OPENAI_DEFAULT_URL
        ? {}
        : capabilitiesForModel(
            model,
            /audio/.test(model) ? OPENAI_CAPABILITIES : noAudio,
            OPENAI_MEDIA_MODELS
          ));
    this.apiKey =
      config.apiKey ?? (typeof process !== "undefined" ? (process.env.OPENAI_API_KEY ?? "") : "");
    this.model = config.model ?? "gpt-4o";
    this.baseUrl = config.baseUrl ?? OPENAI_DEFAULT_URL;
  }

  private buildBody(request: LlmRequest, stream = false): Record<string, unknown> {
    const messages = mapMessages(request.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream,
    };

    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (this.reasoningEffort !== undefined) body.reasoning_effort = this.reasoningEffort;

    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    return body;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    assertRequestSupported(request, this.capabilities, "OpenAiProvider");
    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...this.extraHeaders,
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(this.buildBody(request)),
      ...(request.signal !== undefined && { signal: request.signal }),
    });

    if (!resp.ok) {
      throw new LlmHttpError("openai", resp.status);
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
      input: parseArguments(tc.function.arguments),
    }));

    const stopReason = normalizeFinishReason(choice.finish_reason);
    const reasoning = compatReasoning(readReasoningField(choice.message));

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
      ...(reasoning.length > 0 && { reasoning }),
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    assertRequestSupported(request, this.capabilities, "OpenAiProvider");
    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...this.extraHeaders,
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      // `include_usage` is what makes the streamed path able to report the token
      // counts the completed path always did — without it K3 meters nothing when
      // streaming, and K8.4 has no mid-flight signal to sever on.
      body: JSON.stringify({
        ...this.buildBody(request, true),
        stream_options: { include_usage: true },
      }),
      ...(request.signal !== undefined && { signal: request.signal }),
    });

    if (!resp.ok) {
      throw new LlmHttpError("openai", resp.status);
    }

    if (!resp.body) return;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Accumulated so the TERMINAL chunk reports what `complete` would have.
    // Tool-call arguments stream as fragments keyed by `index` and are only valid
    // JSON once concatenated, so they are parsed at the end, never per delta.
    const openCalls = new Map<number, { id: string; name: string; argsJson: string }>();
    let stopReason: LlmResponse["stopReason"] | undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let reasoningText = "";

    const terminal = (): LlmStreamChunk => {
      const toolCalls: LlmToolCall[] = [...openCalls.entries()]
        .sort((a, b) => a[0] - b[0]) // by stream index, so order matches `complete`
        .map(([, c]) => ({ id: c.id, name: c.name, input: parseArguments(c.argsJson) }));
      return {
        delta: "",
        done: true,
        ...(toolCalls.length > 0 && { toolCalls }),
        ...(stopReason !== undefined && { stopReason }),
        ...(usage !== undefined && { usage }),
        ...(reasoningText !== "" && { reasoning: compatReasoning(reasoningText) }),
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
          const chunk = JSON.parse(json) as OpenAiChatResponse;
          // The usage-only chunk (`include_usage`) arrives AFTER the finished
          // choice and carries an empty `choices` array, so it must be read before
          // any early return on finish_reason — which is why the terminal chunk is
          // emitted at [DONE], not at the finish.
          if (chunk.usage !== undefined) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            };
          }
          const choice = chunk.choices[0];
          const delta = choice?.delta?.content ?? "";
          const reasoningDelta = readReasoningField(choice?.delta ?? {});
          reasoningText += reasoningDelta;
          const toolDeltas: NonNullable<LlmStreamChunk["toolDelta"]>[] = [];
          for (const tc of choice?.delta?.tool_calls ?? []) {
            const open = openCalls.get(tc.index) ?? { id: "", name: "", argsJson: "" };
            if (tc.id !== undefined) open.id = tc.id;
            if (tc.function?.name !== undefined) open.name = tc.function.name;
            if (tc.function?.arguments !== undefined) open.argsJson += tc.function.arguments;
            const first = !openCalls.has(tc.index);
            openCalls.set(tc.index, open);
            const inputDelta = tc.function?.arguments ?? "";
            if (first || inputDelta !== "") {
              toolDeltas.push({
                id: open.id,
                ...(first && { name: open.name }),
                inputDelta,
              });
            }
          }
          if (choice?.finish_reason != null) {
            stopReason = normalizeFinishReason(choice.finish_reason);
          }
          if (reasoningDelta !== "") yield { delta: "", done: false, reasoningDelta };
          if (delta !== "") {
            yield { delta, done: false };
          }
          for (const toolDelta of toolDeltas) yield { delta: "", done: false, toolDelta };
        } catch {
          // skip malformed SSE lines
        }
      }
    }

    // The stream ended without an explicit [DONE] (some gateways omit it): the
    // terminal chunk is still owed, or `assembleStream` would reject the stream.
    yield terminal();
  }
}
