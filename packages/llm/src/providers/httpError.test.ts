import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmHttpError } from "../errors";
import { AnthropicProvider } from "./AnthropicProvider";
import { GeminiProvider } from "./GeminiProvider";
import { OpenAiProvider } from "./OpenAiProvider";

afterEach(() => vi.unstubAllGlobals());

const failing = (status: number, body: string) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status, text: async () => body }) as unknown as Response)
  );
const ASK = { messages: [{ role: "user" as const, content: "Refund ticket 41?" }] };

describe("LlmHttpError", () => {
  it.each([
    ["anthropic", "Anthropic", () => new AnthropicProvider({ apiKey: "k" })],
    ["openai", "OpenAI", () => new OpenAiProvider({ apiKey: "k" })],
    ["gemini", "Gemini", () => new GeminiProvider({ apiKey: "k" })],
  ] as const)(
    "%s throws it from complete with the status and the unchanged message",
    async (provider, label, make) => {
      failing(429, "slow down");
      const err = await make()
        .complete(ASK)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmHttpError);
      expect(err).toMatchObject({ name: "LlmHttpError", status: 429, provider });
      expect((err as Error).message).toBe(`${label} API error 429`);
      expect(JSON.stringify(err)).not.toContain("slow down");
    }
  );

  it("throws it from a streamed request too", async () => {
    failing(503, "busy");
    const it = new OpenAiProvider({ apiKey: "k" }).stream(ASK)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toMatchObject({
      name: "LlmHttpError",
      status: 503,
      provider: "openai",
    });
  });
});
