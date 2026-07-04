import { SuspendError } from "@loom/core";
import { describe, expect, it, vi } from "vitest";
import { EffectRuntime } from "./EffectRuntime";
import { HumanEffect } from "./effects/HumanEffect";
import { ToolEffect } from "./effects/ToolEffect";
import type { EffectContext } from "./types";

const ctx: EffectContext = {
  executionId: "exec-1",
  stepId: "step-1",
  workflowId: "flow-1",
  attempt: 1,
  emit: vi.fn(),
};

describe("EffectRuntime", () => {
  it("executes a registered tool effect", async () => {
    const runtime = new EffectRuntime();
    const fn = vi.fn().mockResolvedValue({ result: "ok" });
    runtime.register("my-tool", new ToolEffect(fn));

    const result = await runtime.execute("my-tool", { input: 1 }, ctx);
    expect(result).toEqual({ result: "ok" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws if toolId not registered", async () => {
    const runtime = new EffectRuntime();
    await expect(runtime.execute("missing-tool", {}, ctx)).rejects.toThrow(
      'No effect registered for toolId: "missing-tool"'
    );
  });

  it("forwards input and ctx to the effect", async () => {
    const runtime = new EffectRuntime();
    const fn = vi.fn().mockResolvedValue({});
    runtime.register("echo-tool", new ToolEffect(fn));

    await runtime.execute("echo-tool", { value: 42 }, ctx);
    expect(fn).toHaveBeenCalledWith({ value: 42 }, ctx);
  });

  it("allows registering and executing multiple tools", async () => {
    const runtime = new EffectRuntime();
    runtime.register("tool-a", new ToolEffect(vi.fn().mockResolvedValue("a")));
    runtime.register("tool-b", new ToolEffect(vi.fn().mockResolvedValue("b")));

    expect(await runtime.execute("tool-a", {}, ctx)).toBe("a");
    expect(await runtime.execute("tool-b", {}, ctx)).toBe("b");
  });

  it("has() returns true for registered tools", () => {
    const runtime = new EffectRuntime();
    runtime.register("t1", new ToolEffect(vi.fn()));
    expect(runtime.has("t1")).toBe(true);
    expect(runtime.has("t2")).toBe(false);
  });
});

describe("HumanEffect", () => {
  it("throws SuspendError with the configured condition", () => {
    const effect = new HumanEffect({ on: "ApprovalGranted", timeout: 86400000 });
    expect(() => effect.execute({}, ctx)).toThrow(SuspendError);
  });

  it("includes correlationKey when provided", () => {
    const effect = new HumanEffect({
      on: "ApprovalGranted",
      correlationKey: (input) => (input as { id: string }).id,
    });
    let caught: SuspendError | undefined;
    try {
      effect.execute({ id: "incident-123" }, ctx);
    } catch (e) {
      if (e instanceof SuspendError) caught = e;
    }
    expect(caught?.condition.correlationKey).toBe("incident-123");
    expect(caught?.condition.on).toBe("ApprovalGranted");
  });
});
