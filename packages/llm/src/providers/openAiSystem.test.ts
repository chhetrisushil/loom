import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiProvider } from "./OpenAiProvider";

afterEach(() => vi.unstubAllGlobals());

function sentBody(fn: ReturnType<typeof vi.fn>): {
  messages: { role: string; content: unknown }[];
} {
  const init = fn.mock.calls[0]?.[1] as { body: string };
  return JSON.parse(init.body);
}

function stubJson(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () =>
      ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
      }) as unknown as Response
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function stubSse(): ReturnType<typeof vi.fn> {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\ndata: [DONE]\n`;
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

const USER = { role: "user" as const, content: "hello" };

describe("OpenAiProvider request.system", () => {
  it("complete sends request.system as the leading system message", async () => {
    const fn = stubJson();
    await new OpenAiProvider({ apiKey: "k" }).complete({ system: "be terse", messages: [USER] });
    expect(sentBody(fn).messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hello" },
    ]);
  });

  it("stream sends request.system as the leading system message", async () => {
    const fn = stubSse();
    for await (const _ of new OpenAiProvider({ apiKey: "k" }).stream({
      system: "be terse",
      messages: [USER],
    })) {
      // drain
    }
    expect(sentBody(fn).messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(sentBody(fn).messages).toHaveLength(2);
  });

  it("request.system wins over a system-role message, like Anthropic", async () => {
    const fn = stubJson();
    await new OpenAiProvider({ apiKey: "k" }).complete({
      system: "from request",
      messages: [{ role: "system", content: "from message" }, USER],
    });
    expect(sentBody(fn).messages).toEqual([
      { role: "system", content: "from request" },
      { role: "user", content: "hello" },
    ]);
  });

  it("a system-role message still works without request.system", async () => {
    const fn = stubJson();
    await new OpenAiProvider({ apiKey: "k" }).complete({
      messages: [{ role: "system", content: "from message" }, USER],
    });
    expect(sentBody(fn).messages).toEqual([
      { role: "system", content: "from message" },
      { role: "user", content: "hello" },
    ]);
  });
});
