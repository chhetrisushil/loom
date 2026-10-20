import type { EffectContext } from "@loom/effect-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLlmEffect } from "./createLlmEffect";
import { assistantMessageOf, layoutOf } from "./parts";
import { AnthropicProvider } from "./providers/AnthropicProvider";
import { GeminiProvider } from "./providers/GeminiProvider";

// ── ADR 0133 D5 — the vendor's block sequence round-trips EXACTLY ─────────────
//
// A thinking block's signature binds the blocks before it, so `thinking, text, tool_use, thinking,
// tool_use` must come back in that order, not regrouped. Through the real effect + provider with a
// stubbed fetch, streaming and not.

afterEach(() => vi.unstubAllGlobals());

const ctx = {
  executionId: "e",
  stepId: "s",
  workflowId: "wf",
  attempt: 1,
  emit() {},
} as unknown as EffectContext;

const MIXED = [
  { type: "thinking", thinking: "", signature: "SIG_A" },
  { type: "text", text: "Let me look." },
  { type: "tool_use", id: "t1", name: "lookup", input: { q: 1 } },
  { type: "thinking", thinking: "", signature: "SIG_B" },
  { type: "tool_use", id: "t2", name: "lookup", input: { q: 2 } },
];
const SPLIT_TEXT = [
  { type: "text", text: "one " },
  { type: "thinking", thinking: "", signature: "SIG_C" },
  { type: "text", text: "two" },
  { type: "tool_use", id: "t9", name: "lookup", input: {} },
];

const shape = (blocks: Record<string, unknown>[]): string[] =>
  blocks.map((b) =>
    b.type === "thinking"
      ? `thinking:${b.signature}`
      : b.type === "text"
        ? `text:${b.text}`
        : `${b.type}`
  );

function stubFetch(blocks: unknown[], streaming: boolean): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    if (!streaming) {
      return new Response(
        JSON.stringify({
          content: blocks,
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    const events: unknown[] = [
      { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
    ];
    (blocks as Record<string, unknown>[]).forEach((b, index) => {
      if (b.type === "thinking") {
        events.push({
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "" },
        });
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: b.signature },
        });
      } else if (b.type === "text") {
        events.push({
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        });
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: b.text },
        });
      } else {
        events.push({
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: b.id, name: b.name },
        });
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) },
        });
      }
      events.push({ type: "content_block_stop", index });
    });
    events.push({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 1 },
    });
    events.push({ type: "message_stop" });
    const body = events.map((e) => `data: ${JSON.stringify(e)}\n`).join("");
    let sent = false;
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new TextEncoder().encode(body) };
          },
        }),
      },
    } as unknown as Response;
  });
  return { bodies };
}

async function roundTrip(blocks: Record<string, unknown>[], streaming: boolean) {
  const { bodies } = stubFetch(blocks, streaming);
  const provider = new AnthropicProvider({ apiKey: "x", model: "claude-opus-5-5" });
  const eff = createLlmEffect({
    provider,
    buildRequest: (i: { messages: never[] }) => i,
    parseResponse: (r) => r,
    stream: streaming,
  });
  const first = await eff.execute({ messages: [{ role: "user", content: "hi" }] as never }, ctx);
  const asst = assistantMessageOf(first);
  const results = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ type: "tool_result", toolUseId: b.id, content: "r" }));
  await eff.execute(
    {
      messages: [
        { role: "user", content: "hi" },
        asst,
        { role: "user", content: results },
      ] as never,
    },
    ctx
  );
  const sent = (bodies[1]?.messages as { content: Record<string, unknown>[] }[])[1]?.content ?? [];
  return { first, sent };
}

describe.each([false, true])("Anthropic block order (streaming=%s)", (streaming) => {
  it("thinking, text, tool_use, thinking, tool_use comes back byte-identically ordered", async () => {
    const { sent } = await roundTrip(MIXED, streaming);
    expect(shape(sent)).toEqual(shape(MIXED));
    expect(sent.map((b) => (b.type === "tool_use" ? b.id : undefined))).toEqual(
      MIXED.map((b) => (b.type === "tool_use" ? b.id : undefined))
    );
  });

  it("text blocks the vendor returned separately keep their positions around a thinking block", async () => {
    const { sent } = await roundTrip(SPLIT_TEXT, streaming);
    expect(shape(sent)).toEqual(shape(SPLIT_TEXT));
  });

  it("the canonical order records NO layout (G2: today's step value, byte-identical)", async () => {
    const canonical = [
      { type: "thinking", thinking: "", signature: "S" },
      { type: "text", text: "hello" },
      { type: "tool_use", id: "c1", name: "lookup", input: {} },
    ];
    const { first, sent } = await roundTrip(canonical, streaming);
    expect("layout" in (first as object)).toBe(false);
    expect(shape(sent)).toEqual(shape(canonical));
  });

  it("no reasoning at all: no layout even when text follows a tool call", async () => {
    const plain = [
      { type: "tool_use", id: "c1", name: "lookup", input: {} },
      { type: "text", text: "after" },
    ];
    const { first } = await roundTrip(plain, streaming);
    expect("layout" in (first as object)).toBe(false);
    expect("reasoning" in (first as object)).toBe(false);
  });
});

describe("Gemini part order", () => {
  it("thought, text, functionCall, thought, functionCall round-trips in order", async () => {
    const parts = [
      { thought: true, text: "", thoughtSignature: "G_A" },
      { text: "looking" },
      { functionCall: { name: "lookup", args: { q: 1 } }, thoughtSignature: "F_1" },
      { thought: true, text: "", thoughtSignature: "G_B" },
      { functionCall: { name: "lookup", args: { q: 2 } }, thoughtSignature: "F_2" },
    ];
    const bodies: { contents: { parts: Record<string, unknown>[] }[] }[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts }, finishReason: "STOP" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const eff = createLlmEffect({
      provider: new GeminiProvider({ apiKey: "x", includeThoughts: true }),
      buildRequest: (i: { messages: never[] }) => i,
      parseResponse: (r) => r,
    });
    const first = await eff.execute({ messages: [{ role: "user", content: "hi" }] as never }, ctx);
    await eff.execute(
      {
        messages: [
          { role: "user", content: "hi" },
          assistantMessageOf(first),
          {
            role: "user",
            content: first.toolCalls?.map((c) => ({
              type: "tool_result",
              toolUseId: c.id,
              content: "r",
            })),
          },
        ] as never,
      },
      ctx
    );
    const kinds = (bodies[1]?.contents[1]?.parts ?? []).map((p) =>
      p.thought === true
        ? `thought:${p.thoughtSignature}`
        : p.functionCall
          ? `call:${p.thoughtSignature}`
          : `text:${p.text}`
    );
    expect(kinds).toEqual(["thought:G_A", "text:looking", "call:F_1", "thought:G_B", "call:F_2"]);
  });
});

describe("layoutOf / assistantMessageOf", () => {
  const rp = (sig: string) => ({
    type: "reasoning" as const,
    kind: "text" as const,
    provider: "anthropic",
    signature: sig,
  });

  it("canonical orders and reasoning-free responses yield no layout", () => {
    expect(layoutOf(["reasoning", { text: 3 }, { call: "a" }])).toBeUndefined();
    expect(layoutOf([{ text: 3 }, { call: "a" }, { text: 2 }])).toBeUndefined(); // no reasoning: nothing to protect
    expect(layoutOf(["reasoning", { text: 0 }, { call: "a" }])).toBeUndefined(); // empty text blocks are dropped
  });

  it("a non-canonical order is recorded as positions only", () => {
    expect(layoutOf(["reasoning", { call: "a" }, "reasoning", { call: "b" }])).toEqual([
      "reasoning",
      { call: "a" },
      "reasoning",
      { call: "b" },
    ]);
  });

  it("without a layout the message is exactly today's shape", () => {
    expect(
      assistantMessageOf({
        content: "hi",
        toolCalls: [{ id: "a", name: "n", input: {} }],
        reasoning: [rp("s")],
      })
    ).toEqual({
      role: "assistant",
      content: [
        rp("s"),
        { type: "text", text: "hi" },
        { type: "tool_use", id: "a", name: "n", input: {} },
      ],
    });
  });

  it("a layout that does not fit the content drops every reasoning part instead of reordering", () => {
    const m = assistantMessageOf({
      content: "hello",
      reasoning: [rp("s")],
      layout: [{ text: 2 }, "reasoning"],
    });
    expect(m.content.map((p) => p.type)).toEqual(["text"]);
  });

  it("a reasoning count that differs from the layout drops every reasoning part", () => {
    const m = assistantMessageOf({
      content: "",
      toolCalls: [{ id: "a", name: "n", input: {} }],
      reasoning: [rp("1"), rp("2")],
      layout: [{ call: "a" }, "reasoning"],
    });
    expect(m.content.map((p) => p.type)).toEqual(["tool_use"]);
  });

  it("a malformed layout entry (null, primitive) drops reasoning instead of throwing", () => {
    for (const bad of [null, 7, "x", {}] as unknown[]) {
      const m = assistantMessageOf({
        content: "hi",
        reasoning: [rp("1")],
        layout: ["reasoning", bad, { text: 2 }] as never,
      });
      expect(m.content.map((p) => p.type)).toEqual(["text"]);
    }
  });

  it("a named call that is missing drops the reasoning parts after it, keeps those before", () => {
    const m = assistantMessageOf({
      content: "",
      toolCalls: [{ id: "b", name: "n", input: {} }],
      reasoning: [rp("1"), rp("2")],
      layout: ["reasoning", { call: "gone" }, "reasoning", { call: "b" }],
    });
    expect(m.content.map((p) => (p.type === "tool_use" ? p.id : p.type))).toEqual([
      "reasoning",
      "b",
    ]);
  });

  it("calls the layout does not name (screened by the loop) keep their place at the end", () => {
    const m = assistantMessageOf({
      content: "",
      toolCalls: [
        { id: "a", name: "n", input: {} },
        { id: "b", name: "n", input: {} },
      ],
      reasoning: [rp("1"), rp("2")],
      layout: ["reasoning", { call: "a" }, "reasoning", { call: "zzz" }],
    });
    expect(m.content.map((p) => (p.type === "tool_use" ? p.id : p.type))).toEqual([
      "reasoning",
      "a",
      "reasoning",
      "b",
    ]);
  });
});
