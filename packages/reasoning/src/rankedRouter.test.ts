import type { LlmProvider, LlmResponse } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { rankedRouter } from "./router";
import type { ModelRoute, ReasoningRequest } from "./types";

const stub: LlmProvider = {
  complete: async (): Promise<LlmResponse> => ({ content: "", stopReason: "end_turn" }),
};
const routes: ModelRoute[] = [
  { id: "gemma", provider: stub, tier: 0 },
  { id: "opus", provider: stub, tier: 2 },
];
const req: ReasoningRequest = { messages: [] };

describe("rankedRouter (M10)", () => {
  it("prefers the highest-ranked available model, even if not the cheapest", () => {
    const router = rankedRouter({ opus: 5, gemma: 1 });
    expect(router.select(req, routes).id).toBe("opus");
  });

  it("falls back to cheap-first (tagRouter) when nothing is ranked", () => {
    const router = rankedRouter({});
    expect(router.select(req, routes).id).toBe("gemma");
  });

  it("ignores rankings for models not in the route set", () => {
    const router = rankedRouter({ "some-other-model": 99, gemma: 2 });
    expect(router.select(req, routes).id).toBe("gemma");
  });
});
