import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryKillSwitch,
  KillSwitchEngagedError,
  killSwitchMiddleware,
} from "./killSwitchRegistry";
import { QuotaExceededError } from "./metering";
import { RateLimitExceededError, rateLimitMiddleware } from "./rateLimit";
import { retryMiddleware } from "./retry";

function ctx(over: Partial<EffectContext> = {}): EffectContext {
  return {
    executionId: "e1",
    workflowId: "wf",
    stepId: "s",
    attempt: 1,
    emit: vi.fn(),
    ...over,
  };
}

describe("rateLimitMiddleware (R9)", () => {
  it("admits a burst up to capacity, then refuses with a typed non-retryable error", async () => {
    const t = 0;
    const mw = rateLimitMiddleware({ capacity: 2, refillPerSecond: 1, clock: () => t });
    const next = vi.fn(async () => "ok");
    await mw(ctx(), {}, next);
    await mw(ctx(), {}, next);
    const c = ctx();
    await expect(mw(c, {}, next)).rejects.toMatchObject({
      name: "RateLimitExceededError",
      retryable: false,
    });
    expect(next).toHaveBeenCalledTimes(2); // the refused call never reached the effect
    expect(c.emit).toHaveBeenCalledWith(
      "SAFETY_BLOCKED",
      expect.objectContaining({ category: "rate-limit" })
    );
  });

  it("refills with the (deterministic test) clock", async () => {
    let t = 0;
    const mw = rateLimitMiddleware({ capacity: 1, refillPerSecond: 2, clock: () => t });
    const next = vi.fn(async () => "ok");
    await mw(ctx(), {}, next);
    await expect(mw(ctx(), {}, next)).rejects.toBeInstanceOf(RateLimitExceededError);
    t = 400; // 0.8 token: still short
    await expect(mw(ctx(), {}, next)).rejects.toBeInstanceOf(RateLimitExceededError);
    t = 500; // 1.0 token
    await expect(mw(ctx(), {}, next)).resolves.toBe("ok");
  });

  it("buckets are per scope key: one execution cannot starve another", async () => {
    const mw = rateLimitMiddleware({ capacity: 1, refillPerSecond: 0.001, clock: () => 0 });
    const next = vi.fn(async () => "ok");
    await mw(ctx({ executionId: "a" }), {}, next);
    await expect(mw(ctx({ executionId: "a" }), {}, next)).rejects.toBeInstanceOf(
      RateLimitExceededError
    );
    await expect(mw(ctx({ executionId: "b" }), {}, next)).resolves.toBe("ok");
  });

  it("tenant scope: a request with no tenant shares one bucket instead of escaping", async () => {
    const mw = rateLimitMiddleware({
      capacity: 1,
      refillPerSecond: 0.001,
      scope: "tenant",
      clock: () => 0,
    });
    const next = vi.fn(async () => "ok");
    await mw(ctx({ executionId: "a" }), {}, next);
    await expect(mw(ctx({ executionId: "b" }), {}, next)).rejects.toBeInstanceOf(
      RateLimitExceededError
    );
    await expect(
      mw(ctx({ executionId: "c", principal: { tenant: "acme" } }), {}, next)
    ).resolves.toBe("ok");
  });

  it("bounds its bucket map (LRU eviction)", async () => {
    const mw = rateLimitMiddleware({
      capacity: 1,
      refillPerSecond: 0.001,
      clock: () => 0,
      maxBuckets: 2,
    });
    const next = vi.fn(async () => "ok");
    for (const id of ["a", "b", "c"]) await mw(ctx({ executionId: id }), {}, next);
    // "a" was evicted, so it starts full again (errs toward permitting, never toward leaking).
    await expect(mw(ctx({ executionId: "a" }), {}, next)).resolves.toBe("ok");
  });

  it("rejects nonsense configuration at construction", () => {
    expect(() => rateLimitMiddleware({ capacity: 0, refillPerSecond: 1 })).toThrow(/capacity/);
    expect(() => rateLimitMiddleware({ capacity: 1, refillPerSecond: 0 })).toThrow(/refill/);
  });

  it("retryMiddleware does not retry it", async () => {
    const calls = vi.fn();
    const mw = retryMiddleware({ maxRetries: 3, sleep: async () => {} });
    await expect(
      mw(ctx(), {}, async () => {
        calls();
        throw new RateLimitExceededError("execution", "e1", 10);
      })
    ).rejects.toBeInstanceOf(RateLimitExceededError);
    expect(calls).toHaveBeenCalledTimes(1);
  });
});

describe("scoped kill switch (R9)", () => {
  it("a tenant stop refuses that tenant's NEXT effect and not another tenant's", async () => {
    const ks = new InMemoryKillSwitch();
    const mw = killSwitchMiddleware(ks);
    const next = vi.fn(async () => "ok");
    const acme = ctx({ principal: { tenant: "acme" } });
    const globex = ctx({ principal: { tenant: "globex" } });
    await expect(mw(acme, {}, next)).resolves.toBe("ok");
    ks.stopTenant("acme", "incident 42");
    await expect(mw(acme, {}, next)).rejects.toBeInstanceOf(KillSwitchEngagedError);
    await expect(mw(globex, {}, next)).resolves.toBe("ok");
    expect(next).toHaveBeenCalledTimes(2);
    expect(acme.emit).toHaveBeenCalledWith(
      "SAFETY_BLOCKED",
      expect.objectContaining({ category: "kill-switch", scope: "tenant", key: "acme" })
    );
    ks.resumeTenant("acme");
    await expect(mw(acme, {}, next)).resolves.toBe("ok");
  });

  it("a system stop refuses every effect, including those with no principal", async () => {
    const ks = new InMemoryKillSwitch();
    const mw = killSwitchMiddleware(ks);
    const next = vi.fn(async () => "ok");
    ks.stopAll("maintenance");
    await expect(mw(ctx(), {}, next)).rejects.toMatchObject({
      name: "KillSwitchEngagedError",
      scope: "system",
      retryable: false,
    });
    await expect(mw(ctx({ principal: { tenant: "x" } }), {}, next)).rejects.toBeInstanceOf(
      KillSwitchEngagedError
    );
    expect(next).not.toHaveBeenCalled();
    ks.resumeAll();
    await expect(mw(ctx(), {}, next)).resolves.toBe("ok");
  });

  it("a workflow stop refuses only that flow", async () => {
    const ks = new InMemoryKillSwitch();
    const mw = killSwitchMiddleware(ks);
    const next = vi.fn(async () => "ok");
    ks.stopWorkflow("rogue-agent");
    await expect(mw(ctx({ workflowId: "rogue-agent" }), {}, next)).rejects.toBeInstanceOf(
      KillSwitchEngagedError
    );
    await expect(mw(ctx({ workflowId: "other" }), {}, next)).resolves.toBe("ok");
    expect(ks.status().workflows).toEqual({ "rogue-agent": "workflow stop" });
  });

  it("fails CLOSED when a networked registry throws or is async", async () => {
    const mw = killSwitchMiddleware({
      check: async () => {
        throw new Error("redis down");
      },
    });
    await expect(mw(ctx(), {}, vi.fn())).rejects.toThrow(/registry unavailable: redis down/);
    const asyncStop = killSwitchMiddleware({
      check: async () => ({ scope: "tenant", key: "t", reason: "stop" }),
    });
    await expect(asyncStop(ctx(), {}, vi.fn())).rejects.toBeInstanceOf(KillSwitchEngagedError);
  });

  it("is consulted on the transient seam too (before the effect body runs)", async () => {
    const ks = new InMemoryKillSwitch();
    const rt = new EffectRuntime([killSwitchMiddleware(ks)]);
    const body = vi.fn(async () => "ok");
    rt.register("t", new ToolEffect(body));
    ks.stopTenant("acme");
    await expect(
      rt.invokeTransient("t", {}, { principal: { tenant: "acme" } })
    ).rejects.toBeInstanceOf(KillSwitchEngagedError);
    expect(body).not.toHaveBeenCalled();
    await expect(rt.invokeTransient("t", {}, { principal: { tenant: "other" } })).resolves.toBe(
      "ok"
    );
  });

  it("retryMiddleware does not retry a stop", async () => {
    const ks = new InMemoryKillSwitch();
    ks.stopAll();
    const body = vi.fn(async () => "ok");
    const rt = new EffectRuntime([
      retryMiddleware({ maxRetries: 3, sleep: async () => {} }),
      killSwitchMiddleware(ks),
    ]);
    rt.register("t", new ToolEffect(body));
    const check = vi.spyOn(ks, "check");
    await expect(
      rt.execute(
        "t",
        {},
        { executionId: "e", workflowId: "w", stepId: "s", attempt: 1, emit: () => {} }
      )
    ).rejects.toBeInstanceOf(KillSwitchEngagedError);
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe("QuotaExceededError (R9)", () => {
  it("is non-retryable like every other control-plane refusal", async () => {
    expect(new QuotaExceededError("tokens 5 >= budget 5").retryable).toBe(false);
    let calls = 0;
    const mw = retryMiddleware({ maxRetries: 3, baseDelayMs: 1, sleep: async () => {} });
    await expect(
      mw(ctx(), {}, async () => {
        calls++;
        throw new QuotaExceededError("over");
      })
    ).rejects.toBeInstanceOf(QuotaExceededError);
    expect(calls).toBe(1);
  });
});
