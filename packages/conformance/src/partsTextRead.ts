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
 *   1. a part is COERCED to a string (each part carries a non-enumerable `toString` trap, which
 *      `.join`, `${...}` and `String(...)` hit but `JSON.stringify` and a `typeof` branch do not;
 *      the array needs no trap of its own, because `Array.prototype.toString` joins and so reaches
 *      the part traps), or
 *   2. an HTTP provider's wire body (observed at `fetch`, as the media rule does) is a string that
 *      contains "[object Object]", or NO request body carries each part's text.
 * Only string bodies (and a `Request`'s readable text) are judged: an auxiliary fetch (auth,
 * `count_tokens`), a FormData / stream body, or a `fetch(new Request(..))` with no `init.body` is
 * neither a failure nor evidence. A provider that never sends a judgeable body is checked by (1) only.
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
  const request: LlmRequest = { messages: [{ role: "user", content: parts }] };

  const sent: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: { body?: unknown }) => {
    if (typeof init?.body === "string") {
      sent.push(init.body);
    } else if (
      init?.body === undefined &&
      typeof Request !== "undefined" &&
      input instanceof Request
    ) {
      try {
        const text = await input.clone().text();
        if (text !== "") sent.push(text);
      } catch {
        // an unreadable body is skipped, not judged
      }
    }
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
  }
  if (sent.length > 0) {
    // At least one body must carry the parts' text; auxiliary requests (auth, token counting) need not.
    expect(
      sent.some((body) => body.includes(A) && body.includes(B)),
      "no request body carries the text parts' text"
    ).toBe(true);
  }
}
