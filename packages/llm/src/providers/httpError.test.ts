import { afterEach, describe, expect, it, vi } from "vitest";
import { ERROR_BODY_READ_TIMEOUT_MS, LlmHttpError } from "../errors";
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

describe("LlmHttpError kind", () => {
  const MAKERS = [
    ["anthropic", () => new AnthropicProvider({ apiKey: "k" })],
    ["openai", () => new OpenAiProvider({ apiKey: "k" })],
    ["gemini", () => new GeminiProvider({ apiKey: "k" })],
  ] as const;

  it.each(MAKERS.flatMap(([n, m]) => [401, 403].map((s) => [n, m, s] as const)))(
    "%s %i is kind auth",
    async (_n, make, status) => {
      failing(status, "nope");
      const err = await make()
        .complete(ASK)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ status, kind: "auth" });
    }
  );

  it("a 429 or 500 has no kind", async () => {
    failing(429, "slow");
    const err = await new OpenAiProvider({ apiKey: "k" }).complete(ASK).catch((e: unknown) => e);
    expect((err as LlmHttpError).kind).toBeUndefined();
  });

  /** A real `Response`, so the body is a stream the provider reads. */
  const respond = (status: number, body: string, headers: Record<string, string> = {}) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status, headers }))
    );
  const gemini = (body: string) => {
    respond(400, body);
    return new GeminiProvider({ apiKey: "k" }).complete(ASK).catch((e: unknown) => e);
  };
  const info = (reason: string) =>
    JSON.stringify({
      error: {
        code: 400,
        message: "SECRET-PROMPT-ECHO",
        status: "INVALID_ARGUMENT",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com" },
        ],
      },
    });

  it("gemini 400 API_KEY_INVALID is kind auth and keeps no body text", async () => {
    const err = (await gemini(info("API_KEY_INVALID"))) as LlmHttpError;
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err).toMatchObject({ status: 400, kind: "auth" });
    expect(err.message).toBe("Gemini API error 400");
    expect(JSON.stringify(err)).not.toContain("SECRET-PROMPT-ECHO");
  });

  it("gemini 400 with another reason, a missing ErrorInfo or invalid JSON has no kind", async () => {
    for (const body of [info("SOMETHING_ELSE"), "{}", "not json", '{"error":{"details":"x"}}']) {
      const err = (await gemini(body)) as LlmHttpError;
      expect(err).toMatchObject({ status: 400 });
      expect(err.kind).toBeUndefined();
    }
  });

  it("gemini reads a 400 body only up to a bound", async () => {
    const big = `${info("API_KEY_INVALID")}${" ".repeat(200_000)}`;
    const err = (await gemini(big)) as LlmHttpError;
    expect(err.status).toBe(400);
    expect(err.kind).toBeUndefined();
  });

  it("gemini 400 with the reason on a non-ErrorInfo detail has no kind", async () => {
    const body = JSON.stringify({
      error: {
        details: [
          { "@type": "type.googleapis.com/google.rpc.BadRequest", reason: "API_KEY_INVALID" },
          { reason: "API_KEY_INVALID" },
        ],
      },
    });
    const err = (await gemini(body)) as LlmHttpError;
    expect(err).toMatchObject({ status: 400 });
    expect(err.kind).toBeUndefined();
  });

  it("gemini does not read the body of a non-400 error other than auth", async () => {
    const cancel = vi.fn(async () => undefined);
    const getReader = vi.fn();
    const text = vi.fn(async () => info("API_KEY_INVALID"));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ ok: false, status: 500, text, body: { cancel, getReader } }) as unknown as Response
      )
    );
    const err = (await new GeminiProvider({ apiKey: "k" })
      .complete(ASK)
      .catch((e) => e)) as LlmHttpError;
    expect(err.kind).toBeUndefined();
    expect(getReader).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  describe("a stalled 400 body", () => {
    const stalled = () => {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"error":'));
        },
        cancel,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(stream, { status: 400 }))
      );
      return cancel;
    };

    it("throws promptly without a signal once the read deadline passes, and cancels the body", async () => {
      vi.useFakeTimers();
      try {
        const cancel = stalled();
        const pending = new GeminiProvider({ apiKey: "k" }).complete(ASK).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(ERROR_BODY_READ_TIMEOUT_MS + 1);
        const err = (await pending) as LlmHttpError;
        expect(err).toMatchObject({ status: 400 });
        expect(err.kind).toBeUndefined();
        expect(cancel).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("also stops on the caller's signal before the deadline", async () => {
      const cancel = stalled();
      const ac = new AbortController();
      const pending = new GeminiProvider({ apiKey: "k" })
        .complete({ ...ASK, signal: ac.signal })
        .catch((e: unknown) => e);
      setTimeout(() => ac.abort(), 10);
      const err = (await pending) as LlmHttpError;
      expect(err).toMatchObject({ status: 400 });
      expect(err.kind).toBeUndefined();
      expect(cancel).toHaveBeenCalledTimes(1);
    });
  });
});
