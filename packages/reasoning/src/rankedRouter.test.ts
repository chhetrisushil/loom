import type { LlmProvider, LlmResponse } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { epsilonGreedy, fixedRouter, rankedRouter, ucb1 } from "./router";
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

describe("rankedRouter — sample floor", () => {
  it("ignores an arm whose evidence is below minSamples, even if it ranks highest", () => {
    // opus: one lucky success. gemma: 200 samples, nearly as good. Without a floor
    // the n=1 arm wins forever (and, being pure exploit, is never re-tested).
    const stats = [
      { key: "opus", rank: 1, count: 1 },
      { key: "gemma", rank: 0.99, count: 200 },
    ];
    expect(rankedRouter(stats).select(req, routes).id).toBe("opus");
    expect(rankedRouter(stats, { minSamples: 30 }).select(req, routes).id).toBe("gemma");
  });

  it("falls back when every arm is under-sampled", () => {
    const router = rankedRouter([{ key: "opus", rank: 1, count: 2 }], { minSamples: 30 });
    expect(router.select(req, routes).id).toBe("gemma"); // tagRouter, cheap-first
  });

  it("honours a custom fallback", () => {
    const router = rankedRouter({}, { fallback: fixedRouter("opus") });
    expect(router.select(req, routes).id).toBe("opus");
  });

  it("throws rather than silently no-op when minSamples is set without counts", () => {
    expect(() => rankedRouter({ opus: 1 }, { minSamples: 30 })).toThrow(/sample counts/);
  });
});

describe("ucb1", () => {
  it("tries an unsampled arm before exploiting a lucky one", () => {
    // The regression that motivated this: opus scored 1.0 on a single sample and,
    // under pure argmax, gemma could never be tried again to disprove it.
    const stats = [{ key: "opus", rank: 1, count: 1 }];
    expect(rankedRouter(stats).select(req, routes).id).toBe("opus");
    expect(ucb1(stats).select(req, routes).id).toBe("gemma");
  });

  it("exploits once the evidence is thick enough to shrink the bonus", () => {
    const stats = [
      { key: "gemma", rank: 0.4, count: 500 },
      { key: "opus", rank: 0.9, count: 500 },
    ];
    expect(ucb1(stats).select(req, routes).id).toBe("opus");
  });

  it("keeps exploring a rival whose mean is close but whose evidence is thin", () => {
    const stats = [
      { key: "gemma", rank: 0.7, count: 5 },
      { key: "opus", rank: 0.75, count: 500 },
    ];
    // Greedy takes opus; UCB1 spends a trial on gemma because it might be better.
    expect(rankedRouter(stats).select(req, routes).id).toBe("opus");
    expect(ucb1(stats).select(req, routes).id).toBe("gemma");
  });

  it("exploration: 0 degrades to pure exploit", () => {
    const stats = [
      { key: "gemma", rank: 0.7, count: 5 },
      { key: "opus", rank: 0.75, count: 500 },
    ];
    expect(ucb1(stats, { exploration: 0 }).select(req, routes).id).toBe("opus");
  });

  it("falls back on a cold start (no samples at all)", () => {
    expect(ucb1([]).select(req, routes).id).toBe("gemma");
    expect(ucb1([], { fallback: fixedRouter("opus") }).select(req, routes).id).toBe("opus");
  });
});

describe("epsilonGreedy", () => {
  const inner = fixedRouter("opus");
  // rng() is consumed twice per explore: the coin, then the uniform index.
  const scripted = (...values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length] as number;
  };

  it("explores uniformly when the coin lands under epsilon", () => {
    const router = epsilonGreedy(inner, { epsilon: 0.5, rng: scripted(0.1, 0.0) });
    expect(router.select(req, routes).id).toBe("gemma"); // index 0, not inner's opus
  });

  it("exploits when the coin lands above epsilon", () => {
    const router = epsilonGreedy(inner, { epsilon: 0.1, rng: scripted(0.9) });
    expect(router.select(req, routes).id).toBe("opus");
  });

  it("epsilon 0 never explores; epsilon 1 always does", () => {
    expect(epsilonGreedy(inner, { epsilon: 0, rng: () => 0 }).select(req, routes).id).toBe("opus");
    const always = epsilonGreedy(inner, { epsilon: 1, rng: scripted(0, 0.99) });
    expect(always.select(req, routes).id).toBe("opus"); // last index, by chance
  });

  it("rejects an out-of-range epsilon", () => {
    expect(() => epsilonGreedy(inner, { epsilon: 1.5 })).toThrow(/\[0,1\]/);
    expect(() => epsilonGreedy(inner, { epsilon: Number.NaN })).toThrow(/\[0,1\]/);
  });
});
