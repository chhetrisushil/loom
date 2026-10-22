import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmMessage, LlmProvider, LlmRequest } from "../types";
import { AnthropicProvider } from "./AnthropicProvider";
import { GeminiProvider } from "./GeminiProvider";
import { OpenAiProvider } from "./OpenAiProvider";

afterEach(() => vi.unstubAllGlobals());

// One rule for all providers (see `LlmRequest.system`): a non-empty `request.system` wins and
// system-role messages are dropped; "" counts as unset; with no request.system the system-role
// messages are joined in order ("\n\n").
type Body = Record<string, unknown>;

/** Run `call` against a fetch that refuses, and return the request body that was sent. */
async function sent(call: () => Promise<unknown> | AsyncIterable<unknown>): Promise<Body> {
  const fn = vi.fn(async (_url: unknown, _init: unknown): Promise<Response> => {
    throw new Error("stop");
  });
  vi.stubGlobal("fetch", fn);
  try {
    const r = call();
    if (Symbol.asyncIterator in Object(r)) for await (const _ of r as AsyncIterable<unknown>);
    else await r;
  } catch {
    // the stub refuses; only the request matters
  }
  const init = fn.mock.calls[0]?.[1] as { body: string };
  return JSON.parse(init.body) as Body;
}

interface Case {
  name: string;
  make: () => LlmProvider;
  /** The system prompt as the provider put it on the wire, or undefined. */
  wire: (b: Body) => string | undefined;
  /** What a non-system message list looks like on the wire (system never leaks into it). */
  rest: (b: Body) => unknown[];
}

const cases: Case[] = [
  {
    name: "anthropic",
    make: () => new AnthropicProvider({ apiKey: "k" }),
    wire: (b) => b.system as string | undefined,
    rest: (b) => b.messages as unknown[],
  },
  {
    name: "openai",
    make: () => new OpenAiProvider({ apiKey: "k" }),
    wire: (b) => {
      const m = (b.messages as { role: string; content: string }[])[0];
      return m?.role === "system" ? m.content : undefined;
    },
    rest: (b) => (b.messages as { role: string }[]).filter((m) => m.role !== "system"),
  },
  {
    name: "gemini",
    make: () => new GeminiProvider({ apiKey: "k" }),
    wire: (b) => (b.systemInstruction as { parts: { text: string }[] } | undefined)?.parts[0]?.text,
    rest: (b) => b.contents as unknown[],
  },
];

const USER: LlmMessage = { role: "user", content: "hello" };
const sys = (content: string): LlmMessage => ({ role: "system", content });

for (const c of cases) {
  // GeminiProvider has no streaming path (complete only).
  for (const mode of c.name === "gemini"
    ? (["complete"] as const)
    : (["complete", "stream"] as const)) {
    describe(`${c.name} ${mode}: one system-prompt rule`, () => {
      const run = (req: LlmRequest) =>
        sent(() => {
          const p = c.make();
          return mode === "complete"
            ? p.complete(req)
            : (p.stream as NonNullable<typeof p.stream>)(req);
        });

      it("a non-empty request.system is sent, and system-role messages are dropped", async () => {
        const b = await run({ system: "from request", messages: [sys("from message"), USER] });
        expect(c.wire(b)).toBe("from request");
        expect(JSON.stringify(b)).not.toContain("from message");
        expect(c.rest(b)).toHaveLength(1);
      });

      it("an empty request.system counts as unset", async () => {
        const b = await run({ system: "", messages: [sys("from message"), USER] });
        expect(c.wire(b)).toBe("from message");
      });

      it("without request.system, system-role messages are joined in order", async () => {
        const b = await run({ messages: [sys("one"), USER, sys("two")] });
        expect(c.wire(b)).toBe("one\n\ntwo");
        expect(c.rest(b)).toHaveLength(1);
      });

      it("no system at all sends none", async () => {
        const b = await run({ system: "", messages: [USER] });
        expect(c.wire(b)).toBeUndefined();
      });
    });
  }
}
