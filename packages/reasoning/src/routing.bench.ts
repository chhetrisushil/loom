import type { LlmProvider, LlmResponse } from "@loom/llm";
import { bench, describe } from "vitest";
import { ReasoningRuntime } from "./ReasoningRuntime";
import { tagRouter } from "./router";
import type { ConfidenceSignal, ModelRoute } from "./types";

// Benches for the two routing hot paths made O(1)/O(n):
//   1. tagRouter no longer re-sorts the route list on every select().
//   2. Elevation hops via a precomputed next-tier index instead of an O(n) scan,
//      so walking a deep ladder is O(n) not O(n^2).

class FakeProvider implements LlmProvider {
  constructor(private readonly res: LlmResponse) {}
  async complete(): Promise<LlmResponse> {
    return this.res;
  }
}

const weak: LlmResponse = { content: "weak", stopReason: "max_tokens" };
// Force elevation all the way up the ladder every call.
const alwaysLow: ConfidenceSignal = { score: () => 0 };

function makeRoutes(n: number): ModelRoute[] {
  const provider = new FakeProvider(weak);
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    provider,
    tier: i,
    ...(i === 0 && { tags: ["planning"] }),
  }));
}

const routes = makeRoutes(64);

describe("tagRouter.select over 64 routes", () => {
  const req = { messages: [{ role: "user" as const, content: "hi" }], strategy: "planning" };

  bench("re-sort baseline (previous shape)", () => {
    const sorted = [...routes].sort((a, b) => a.tier - b.tier);
    sorted.find((r) => r.tags?.includes("planning"));
  });

  bench("tagRouter.select (pre-sorted, no re-sort)", () => {
    tagRouter.select(req, routes);
  });
});

describe("reason() full elevation up a 64-tier ladder", () => {
  const runtime = new ReasoningRuntime({ routes, confidence: alwaysLow });

  bench("reason (O(1) tier hops)", async () => {
    await runtime.reason({ messages: [{ role: "user", content: "hi" }] });
  });
});
