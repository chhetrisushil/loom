import { describe, expect, it, vi } from "vitest";
import { EffectRuntime } from "./EffectRuntime";
import { LlmEffect } from "./effects/LlmEffect";
import { ToolEffect } from "./effects/ToolEffect";
import type { Effect, EffectContext, Warmer } from "./types";

const ctx: EffectContext = { executionId: "e", workflowId: "wf", stepId: "s", attempt: 1, emit: vi.fn() };

describe("EffectRuntime.warm — advisory pre-warm (latency-only)", () => {
  it("calls a registered effect's warm() hook", () => {
    const warm = vi.fn();
    const effect: Effect = { kind: "tool", warm, execute: async () => ({}) };
    const rt = new EffectRuntime();
    rt.register("t", effect);
    rt.warm("t");
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("also fires the configured Warmer seam", () => {
    const warmer: Warmer = { warm: vi.fn() };
    const rt = new EffectRuntime([], { warmer });
    rt.register("t", new ToolEffect(async () => ({})));
    rt.warm("t");
    expect(warmer.warm).toHaveBeenCalledWith("t");
  });

  it("is a no-op for an unregistered toolId (never throws)", () => {
    const rt = new EffectRuntime();
    expect(() => rt.warm("nope")).not.toThrow();
  });

  it("swallows a warm failure — the real call just runs cold (advisory)", () => {
    const effect: Effect = {
      kind: "tool",
      warm: () => {
        throw new Error("cold start failed");
      },
      execute: async () => ({}),
    };
    const rt = new EffectRuntime();
    rt.register("t", effect);
    expect(() => rt.warm("t")).not.toThrow();
  });

  it("does NOT run the effect (warming is not invoking — P10)", async () => {
    const execute = vi.fn(async () => ({}));
    const warm = vi.fn();
    const rt = new EffectRuntime();
    rt.register("t", { kind: "tool", warm, execute });
    rt.warm("t");
    await Promise.resolve();
    expect(warm).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("LlmEffect.warm — delegates to the provider", () => {
  it("exposes a warm() that runs the wired provider warm hook", async () => {
    const providerWarm = vi.fn();
    const effect = new LlmEffect(async () => "out", { warm: providerWarm });
    expect(effect.warm).toBeDefined();
    effect.warm?.();
    expect(providerWarm).toHaveBeenCalledTimes(1);
    // still runs normally
    expect(await effect.execute("in", ctx)).toBe("out");
  });

  it("has no warm when none is wired", () => {
    const effect = new LlmEffect(async () => "out");
    expect(effect.warm).toBeUndefined();
  });
});
