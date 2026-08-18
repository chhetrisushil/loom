import type { EffectContext } from "@loom/effect-runtime";
import { describe, expect, it, vi } from "vitest";
import { QuotaExceededError } from "./metering";
import { estimateTokensByChars, streamTokenBudget } from "./streamTokenBudget";

// ── K8.4 — severing a runaway generation WHILE it generates ──────────────────
//
// Every other K3 gate is admission control: it decides whether the NEXT effect
// runs, so a model that emits 100K tokens is billed in full and stopped after.
// This is the one that acts inside a call already in flight.
//
// The estimate is an estimate. What these pin is that it severs at roughly the
// right point, says so in the durable fact, and never reports itself as exact.

function makeCtx(spentTokens?: number): EffectContext {
  return {
    executionId: "exec-1",
    stepId: "llm",
    workflowId: "wf-1",
    attempt: 1,
    emit: vi.fn(),
    ...(spentTokens !== undefined && {
      resources: { tokens: spentTokens, costUsd: 0, ms: 0, count: 1 },
    }),
  };
}

/**
 * Drive a guard the way `collectStream` does — one call per delta, with the text
 * so far — and report how many deltas got through before it threw.
 *
 * Deliberately not importing `collectStream`: `@loom/middleware` has no
 * `@loom/llm` dependency (metering reads `LlmResponse` structurally, on purpose),
 * and adding one for a test would invert a boundary the package chose. The other
 * half of the contract — that `collectStream` calls the guard per delta and a
 * throw severs the stream — is tested in `@loom/llm`, where `collectStream` is.
 */
function drive(
  guard: (progress: { text: string; deltas: number }) => void,
  n: number,
  chunk = "0123456789012345"
): { delivered: number; error: unknown } {
  let text = "";
  for (let i = 0; i < n; i++) {
    text += chunk;
    try {
      guard({ text, deltas: i + 1 });
    } catch (error) {
      return { delivered: i + 1, error };
    }
  }
  return { delivered: n, error: undefined };
}

describe("streamTokenBudget (K8.4)", () => {
  it("severs mid-stream instead of paying for the whole generation", async () => {
    const ctx = makeCtx();
    // 16 chars/delta ≈ 4 estimated tokens each; a 40-token ceiling should stop
    // this around delta 10, not at delta 1000.
    const { delivered, error } = drive(
      streamTokenBudget({ maxTokens: 40 }, { checkEvery: 1 })(ctx),
      1000
    );

    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(delivered).toBeLessThan(20); // stopped early, not at 1000
    expect(delivered).toBeGreaterThan(5); // and not before the budget was near
  });

  it("emits QUOTA_EXCEEDED — the same durable fact metering writes", async () => {
    // An over-budget run must look the same to analytics whichever gate caught
    // it, or the mid-flight path becomes invisible to every existing report.
    const ctx = makeCtx();
    drive(streamTokenBudget({ maxTokens: 40 }, { checkEvery: 1 })(ctx), 1000);

    expect(ctx.emit).toHaveBeenCalledWith(
      "QUOTA_EXCEEDED",
      expect.objectContaining({
        stepId: "llm",
        reason: expect.stringContaining("mid-stream"),
      })
    );
  });

  it("says the number is an ESTIMATE in the durable reason", async () => {
    const ctx = makeCtx();
    drive(streamTokenBudget({ maxTokens: 40 }, { checkEvery: 1 })(ctx), 1000);

    const [, payload] = vi.mocked(ctx.emit).mock.calls[0] as [string, { reason: string }];
    // Reported as approximate, so nobody reconciles it against provider billing
    // and concludes the meter is broken.
    expect(payload.reason).toContain("~");
    expect(payload.reason).toContain("estimated");
  });

  it("counts what the execution already spent, not just this call", async () => {
    // The ceiling is the EXECUTION's, from K3's running totals — otherwise every
    // call gets a fresh budget and the cap means nothing across a loop.
    const ctx = makeCtx(39);
    const { error } = drive(streamTokenBudget({ maxTokens: 40 }, { checkEvery: 1 })(ctx), 1000);
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect((error as QuotaExceededError).reason).toContain("39 already metered");
  });

  it("lets a generation inside its budget finish untouched (G2)", async () => {
    const ctx = makeCtx();
    const { delivered, error } = drive(streamTokenBudget({ maxTokens: 10_000 })(ctx), 2);
    expect(error).toBeUndefined();
    expect(delivered).toBe(2);
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  it("does nothing when the budget names no token ceiling", async () => {
    const ctx = makeCtx();
    const { error } = drive(streamTokenBudget({ maxCostUsd: 1 }, { checkEvery: 1 })(ctx), 50);
    expect(error).toBeUndefined();
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  it("checkEvery bounds the cost of estimating, at the price of granularity", async () => {
    // Estimation is O(text), so checking every token is quadratic. The trade is
    // explicit: a coarser interval overshoots by up to that many deltas.
    const calls: number[] = [];
    const estimate = (t: string) => {
      calls.push(t.length);
      return estimateTokensByChars(t);
    };
    const ctx = makeCtx();
    drive(streamTokenBudget({ maxTokens: 1_000_000 }, { checkEvery: 8, estimate })(ctx), 64);
    expect(calls.length).toBeLessThanOrEqual(9);
  });
});
