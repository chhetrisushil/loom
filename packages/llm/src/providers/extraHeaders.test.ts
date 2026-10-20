import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "./AnthropicProvider";
import { GeminiProvider } from "./GeminiProvider";
import { OpenAiProvider } from "./OpenAiProvider";

afterEach(() => vi.unstubAllGlobals());

const emptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.close();
    },
  });

function stubFetch(json: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () => ({ ok: true, json: async () => json, body: emptyStream() }) as unknown as Response
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

const sent = (fn: ReturnType<typeof vi.fn>): Record<string, string> =>
  (fn.mock.calls[0]![1] as { headers: Record<string, string> }).headers;

const req = { messages: [{ role: "user" as const, content: "hi" }] };
const drain = async (it: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of it) {
    /* drain */
  }
};

interface Case {
  name: string;
  make: (headers?: Record<string, string>) => {
    complete: (r: typeof req) => Promise<unknown>;
    stream?: (r: typeof req) => AsyncIterable<unknown>;
  };
  response: unknown;
  protectedNames: string[];
}

const cases: Case[] = [
  {
    name: "AnthropicProvider",
    make: (headers) => new AnthropicProvider({ apiKey: "k", ...(headers && { headers }) }),
    response: {
      content: [{ type: "text", text: "x" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    protectedNames: ["x-api-key", "anthropic-version", "content-type", "Authorization"],
  },
  {
    name: "OpenAiProvider",
    make: (headers) => new OpenAiProvider({ apiKey: "k", ...(headers && { headers }) }),
    response: {
      choices: [{ message: { content: "x" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    protectedNames: ["authorization", "content-type", "Authorization"],
  },
  {
    name: "GeminiProvider",
    make: (headers) => new GeminiProvider({ apiKey: "k", ...(headers && { headers }) }),
    response: {
      candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }],
      usageMetadata: {},
    },
    protectedNames: ["x-goog-api-key", "content-type", "X-Goog-Api-Key", "authorization"],
  },
];

describe.each(cases)("$name extra headers", (c) => {
  it("sends them on complete", async () => {
    const f = stubFetch(c.response);
    await c.make({ "anthropic-workspace-id": "wrkspc_1" }).complete(req);
    expect(sent(f)["anthropic-workspace-id"]).toBe("wrkspc_1");
  });

  it("sends them on stream (when the provider streams)", async () => {
    const p = c.make({ "anthropic-workspace-id": "wrkspc_1" });
    if (p.stream === undefined) return;
    const f = stubFetch(c.response);
    await drain(p.stream(req));
    expect(sent(f)["anthropic-workspace-id"]).toBe("wrkspc_1");
  });

  it("unset leaves the request headers identical to empty", async () => {
    const f1 = stubFetch(c.response);
    await c.make().complete(req);
    const f2 = stubFetch(c.response);
    await c.make({}).complete(req);
    expect(sent(f2)).toEqual(sent(f1));
  });

  it.each(c.protectedNames)(
    "refuses to override %s (case-insensitive) without echoing the value",
    (name) => {
      expect(() => c.make({ [name]: "SECRET-VALUE-123" })).toThrow(/protected|owned/i);
      try {
        c.make({ [name]: "SECRET-VALUE-123" });
      } catch (e) {
        expect(String(e)).not.toContain("SECRET-VALUE-123");
      }
    }
  );

  it("refuses CR/LF in a name or value, without echoing the value", () => {
    expect(() => c.make({ "x-a": "v\r\nx-evil: 1" })).toThrow(/CR|LF|control/i);
    expect(() => c.make({ "x-a\nb": "v" })).toThrow(/CR|LF|control/i);
    try {
      c.make({ "x-a": "SECRET-VALUE-123\n" });
    } catch (e) {
      expect(String(e)).not.toContain("SECRET-VALUE-123");
    }
  });

  it("refuses a non-string value", () => {
    expect(() => c.make({ "x-a": 1 as unknown as string })).toThrow(/string/);
  });
});
