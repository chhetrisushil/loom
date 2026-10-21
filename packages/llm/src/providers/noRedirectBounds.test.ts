import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmResponseLimitError } from "../errors";
import type { LlmProvider } from "../types";
import { AnthropicProvider } from "./AnthropicProvider";
import { GeminiProvider } from "./GeminiProvider";
import { OpenAiProvider } from "./OpenAiProvider";

const servers: Server[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const s of servers.splice(0)) s.close();
});

async function listen(
  handler: (req: IncomingMessage) => void | Promise<void>,
  onReq: Parameters<typeof createServer>[1]
) {
  void handler;
  const s = createServer(onReq);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const REQ = { messages: [{ role: "user" as const, content: "secret prompt" }] };

const makers: Array<
  [string, (baseUrl: string, extra?: { maxResponseBytes?: number }) => LlmProvider]
> = [
  ["openai", (baseUrl, e) => new OpenAiProvider({ apiKey: "k", baseUrl, ...e })],
  ["gemini", (baseUrl, e) => new GeminiProvider({ apiKey: "k", baseUrl, ...e })],
  ["anthropic", (baseUrl, e) => new AnthropicProvider({ apiKey: "k", baseUrl, ...e })],
];

describe.each(makers)("%s: no redirects", (name, make) => {
  for (const mode of ["complete", "stream"] as const) {
    it.skipIf(mode === "stream" && name === "gemini")(
      `${mode}: a 307 is never followed`,
      async () => {
        let second = 0;
        const target = await listen(
          () => undefined,
          (_q, res) => {
            second++;
            res.end("{}");
          }
        );
        const first = await listen(
          () => undefined,
          (_q, res) => {
            res.writeHead(307, { location: `${target}/stolen` });
            res.end();
          }
        );
        const p = make(first);
        const run = async () => {
          if (mode === "complete") await p.complete(REQ);
          else for await (const _c of p.stream!(REQ)) void _c;
        };
        await expect(run()).rejects.toThrow();
        expect(second).toBe(0);
      }
    );
  }
});

describe.each(makers)("%s: bounded responses", (name, make) => {
  it("complete: an oversized body is a typed error and the body is cancelled", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(64).fill(32);
    let sent = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(c) {
                c.enqueue(chunk);
                sent += chunk.length;
              },
              cancel,
            }),
            { status: 200 }
          )
      )
    );
    const err = await make("http://x.invalid", { maxResponseBytes: 1000 })
      .complete(REQ)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmResponseLimitError);
    expect((err as LlmResponseLimitError).provider).toBe(name);
    expect((err as Error).message).not.toMatch(/secret/);
    expect(cancel).toHaveBeenCalled();
    expect(sent).toBeLessThan(10_000);
  });

  it.skipIf(name === "gemini")(
    "stream: too many total bytes, and an over-long line, are typed errors and cancel",
    async () => {
      for (const shape of ["total", "line"] as const) {
        const cancel = vi.fn();
        const chunk = new TextEncoder().encode(
          shape === "total" ? `data: {}\n${": pad\n".repeat(20)}` : `data: ${"x".repeat(60)}`
        );
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                new ReadableStream({
                  pull(c) {
                    c.enqueue(chunk);
                  },
                  cancel,
                }),
                { status: 200 }
              )
          )
        );
        const p = make("http://x.invalid", {
          maxResponseBytes: shape === "total" ? 1000 : 10_000,
          ...(shape === "line" ? { maxLineBytes: 100 } : {}),
        } as never);
        const err = await (async () => {
          try {
            for await (const _c of p.stream!(REQ)) void _c;
          } catch (e) {
            return e;
          }
        })();
        expect(err).toBeInstanceOf(LlmResponseLimitError);
        expect(cancel).toHaveBeenCalled();
      }
    }
  );
});
