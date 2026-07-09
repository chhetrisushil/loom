import { SuspendError } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { describe, expect, it, vi } from "vitest";
import { retryMiddleware } from "./retry";

const baseCtx: EffectContext = {
  executionId: "exec-1",
  stepId: "step-1",
  workflowId: "flow-1",
  attempt: 1,
  emit: vi.fn(),
};

/** Records requested delays and resolves instantly (no real waiting). */
function fakeSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) throw new Error("aborted");
    delays.push(ms);
  };
  return { sleep, delays };
}

describe("retryMiddleware", () => {
  it("retries a failing effect and succeeds within maxRetries", async () => {
    const { sleep, delays } = fakeSleep();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    const runtime = new EffectRuntime([retryMiddleware({ maxRetries: 2, sleep })]);
    runtime.register("t", new ToolEffect(fn));

    expect(await runtime.execute("t", {}, baseCtx)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(delays).toHaveLength(2); // two backoff waits
  });

  it("exhausts retries and rethrows the last error", async () => {
    const { sleep } = fakeSleep();
    const fn = vi.fn().mockRejectedValue(new Error("always"));
    const runtime = new EffectRuntime([retryMiddleware({ maxRetries: 2, sleep })]);
    runtime.register("t", new ToolEffect(fn));

    await expect(runtime.execute("t", {}, baseCtx)).rejects.toThrow("always");
    expect(fn).toHaveBeenCalledTimes(3); // 1 + 2, then give up
  });

  it("never retries a SuspendError (control-flow, not a failure)", async () => {
    const { sleep, delays } = fakeSleep();
    const fn = vi.fn(() => {
      throw new SuspendError({ on: "ApprovalGranted" });
    });
    const runtime = new EffectRuntime([retryMiddleware({ maxRetries: 5, sleep })]);
    runtime.register("t", new ToolEffect(fn));

    await expect(runtime.execute("t", {}, baseCtx)).rejects.toBeInstanceOf(SuspendError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toHaveLength(0);
  });

  it("fails fast when the execution is ALREADY cancelled — the effect never starts (K8)", async () => {
    const { sleep } = fakeSleep();
    const controller = new AbortController();
    controller.abort();
    const ctx: EffectContext = { ...baseCtx, signal: controller.signal };
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    const runtime = new EffectRuntime([retryMiddleware({ maxRetries: 3, sleep })]);
    runtime.register("t", new ToolEffect(fn));

    // The kernel's pre-flight check rejects with the abort reason before the
    // middleware chain runs; a cancelled execution starts no further effects.
    await expect(runtime.execute("t", {}, ctx)).rejects.toThrow(/aborted/i);
    expect(fn).toHaveBeenCalledTimes(0);
  });

  it("does not retry when the execution is cancelled MID-attempt (abort is terminal)", async () => {
    const { sleep, delays } = fakeSleep();
    const controller = new AbortController();
    const ctx: EffectContext = { ...baseCtx, signal: controller.signal };
    const fn = vi.fn(async () => {
      controller.abort(); // cancellation lands while the attempt is in flight
      throw new Error("boom");
    });
    const runtime = new EffectRuntime([retryMiddleware({ maxRetries: 3, sleep })]);
    runtime.register("t", new ToolEffect(fn));

    await expect(runtime.execute("t", {}, ctx)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1); // no re-attempt, no backoff
    expect(delays).toHaveLength(0);
  });

  it("honors isRetryable to skip non-retryable errors", async () => {
    const { sleep } = fakeSleep();
    class Fatal extends Error {}
    const fn = vi.fn().mockRejectedValue(new Fatal("nope"));
    const runtime = new EffectRuntime([
      retryMiddleware({ maxRetries: 3, sleep, isRetryable: (e) => !(e instanceof Fatal) }),
    ]);
    runtime.register("t", new ToolEffect(fn));

    await expect(runtime.execute("t", {}, baseCtx)).rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("produces exponential, jitter-free delays when jitter is off", async () => {
    const { sleep, delays } = fakeSleep();
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    const runtime = new EffectRuntime([
      retryMiddleware({ maxRetries: 3, baseDelayMs: 100, factor: 2, jitter: false, sleep }),
    ]);
    runtime.register("t", new ToolEffect(fn));

    await expect(runtime.execute("t", {}, baseCtx)).rejects.toThrow();
    expect(delays).toEqual([100, 200, 400]);
  });

  it("jitter is deterministic for the same execution/step/attempt", async () => {
    const run = async () => {
      const { sleep, delays } = fakeSleep();
      const fn = vi.fn().mockRejectedValue(new Error("x"));
      const runtime = new EffectRuntime([
        retryMiddleware({ maxRetries: 3, baseDelayMs: 100, jitter: true, sleep }),
      ]);
      runtime.register("t", new ToolEffect(fn));
      await expect(runtime.execute("t", {}, baseCtx)).rejects.toThrow();
      return delays;
    };
    expect(await run()).toEqual(await run());
  });

  it("fires onRetry with attempt + delay for observability", async () => {
    const { sleep } = fakeSleep();
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    const runtime = new EffectRuntime([retryMiddleware({ maxRetries: 2, sleep, onRetry })]);
    runtime.register("t", new ToolEffect(fn));

    await runtime.execute("t", {}, baseCtx);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1 });
  });
});
