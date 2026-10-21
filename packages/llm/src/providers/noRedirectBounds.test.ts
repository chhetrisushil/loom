import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmHttpError, LlmResponseInvalidError, LlmResponseLimitError } from "../errors";
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
        // a redirect is a typed, non-retryable HTTP error (not a network error), body drained
        const err = await run().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(LlmHttpError);
        expect(err).toMatchObject({ status: 307, retryable: false });
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
          maxStreamBytes: shape === "total" ? 1000 : 10_000,
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

describe.each(makers)("%s: response hardening", (name, make) => {
  const stub = (body: BodyInit) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 }))
    );

  it("a non-JSON 2xx body is a fixed-message typed error with no body text and no cause", async () => {
    stub("SENTINEL-SECRET <html>");
    const err = (await make("http://x.invalid")
      .complete(REQ)
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(LlmResponseInvalidError);
    expect(err.message).not.toMatch(/SENTINEL|SECRET/);
    expect(err.cause).toBeUndefined();
  });

  it("an oversized Content-Length is rejected before reading, and the body is cancelled", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream({ pull() {}, cancel }), {
            status: 200,
            headers: { "content-length": "5000" },
          })
      )
    );
    const err = await make("http://x.invalid", { maxResponseBytes: 1000 })
      .complete(REQ)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmResponseLimitError);
    expect((err as LlmResponseLimitError).reason).toBe("body");
    expect(cancel).toHaveBeenCalled();
  });

  it("the cap applies to DECODED bytes: a small gzip body that inflates past the cap is refused", async () => {
    const big = JSON.stringify({ pad: "a".repeat(50_000) });
    const gz = gzipSync(big);
    expect(gz.length).toBeLessThan(1000);
    const server = await listen(
      () => undefined,
      (_q, res) => {
        res.writeHead(200, { "content-encoding": "gzip", "content-type": "application/json" });
        res.end(gz);
      }
    );
    const err = await make(server, { maxResponseBytes: 1000 })
      .complete(REQ)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmResponseLimitError);
    expect((err as LlmResponseLimitError).provider).toBe(name);
  });

  it.skipIf(name === "gemini")(
    "a stream is not cut at the complete-body cap: maxStreamBytes is separate and larger",
    async () => {
      const line = new TextEncoder().encode(`: ${"p".repeat(98)}\n`);
      let n = 0;
      const mk = () =>
        new Response(
          new ReadableStream({
            pull(c) {
              if (n++ < 30) c.enqueue(line);
              else c.close();
            },
          }),
          { status: 200 }
        );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => mk())
      );
      // 3000 bytes streamed with a 1000-byte complete cap: fine
      const ok = make("http://x.invalid", { maxResponseBytes: 1000 });
      for await (const _c of ok.stream!(REQ)) void _c;
      n = 0;
      const tight = make("http://x.invalid", { maxStreamBytes: 1000 } as never);
      const err = await (async () => {
        try {
          for await (const _c of tight.stream!(REQ)) void _c;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(LlmResponseLimitError);
      expect((err as LlmResponseLimitError).reason).toBe("stream");
    }
  );

  it.skipIf(name === "gemini")("maxLineBytes counts UTF-8 bytes, not UTF-16 units", async () => {
    // 40 characters of 3 bytes each = 120 bytes on the wire
    const chunk = new TextEncoder().encode(`: ${"\u20ac".repeat(40)}\n`);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(c) {
                c.enqueue(chunk);
              },
            }),
            { status: 200 }
          )
      )
    );
    const p = make("http://x.invalid", { maxLineBytes: 100 } as never);
    const err = await (async () => {
      try {
        for await (const _c of p.stream!(REQ)) void _c;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(LlmResponseLimitError);
    expect((err as LlmResponseLimitError).reason).toBe("line");
  });
});
