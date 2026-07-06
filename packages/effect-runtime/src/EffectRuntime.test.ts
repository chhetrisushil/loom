import { SuspendError } from "@loom/core";
import { describe, expect, it, vi } from "vitest";
import { EffectRuntime } from "./EffectRuntime";
import { HumanEffect } from "./effects/HumanEffect";
import { ToolEffect } from "./effects/ToolEffect";
import type { EffectContext, EffectMiddleware } from "./types";

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

describe("EffectRuntime — middleware", () => {
  it("with no middleware, behaves identically (default)", async () => {
    const runtime = new EffectRuntime();
    const fn = vi.fn().mockResolvedValue("ok");
    runtime.register("t", new ToolEffect(fn));
    expect(await runtime.execute("t", { a: 1 }, ctx)).toBe("ok");
    expect(fn).toHaveBeenCalledWith({ a: 1 }, ctx);
  });

  it("runs middleware around the effect with middleware[0] outermost", async () => {
    const trace: string[] = [];
    const mw =
      (label: string): EffectMiddleware =>
      async (_ctx, _input, next) => {
        trace.push(`>${label}`);
        const out = await next();
        trace.push(`<${label}`);
        return out;
      };
    const runtime = new EffectRuntime([mw("a"), mw("b")]);
    runtime.register(
      "t",
      new ToolEffect(async () => {
        trace.push("effect");
        return "ok";
      })
    );

    const out = await runtime.execute("t", {}, ctx);
    expect(out).toBe("ok");
    // a is outermost: >a >b effect <b <a
    expect(trace).toEqual([">a", ">b", "effect", "<b", "<a"]);
  });

  it("passes ctx + input through the chain and lets middleware transform the result", async () => {
    const seen: unknown[] = [];
    const capture: EffectMiddleware = async (c, input, next) => {
      seen.push({ execId: c.executionId, input });
      return next();
    };
    const wrap: EffectMiddleware = async (_c, _i, next) => ({ wrapped: await next() });
    const runtime = new EffectRuntime([capture, wrap]);
    runtime.register("t", new ToolEffect(async () => 7));

    const out = await runtime.execute("t", { v: 1 }, ctx);
    expect(out).toEqual({ wrapped: 7 });
    expect(seen).toEqual([{ execId: "exec-1", input: { v: 1 } }]);
  });

  it("middleware can short-circuit without calling next (never invokes the effect)", async () => {
    const shortCircuit: EffectMiddleware = async () => "cached";
    const fn = vi.fn().mockResolvedValue("live");
    const runtime = new EffectRuntime([shortCircuit]);
    runtime.register("t", new ToolEffect(fn));

    expect(await runtime.execute("t", {}, ctx)).toBe("cached");
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not run middleware for an unregistered tool (throws before the chain)", async () => {
    const mw = vi.fn(((_c, _i, next) => next()) as EffectMiddleware);
    const runtime = new EffectRuntime([mw]);
    await expect(runtime.execute("missing", {}, ctx)).rejects.toThrow(/No effect registered/);
    expect(mw).not.toHaveBeenCalled();
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
