import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmReasoningPart } from "../parts";
import type { LlmStreamChunk } from "../types";
import { AnthropicProvider } from "./AnthropicProvider";
import { GeminiProvider } from "./GeminiProvider";
import { OpenAiProvider } from "./OpenAiProvider";

// ── ADR 0133 D2 — each provider's reasoning mapping, both directions ──────────
//
// Recorded-shape bodies only: no live network call anywhere.

afterEach(() => vi.unstubAllGlobals());

function stubJson(json: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({ ok: true, json: async () => json }) as unknown as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function stubSse(events: unknown[]): ReturnType<typeof vi.fn> {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n`).join("");
  const fn = vi.fn(
    async () =>
      ({
        ok: true,
        body: {
          getReader() {
            let sent = false;
            return {
              read: async () => {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: new TextEncoder().encode(body) };
              },
            };
          },
        },
      }) as unknown as Response
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function drain(stream: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

const sentBody = (
  fn: ReturnType<typeof vi.fn>
): { messages: { content: unknown }[]; contents: unknown[]; systemInstruction?: unknown } =>
  JSON.parse((fn.mock.calls[0]?.[1] as { body: string }).body);

const part = (over: Partial<LlmReasoningPart>): LlmReasoningPart => ({
  type: "reasoning",
  kind: "summary",
  provider: "anthropic",
  ...over,
});

describe("AnthropicProvider reasoning", () => {
  const response = {
    content: [
      { type: "thinking", thinking: "weighing the options", signature: "sig-1" },
      { type: "thinking", thinking: "", signature: "sig-2" },
      { type: "redacted_thinking", data: "opaque-3" },
      { type: "text", text: "done" },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 2 },
  };

  it("declares capabilities.reasoning", () => {
    expect(new AnthropicProvider({ apiKey: "k" }).capabilities.reasoning).toBe(true);
  });

  it("pins ONE rule: non-empty text is a summary, empty is text '', redacted keeps its data as signature", async () => {
    stubJson(response);
    const res = await new AnthropicProvider({ apiKey: "k" }).complete({ messages: [] });
    expect(res.content).toBe("done"); // reasoning never leaks into the answer text
    expect(res.reasoning).toEqual([
      { kind: "summary", text: "weighing the options", signature: "sig-1", provider: "anthropic" },
      { kind: "text", text: "", signature: "sig-2", provider: "anthropic" },
      { kind: "redacted", signature: "opaque-3", provider: "anthropic" },
    ]);
  });

  it("a response with no thinking block reports no reasoning key at all (G2)", async () => {
    stubJson({ ...response, content: [{ type: "text", text: "x" }] });
    const res = await new AnthropicProvider({ apiKey: "k" }).complete({ messages: [] });
    expect("reasoning" in res).toBe(false);
  });

  it("streams thinking_delta as reasoningDelta and assembles the same reasoning as complete", async () => {
    stubSse([
      { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "weighing " },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "the options" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-1" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "signature_delta", signature: "sig-2" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "redacted_thinking", data: "opaque-3" },
      },
      { type: "content_block_stop", index: 2 },
      { type: "content_block_start", index: 3, content_block: { type: "text" } },
      { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "done" } },
      { type: "content_block_stop", index: 3 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]);
    const chunks = await drain(new AnthropicProvider({ apiKey: "k" }).stream({ messages: [] }));
    expect(
      chunks.flatMap((c) => (c.reasoningDelta !== undefined ? [c.reasoningDelta] : []))
    ).toEqual(["weighing ", "the options"]);
    // reasoning is NOT in the text deltas
    expect(chunks.map((c) => c.delta).join("")).toBe("done");
    const terminal = chunks[chunks.length - 1];
    expect(terminal?.done).toBe(true);
    expect(terminal?.reasoning).toEqual([
      { kind: "summary", text: "weighing the options", signature: "sig-1", provider: "anthropic" },
      { kind: "text", text: "", signature: "sig-2", provider: "anthropic" },
      { kind: "redacted", signature: "opaque-3", provider: "anthropic" },
    ]);
  });

  it("sends our parts back UNCHANGED, before text and tool_use, in recorded order", async () => {
    const fn = stubJson({
      content: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await new AnthropicProvider({ apiKey: "k" }).complete({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool_use", id: "t1", name: "lookup", input: { q: 1 } },
            part({ signature: "sig-1", text: "weighing the options" }),
            part({ kind: "text", signature: "sig-2" }),
            part({ kind: "redacted", signature: "opaque-3" }),
          ],
        },
      ],
    });
    expect(sentBody(fn).messages[1]?.content).toEqual([
      { type: "thinking", thinking: "weighing the options", signature: "sig-1" },
      { type: "thinking", thinking: "", signature: "sig-2" },
      { type: "redacted_thinking", data: "opaque-3" },
      { type: "text", text: "calling" },
      { type: "tool_use", id: "t1", name: "lookup", input: { q: 1 } },
    ]);
  });

  it("omits a part from another provider (its signature means nothing here)", async () => {
    const fn = stubJson({
      content: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await new AnthropicProvider({ apiKey: "k" }).complete({
      messages: [
        {
          role: "assistant",
          content: [part({ provider: "gemini", signature: "g" }), { type: "text", text: "hi" }],
        },
      ],
    });
    expect(sentBody(fn).messages[0]?.content).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("GeminiProvider reasoning", () => {
  it("declares capabilities.reasoning", () => {
    expect(new GeminiProvider({ apiKey: "k" }).capabilities.reasoning).toBe(true);
  });

  it("maps thought parts to summaries, keeps them out of content, and reads a functionCall's thoughtSignature", async () => {
    stubJson({
      candidates: [
        {
          content: {
            parts: [
              { text: "checking the ticket", thought: true, thoughtSignature: "gsig-1" },
              { text: "answer" },
              { functionCall: { name: "lookup", args: { q: 1 } }, thoughtSignature: "gsig-2" },
            ],
          },
          finishReason: "STOP",
        },
      ],
    });
    const res = await new GeminiProvider({ apiKey: "k" }).complete({ messages: [] });
    expect(res.content).toBe("answer");
    expect(res.reasoning).toEqual([
      { kind: "summary", text: "checking the ticket", signature: "gsig-1", provider: "gemini" },
    ]);
    expect(res.toolCalls).toEqual([
      { id: "gemini-call-0", name: "lookup", input: { q: 1 }, signature: "gsig-2" },
    ]);
  });

  it("no thought part and no signature: no reasoning key, no signature key (G2)", async () => {
    stubJson({
      candidates: [{ content: { parts: [{ functionCall: { name: "f", args: {} } }] } }],
    });
    const res = await new GeminiProvider({ apiKey: "k" }).complete({ messages: [] });
    expect("reasoning" in res).toBe(false);
    expect(res.toolCalls?.[0] && "signature" in res.toolCalls[0]).toBe(false);
  });

  it("sends tool_use signatures back on the functionCall part and our thought parts back as thought parts", async () => {
    const fn = stubJson({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    await new GeminiProvider({ apiKey: "k" }).complete({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            part({ provider: "gemini", signature: "gsig-1", text: "checking the ticket" }),
            part({ provider: "anthropic", signature: "other" }),
            {
              type: "tool_use",
              id: "gemini-call-0",
              name: "lookup",
              input: { q: 1 },
              signature: "gsig-2",
            },
          ],
        },
      ],
    });
    expect(sentBody(fn).contents[1]).toEqual({
      role: "model",
      parts: [
        { text: "checking the ticket", thought: true, thoughtSignature: "gsig-1" },
        { functionCall: { name: "lookup", args: { q: 1 } }, thoughtSignature: "gsig-2" },
      ],
    });
  });
});

describe("OpenAiProvider reasoning_content (OpenAI-compatible servers)", () => {
  it("does NOT declare capabilities.reasoning", () => {
    expect(new OpenAiProvider({ apiKey: "k" }).capabilities.reasoning).toBeUndefined();
  });

  it("maps message.reasoning_content to a text reasoning from openai-compat", async () => {
    stubJson({
      choices: [
        {
          message: { content: "answer", reasoning_content: "let me think" },
          finish_reason: "stop",
        },
      ],
    });
    const res = await new OpenAiProvider({ apiKey: "k" }).complete({ messages: [] });
    expect(res.content).toBe("answer");
    expect(res.reasoning).toEqual([
      { kind: "text", text: "let me think", provider: "openai-compat" },
    ]);
  });

  it("no reasoning_content: no reasoning key (G2)", async () => {
    stubJson({ choices: [{ message: { content: "answer" }, finish_reason: "stop" }] });
    const res = await new OpenAiProvider({ apiKey: "k" }).complete({ messages: [] });
    expect("reasoning" in res).toBe(false);
  });

  it("streams delta.reasoning_content as reasoningDelta; the terminal chunk equals complete", async () => {
    stubSse([
      { choices: [{ delta: { reasoning_content: "let me " } }] },
      { choices: [{ delta: { reasoning_content: "think" } }] },
      { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] },
    ]);
    const chunks = await drain(new OpenAiProvider({ apiKey: "k" }).stream({ messages: [] }));
    expect(
      chunks.flatMap((c) => (c.reasoningDelta !== undefined ? [c.reasoningDelta] : []))
    ).toEqual(["let me ", "think"]);
    expect(chunks.map((c) => c.delta).join("")).toBe("answer");
    expect(chunks[chunks.length - 1]?.reasoning).toEqual([
      { kind: "text", text: "let me think", provider: "openai-compat" },
    ]);
  });

  it("never sends reasoning back (no documented request shape)", async () => {
    const fn = stubJson({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    await new OpenAiProvider({ apiKey: "k" }).complete({
      messages: [
        {
          role: "assistant",
          content: [
            part({ provider: "openai-compat", kind: "text", text: "secret thoughts" }),
            { type: "text", text: "hi" },
          ],
        },
      ],
    });
    expect(JSON.stringify(sentBody(fn))).not.toContain("secret thoughts");
    expect(sentBody(fn).messages[0]).toEqual({ role: "assistant", content: "hi" });
  });
});

describe("provider thinking config (ADR 0133)", () => {
  const ok = {
    content: [{ type: "text", text: "x" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const body = (fn: ReturnType<typeof vi.fn>): Record<string, unknown> =>
    JSON.parse((fn.mock.calls[0]?.[1] as { body: string }).body);

  it("Anthropic passes `thinking` through to the request body", async () => {
    const fn = stubJson(ok);
    await new AnthropicProvider({
      apiKey: "k",
      thinking: { type: "adaptive", display: "summarized" },
    }).complete({ messages: [] });
    expect(body(fn).thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("Anthropic sends no `thinking` key when unset (G2)", async () => {
    const fn = stubJson(ok);
    await new AnthropicProvider({ apiKey: "k" }).complete({ messages: [] });
    expect("thinking" in body(fn)).toBe(false);
  });

  it("Gemini maps includeThoughts to generationConfig.thinkingConfig", async () => {
    const fn = stubJson({ candidates: [{ content: { parts: [{ text: "x" }] } }] });
    await new GeminiProvider({ apiKey: "k", includeThoughts: true }).complete({ messages: [] });
    expect(body(fn).generationConfig).toEqual({ thinkingConfig: { includeThoughts: true } });
  });

  it("Gemini sends no thinkingConfig when unset (G2)", async () => {
    const fn = stubJson({ candidates: [{ content: { parts: [{ text: "x" }] } }] });
    await new GeminiProvider({ apiKey: "k" }).complete({ messages: [] });
    expect("generationConfig" in body(fn)).toBe(false);
  });
});
