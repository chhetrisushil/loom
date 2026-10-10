import type { LlmContentPart, LlmProvider, LlmRequest } from "@loom/llm";
import { expect, vi } from "vitest";

/**
 * The "a parts message is read as text" rule from {@link runLlmProviderConformance}, in its own
 * module (not re-exported from the package entry) so a naive provider can be driven directly in this
 * package's tests, where a factory cannot be nested inside the kit's own `it`.
 *
 * Since R5 `LlmMessage.content` is `string | LlmContentPart[]`, and `m.content` joined, interpolated
 * or put in an untyped `JSON.stringify` still type-checks: a parts message silently turns into
 * "[object Object]" or a JSON array. It was caught only by hand in several providers. This sends a
 * text-only parts message and fails when
 *   1. the content array or a part is COERCED to a string (each carries a non-enumerable `toString`
 *      trap, which `.join`, `${...}` and `String(...)` hit but `JSON.stringify` and a `typeof` branch
 *      do not), or
 *   2. an HTTP provider's wire body (observed at `fetch`, as the media rule does) contains
 *      "[object Object]", or does not carry each part's text.
 * A provider that never calls `fetch` is checked by (1) only.
 */
export async function checkPartsReadAsText(provider: LlmProvider): Promise<void> {
  const A = "PARTS-TEXT-ALPHA";
  const B = "PARTS-TEXT-BRAVO";
  const coerced: string[] = [];
  const trap = <T extends object>(target: T, label: string): T => {
    Object.defineProperty(target, "toString", {
      enumerable: false,
      value: () => {
        coerced.push(label);
        return "[object Object]";
      },
    });
    return target;
  };
  const parts: LlmContentPart[] = [
    trap({ type: "text", text: A }, "a text part"),
    trap({ type: "text", text: B }, "a text part"),
  ];
  trap(parts, "the content array");
  const request: LlmRequest = { messages: [{ role: "user", content: parts }] };

  const sent: string[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: unknown }) => {
    sent.push(String(init?.body ?? ""));
    return { ok: true, json: async () => ({}), text: async () => "", body: null } as Response;
  });
  try {
    await provider.complete(request).catch(() => undefined);
    if (provider.stream !== undefined) {
      try {
        for await (const _ of provider.stream(request)) void _;
      } catch {
        // a stub response is not a valid stream; only what was read and sent matters
      }
    }
  } finally {
    vi.unstubAllGlobals();
  }

  expect(
    coerced,
    "provider read LlmMessage.content raw (string-coerced a parts message); use textOf(content) or branch on typeof"
  ).toEqual([]);
  for (const body of sent) {
    expect(
      body,
      "provider sent '[object Object]': a parts message was coerced to a string"
    ).not.toContain("[object Object]");
    expect(body, "provider's request does not carry a text part's text").toContain(A);
    expect(body, "provider's request does not carry a text part's text").toContain(B);
  }
}
