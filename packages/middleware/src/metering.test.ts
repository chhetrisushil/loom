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
    const mw = meteringMiddleware({
      pricing: () => ({ tokens: 100, costUsd: 0.5 }),
      clock: () => 0,
    });
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

  // K8 — an aborted effect is metered before the error propagates; otherwise
  // start-expensive-call → cancel → repeat would evade the budget forever.
  it("meters wall-time when the effect is severed by an abort (K8)", async () => {
    const emit = vi.fn();
    const controller = new AbortController();
    let t = 0;
    const pricing = vi.fn(() => ({ costUsd: 0.25 }));
    const mw = meteringMiddleware({ pricing, clock: () => (t += 40) });

    const abortedCtx = { ...ctx(zero, emit), signal: controller.signal };
    const next = () =>
      new Promise<never>((_, reject) => {
        controller.abort();
        reject(new Error("severed mid-flight"));
      });

    await expect(mw(abortedCtx, { q: 1 }, next)).rejects.toThrow(/severed/);
    expect(pricing).toHaveBeenCalledWith(
      expect.objectContaining({ aborted: true, result: undefined, ms: expect.any(Number) })
    );
    expect(emit).toHaveBeenCalledWith(
      "RESOURCE_METERED",
      expect.objectContaining({ costUsd: 0.25 })
    );
  });

  it("keeps ordinary (non-abort) failures unmetered, as today (G2)", async () => {
    const emit = vi.fn();
    const mw = meteringMiddleware({ pricing: () => ({ costUsd: 1 }) });
    await expect(
      mw(ctx(zero, emit), {}, async () => {
        throw new Error("plain failure");
      })
    ).rejects.toThrow(/plain failure/);
    expect(emit).not.toHaveBeenCalled();
  });
});
