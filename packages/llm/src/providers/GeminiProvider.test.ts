import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "./GeminiProvider";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(json: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({ ok: true, json: async () => json }) as unknown as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("GeminiProvider", () => {
  it("translates roles + system to Gemini's shape and reads back the text", async () => {
    const fetchFn = stubFetch({
      candidates: [{ content: { parts: [{ text: "hello world" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    });
    const provider = new GeminiProvider({ apiKey: "k", model: "gemini-2.0-flash" });

    const res = await provider.complete({
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "prior" },
      ],
      temperature: 0,
    });

    expect(res.content).toBe("hello world");
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 2 });

    // Verify the request mapping: system → systemInstruction, assistant → "model" role.
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as { body: string }).body);
    expect(body.systemInstruction.parts[0].text).toBe("be terse");
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "prior" }] },
    ]);
    expect(body.generationConfig.temperature).toBe(0);
    // The URL targets the configured model + the API key rides the header.
    expect(fetchFn.mock.calls[0]![0]).toContain("gemini-2.0-flash:generateContent");
  });

  it("maps a MAX_TOKENS finish to max_tokens", async () => {
    stubFetch({
      candidates: [{ content: { parts: [{ text: "…" }] }, finishReason: "MAX_TOKENS" }],
    });
    const res = await new GeminiProvider({ apiKey: "k" }).complete({ messages: [], maxTokens: 1 });
    expect(res.stopReason).toBe("max_tokens");
  });

  it("sends thinkingBudget, merged with includeThoughts, and nothing when unset", async () => {
    const fetchFn = stubFetch({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    });
    await new GeminiProvider({ apiKey: "k", thinkingBudget: 0, includeThoughts: true }).complete({
      messages: [{ role: "user", content: "hi" }],
    });
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as { body: string }).body);
    expect(body.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 0,
    });

    const plain = stubFetch({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    });
    await new GeminiProvider({ apiKey: "k" }).complete({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(JSON.parse((plain.mock.calls[0]![1] as { body: string }).body)).not.toHaveProperty(
      "generationConfig"
    );
  });

  it("refuses a bad thinkingBudget at construction", () => {
    for (const bad of [-2, 1.5, Number.NaN])
      expect(() => new GeminiProvider({ apiKey: "k", thinkingBudget: bad })).toThrow(
        /^thinkingBudget must be an integer >= -1 \(-1 = dynamic\)$/
      );
  });

  it("accepts -1 (dynamic thinking) and sends it", async () => {
    const f = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }],
          }),
        }) as unknown as Response
    );
    vi.stubGlobal("fetch", f);
    await new GeminiProvider({ apiKey: "k", thinkingBudget: -1 }).complete({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(
      JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body)
        .generationConfig.thinkingConfig.thinkingBudget
    ).toBe(-1);
  });
});
