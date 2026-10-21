import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmHttpError } from "../errors";
import { AnthropicProvider } from "./AnthropicProvider";
import { GeminiProvider } from "./GeminiProvider";
import { OpenAiProvider } from "./OpenAiProvider";

afterEach(() => vi.unstubAllGlobals());

/** A failing response whose body is observable: `cancel` and `text` are spies. */
const failing = (status: number, body: string) => {
  const cancel = vi.fn(async () => undefined);
  const text = vi.fn(async () => body);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status, text, body: { cancel } }) as unknown as Response)
  );
  return { cancel, text };
};
const ASK = { messages: [{ role: "user" as const, content: "Refund ticket 41?" }] };

describe("LlmHttpError", () => {
  const MAKERS = [
    ["anthropic", "Anthropic", () => new AnthropicProvider({ apiKey: "k" })],
    ["openai", "OpenAI", () => new OpenAiProvider({ apiKey: "k" })],
    ["gemini", "Gemini", () => new GeminiProvider({ apiKey: "k" })],
  ] as const;

  it.each(MAKERS)(
    "%s throws it from complete with the status and a body-free message, and drains the body",
    async (provider, label, make) => {
      const spy = failing(429, "slow down");
      const err = await make()
        .complete(ASK)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmHttpError);
      expect(err).toMatchObject({ name: "LlmHttpError", status: 429, provider });
      expect((err as Error).message).toBe(`${label} API error 429`);
      expect(JSON.stringify(err)).not.toContain("slow down");
      expect(spy.text).not.toHaveBeenCalled();
      expect(spy.cancel).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ["openai", () => new OpenAiProvider({ apiKey: "k" })],
    ["anthropic", () => new AnthropicProvider({ apiKey: "k" })],
  ] as const)(
    "%s throws it from a streamed request too, draining the body",
    async (provider, make) => {
      const spy = failing(503, "busy");
      const it = make().stream(ASK)[Symbol.asyncIterator]();
      await expect(it.next()).rejects.toMatchObject({
        name: "LlmHttpError",
        status: 503,
        provider,
      });
      expect(spy.text).not.toHaveBeenCalled();
      expect(spy.cancel).toHaveBeenCalledTimes(1);
    }
  );

  it("a body that cannot be cancelled does not mask the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 500,
            body: { cancel: async () => Promise.reject(new Error("boom")) },
          }) as unknown as Response
      )
    );
    await expect(new OpenAiProvider({ apiKey: "k" }).complete(ASK)).rejects.toMatchObject({
      status: 500,
    });
  });
});
