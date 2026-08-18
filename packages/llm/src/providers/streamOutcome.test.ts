import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleStream } from "../assembleStream";
import type { LlmStreamChunk } from "../types";
import { AnthropicProvider } from "./AnthropicProvider";
import { OpenAiProvider } from "./OpenAiProvider";

// ── R8 — the providers stop discarding the outcome ────────────────────────────
//
// Widening `LlmStreamChunk` changes nothing on its own: both providers ACTIVELY
// dropped the frames carrying tool calls and usage. Anthropic handled only
// `content_block_delta`/`text_delta`, ignoring `input_json_delta` (tool arguments)
// and `message_delta` (stop reason + output tokens); OpenAI read only
// `delta.content`, ignoring `delta.tool_calls` and never asking for usage at all.
//
// Both stream tool arguments as FRAGMENTS that are only valid JSON once
// concatenated, which is why these tests split the arguments across frames — a
// per-frame parse passes a single-fragment test and fails on the real thing.

afterEach(() => vi.unstubAllGlobals());

/** Stub `fetch` with an SSE body delivered in the given raw chunks. */
function stubSse(chunks: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({
          ok: true,
          body: {
            getReader() {
              let i = 0;
              const encoder = new TextEncoder();
              return {
                read: async () =>
                  i < chunks.length
                    ? { done: false, value: encoder.encode(chunks[i++]) }
                    : { done: true, value: undefined },
              };
            },
          },
        }) as unknown as Response
    )
  );
}

async function drain(stream: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

const sse = (event: unknown): string => `data: ${JSON.stringify(event)}\n`;

describe("AnthropicProvider.stream reports the outcome", () => {
  it("assembles text, tool calls from JSON fragments, stop reason and usage", async () => {
    stubSse([
      sse({ type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 0 } } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Look" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ing" } }),
      sse({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "lookup" },
      }),
      // Arguments split mid-token: neither fragment is valid JSON alone.
      sse({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"city":"Par' },
      }),
      sse({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: 'is"}' },
      }),
      sse({ type: "content_block_stop", index: 1 }),
      sse({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 9 },
      }),
      sse({ type: "message_stop" }),
    ]);

    const chunks = await drain(new AnthropicProvider({ apiKey: "k" }).stream({ messages: [] }));
    const res = assembleStream(chunks);

    expect(res.content).toBe("Looking");
    expect(res.toolCalls).toEqual([{ id: "toolu_1", name: "lookup", input: { city: "Paris" } }]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 9 });
  });

  it("treats a tool call with no argument deltas as {}", async () => {
    stubSse([
      sse({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t", name: "now" },
      }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_stop" }),
    ]);
    const res = assembleStream(
      await drain(new AnthropicProvider({ apiKey: "k" }).stream({ messages: [] }))
    );
    expect(res.toolCalls).toEqual([{ id: "t", name: "now", input: {} }]);
  });

  it("surfaces unparsable arguments instead of dropping the call", async () => {
    // The agent loop must be able to see WHY a call could not be made; a silently
    // dropped tool call looks like a model that chose not to act.
    stubSse([
      sse({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t", name: "broken" },
      }),
      sse({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{not json" },
      }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_stop" }),
    ]);
    const res = assembleStream(
      await drain(new AnthropicProvider({ apiKey: "k" }).stream({ messages: [] }))
    );
    expect(res.toolCalls?.[0]?.input).toEqual({ __unparsedArguments: "{not json" });
  });

  it("survives an SSE event split across network chunks", async () => {
    // The reader buffers a partial line; a provider that parsed per read() would
    // lose this event entirely.
    stubSse([
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_de',
      'lta","text":"split"}}\n',
      sse({ type: "message_stop" }),
    ]);
    const res = assembleStream(
      await drain(new AnthropicProvider({ apiKey: "k" }).stream({ messages: [] }))
    );
    expect(res.content).toBe("split");
  });
});

describe("OpenAiProvider.stream reports the outcome", () => {
  it("assembles text, indexed tool-call fragments, finish reason and usage", async () => {
    stubSse([
      sse({ choices: [{ delta: { content: "Look" } }] }),
      sse({ choices: [{ delta: { content: "ing" } }] }),
      sse({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup" } }] } },
        ],
      }),
      sse({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Par' } }] } },
        ],
      }),
      sse({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'is"}' } }] } }],
      }),
      sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      // The usage-only chunk arrives AFTER the finished choice, with no choices at
      // all — a provider that returned at finish_reason would never see it.
      sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 9 } }),
      "data: [DONE]\n",
    ]);

    const res = assembleStream(
      await drain(new OpenAiProvider({ apiKey: "k" }).stream({ messages: [] }))
    );

    expect(res.content).toBe("Looking");
    expect(res.toolCalls).toEqual([{ id: "call_1", name: "lookup", input: { city: "Paris" } }]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 9 });
  });

  it("orders parallel tool calls by stream index, matching complete()", async () => {
    stubSse([
      sse({
        choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "second" } }] } }],
      }),
      sse({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "first" } }] } }],
      }),
      "data: [DONE]\n",
    ]);
    const res = assembleStream(
      await drain(new OpenAiProvider({ apiKey: "k" }).stream({ messages: [] }))
    );
    expect(res.toolCalls?.map((t) => t.name)).toEqual(["first", "second"]);
  });

  it("requests usage on the stream, or there would be none to report", async () => {
    stubSse(["data: [DONE]\n"]);
    await drain(new OpenAiProvider({ apiKey: "k" }).stream({ messages: [] }));
    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0]![1] as { body: string }).body
    ) as Record<string, unknown>;
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("still terminates when the gateway omits [DONE]", async () => {
    // `assembleStream` refuses a stream with no terminal chunk, so a missing [DONE]
    // must not leave the caller holding an unterminated stream.
    stubSse([sse({ choices: [{ delta: { content: "hi" } }] })]);
    const chunks = await drain(new OpenAiProvider({ apiKey: "k" }).stream({ messages: [] }));
    expect(chunks[chunks.length - 1]?.done).toBe(true);
    expect(assembleStream(chunks).content).toBe("hi");
  });
});
