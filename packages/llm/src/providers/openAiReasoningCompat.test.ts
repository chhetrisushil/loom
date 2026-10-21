import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiProvider } from "./OpenAiProvider";

afterEach(() => vi.unstubAllGlobals());

function stubJson(json: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({ ok: true, json: async () => json }) as unknown as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function stubSse(events: unknown[]): void {
  const body = `${events.map((e) => `data: ${JSON.stringify(e)}\n`).join("")}data: [DONE]\n`;
  vi.stubGlobal(
    "fetch",
    vi.fn(
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
    )
  );
}

const ASK = { messages: [{ role: "user" as const, content: "Is the invoice paid?" }] };

describe("OpenAiProvider reasoning on OpenAI-compatible servers", () => {
  it("reads `reasoning` from a completed response", async () => {
    stubJson({
      choices: [
        { message: { content: "yes", reasoning: "checked the ledger" }, finish_reason: "stop" },
      ],
    });
    const res = await new OpenAiProvider({ apiKey: "k" }).complete(ASK);
    expect(res.reasoning).toEqual([
      { kind: "text", text: "checked the ledger", provider: "openai-compat" },
    ]);
  });

  it("still reads `reasoning_content`, which wins when both are present", async () => {
    stubJson({
      choices: [
        {
          message: { content: "yes", reasoning_content: "a", reasoning: "b" },
          finish_reason: "stop",
        },
      ],
    });
    const res = await new OpenAiProvider({ apiKey: "k" }).complete(ASK);
    expect(res.reasoning?.[0]?.text).toBe("a");
  });

  it("streams `reasoning` deltas and reports the assembled reasoning on the terminal chunk", async () => {
    stubSse([
      { choices: [{ delta: { reasoning: "check " } }] },
      { choices: [{ delta: { reasoning: "ledger" } }] },
      { choices: [{ delta: { content: "yes" }, finish_reason: "stop" }] },
    ]);
    const chunks = [];
    for await (const c of new OpenAiProvider({ apiKey: "k" }).stream(ASK)) chunks.push(c);
    expect(
      chunks.filter((c) => c.reasoningDelta !== undefined).map((c) => c.reasoningDelta)
    ).toEqual(["check ", "ledger"]);
    expect(chunks.at(-1)?.reasoning).toEqual([
      { kind: "text", text: "check ledger", provider: "openai-compat" },
    ]);
  });

  it("sends reasoning_effort only when configured", async () => {
    const withEffort = stubJson({
      choices: [{ message: { content: "x" }, finish_reason: "stop" }],
    });
    await new OpenAiProvider({ apiKey: "k", reasoningEffort: "low" }).complete(ASK);
    expect(
      JSON.parse((withEffort.mock.calls[0]?.[1] as { body: string }).body).reasoning_effort
    ).toBe("low");
    const without = stubJson({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] });
    await new OpenAiProvider({ apiKey: "k" }).complete(ASK);
    expect(JSON.parse((without.mock.calls[0]?.[1] as { body: string }).body)).not.toHaveProperty(
      "reasoning_effort"
    );
  });
});
