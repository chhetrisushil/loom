import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmStreamError } from "../errors";
import { AnthropicProvider } from "./AnthropicProvider";
import { OpenAiProvider } from "./OpenAiProvider";

afterEach(() => vi.unstubAllGlobals());

/** An SSE body in one read; `cancel` records whether the reader was released early. */
function stubSse(lines: string[]) {
  const cancel = vi.fn(async () => undefined);
  const body = `${lines.join("\n")}\n`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
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
            cancel,
          }),
        },
      } as unknown as Response;
    })
  );
  return { cancel };
}

const ASK = { messages: [{ role: "user" as const, content: "Is the invoice paid?" }] };
const data = (o: unknown) => `data: ${JSON.stringify(o)}`;

describe("stream reader release", () => {
  it("OpenAI cancels the reader when the consumer breaks early", async () => {
    const spy = stubSse([
      data({ choices: [{ delta: { content: "a" } }] }),
      data({ choices: [{ delta: { content: "b" } }] }),
    ]);
    for await (const _ of new OpenAiProvider({ apiKey: "k" }).stream(ASK)) break;
    expect(spy.cancel).toHaveBeenCalled();
  });

  it("Anthropic cancels the reader when the consumer breaks early", async () => {
    const spy = stubSse([
      data({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } }),
      data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "b" } }),
    ]);
    for await (const _ of new AnthropicProvider({ apiKey: "k" }).stream(ASK)) break;
    expect(spy.cancel).toHaveBeenCalled();
  });
});

describe("mid-stream error events", () => {
  it("Anthropic surfaces an `error` event as LlmStreamError with the error type only", async () => {
    stubSse([
      data({ type: "error", error: { type: "overloaded_error", message: "secret prompt echo" } }),
    ]);
    const it = new AnthropicProvider({ apiKey: "k" }).stream(ASK);
    const err = await (async () => {
      for await (const _ of it);
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmStreamError);
    expect(err).toMatchObject({ provider: "anthropic", code: "overloaded_error" });
    expect((err as Error).message).toBe("Anthropic stream error: overloaded_error");
    expect(JSON.stringify(err)).not.toContain("secret");
  });

  it("OpenAI surfaces an `error` chunk as LlmStreamError with the code only", async () => {
    stubSse([data({ error: { code: "server_error", message: "secret prompt echo" } })]);
    const err = await (async () => {
      for await (const _ of new OpenAiProvider({ apiKey: "k" }).stream(ASK));
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmStreamError);
    expect((err as Error).message).toBe("OpenAI stream error: server_error");
    expect(JSON.stringify(err)).not.toContain("secret");
  });

  it("an error type that is not a plain identifier is reported as `unknown`", async () => {
    stubSse([data({ error: { type: "has spaces and text", message: "x" } })]);
    const err = await (async () => {
      for await (const _ of new OpenAiProvider({ apiKey: "k" }).stream(ASK));
    })().catch((e: unknown) => e);
    expect((err as Error).message).toBe("OpenAI stream error: unknown");
  });
});
