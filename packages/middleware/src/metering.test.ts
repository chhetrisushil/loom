import type { EffectContext, ResourceSnapshot } from "@loom/effect-runtime";
import { describe, expect, it, vi } from "vitest";
import { QuotaExceededError, llmUsageTokens, meteringMiddleware } from "./metering";

const zero: ResourceSnapshot = { tokens: 0, costUsd: 0, ms: 0, count: 0 };

function ctx(resources: ResourceSnapshot = zero, emit = vi.fn()): EffectContext {
  return { executionId: "e", workflowId: "wf", stepId: "s", attempt: 1, emit, resources };
}

describe("meteringMiddleware", () => {
  it("meters an effect: emits RESOURCE_METERED with the priced delta", async () => {
    const emit = vi.fn();
    const mw = meteringMiddleware({ pricing: () => ({ tokens: 100, costUsd: 0.5 }), clock: () => 0 });
    const result = await mw(ctx(zero, emit), { q: 1 }, async () => ({ answer: 42 }));
    expect(result).toEqual({ answer: 42 });
    expect(emit).toHaveBeenCalledWith(
      "RESOURCE_METERED",
      expect.objectContaining({ tokens: 100, costUsd: 0.5 })
    );
  });

  it("denies when the execution has already spent its budget (admission control)", async () => {
    const emit = vi.fn();
    const next = vi.fn(async () => ({}));
    const mw = meteringMiddleware({ pricing: () => ({}), budget: { maxCostUsd: 2 } });
    const spent: ResourceSnapshot = { tokens: 0, costUsd: 2, ms: 0, count: 2 };
    await expect(mw(ctx(spent, emit), {}, next)).rejects.toBeInstanceOf(QuotaExceededError);
    expect(emit).toHaveBeenCalledWith(
      "QUOTA_EXCEEDED",
      expect.objectContaining({ reason: expect.any(String) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("allows when under budget", async () => {
    const next = vi.fn(async () => "ok");
    const mw = meteringMiddleware({ pricing: () => ({ costUsd: 1 }), budget: { maxCostUsd: 2 } });
    const spent: ResourceSnapshot = { tokens: 0, costUsd: 1, ms: 0, count: 1 };
    await expect(mw(ctx(spent), {}, next)).resolves.toBe("ok");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("enforces a token budget too", async () => {
    const next = vi.fn(async () => ({}));
    const mw = meteringMiddleware({ pricing: () => ({}), budget: { maxTokens: 1000 } });
    const spent: ResourceSnapshot = { tokens: 1000, costUsd: 0, ms: 0, count: 1 };
    await expect(mw(ctx(spent), {}, next)).rejects.toBeInstanceOf(QuotaExceededError);
    expect(next).not.toHaveBeenCalled();
  });

  it("llmUsageTokens sums input + output tokens", () => {
    expect(llmUsageTokens({ usage: { inputTokens: 10, outputTokens: 5 } })).toBe(15);
    expect(llmUsageTokens({ content: "no usage here" })).toBe(0);
    expect(llmUsageTokens(null)).toBe(0);
  });
});
