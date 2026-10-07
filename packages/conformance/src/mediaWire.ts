import type { LlmProvider, LlmRequest } from "@loom/llm";
import { mediaTypeAccepted } from "@loom/llm";
import { expect, vi } from "vitest";

/**
 * The R5 "declared means delivered" rule from {@link runLlmProviderConformance}, in its own module
 * (not re-exported from the package entry) so a provider that violates it can be driven directly in
 * this package's tests: a factory only runs inside the kit's own `it`, where a negative case cannot
 * be nested.
 *
 * Declaring a modality and then dropping it is the same silent loss as never declaring it. An HTTP
 * provider is observed at its `fetch` boundary: the image's bytes must appear in every request it
 * sends (`complete` and `stream`). A provider that never calls `fetch` cannot be observed here and
 * passes. Resolves for a provider that does not declare `image/png`.
 */
export async function checkDeclaredMediaOnWire(provider: LlmProvider): Promise<void> {
  if (!mediaTypeAccepted(provider.capabilities?.image, "image/png")) return;
  const MARKER = "TUFSS0VSLUJZVEVT"; // valid base64, unlikely to occur by accident
  const request: LlmRequest = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", mediaType: "image/png", source: { kind: "data", data: MARKER } },
        ],
      },
    ],
  };
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
        // a stub response is not a valid stream; only what was SENT matters
      }
    }
  } finally {
    vi.unstubAllGlobals();
  }
  for (const body of sent) {
    expect(
      body,
      "provider declares image support but its request does not carry the image"
    ).toContain(MARKER);
  }
}
