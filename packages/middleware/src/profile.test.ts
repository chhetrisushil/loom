import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { describe, expect, it } from "vitest";
import { effectTimingMiddleware } from "./profile";

const ctx = () => ({
  executionId: "x",
  stepId: "slow",
  workflowId: "wf",
  attempt: 1,
  emit: () => {},
});

describe("effectTimingMiddleware", () => {
  it("measures effect time and attributes it per tool", async () => {
    const timer = effectTimingMiddleware();
    const runtime = new EffectRuntime([timer.middleware]);
    runtime.register(
      "slow",
      new ToolEffect(async () => {
        await new Promise((r) => setTimeout(r, 15));
        return "ok";
      })
    );
    runtime.register("fast", new ToolEffect(async () => "ok"));
    await runtime.execute("slow", {}, ctx());
    await runtime.execute("fast", {}, { ...ctx(), stepId: "fast" });

    const p = timer.profile();
    expect(p.calls).toBe(2);
    expect(p.totalEffectMs).toBeGreaterThanOrEqual(12);
    expect(p.byTool.slow?.calls).toBe(1);
    expect(p.byTool.slow!.totalMs).toBeGreaterThanOrEqual(12);
    // A slow tool must be visible individually, not averaged into the total.
    expect(p.byTool.fast!.totalMs).toBeLessThan(p.byTool.slow!.totalMs);
  });

  it("counts a failing effect — time spent failing is still time spent", async () => {
    const timer = effectTimingMiddleware();
    const runtime = new EffectRuntime([timer.middleware]);
    runtime.register(
      "boom",
      new ToolEffect(async () => {
        throw new Error("nope");
      })
    );
    await expect(runtime.execute("boom", {}, { ...ctx(), stepId: "boom" })).rejects.toThrow();
    expect(timer.profile().calls).toBe(1);
  });

  it("records peak concurrency and resets", async () => {
    const timer = effectTimingMiddleware();
    const runtime = new EffectRuntime([timer.middleware]);
    runtime.register(
      "wait",
      new ToolEffect(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return "ok";
      })
    );
    await Promise.all(
      Array.from({ length: 4 }, () => runtime.execute("wait", {}, { ...ctx(), stepId: "wait" }))
    );
    expect(timer.profile().peakConcurrentEffects).toBeGreaterThan(1);
    timer.reset();
    expect(timer.profile()).toMatchObject({ calls: 0, totalEffectMs: 0, byTool: {} });
  });
});
