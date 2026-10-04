import { describe, expect, it } from "vitest";
import { EffectRuntime } from "./EffectRuntime";
import { CapabilityDeniedError, GrantTable } from "./authz";
import { ToolEffect } from "./effects/ToolEffect";
import type { EffectContext, EffectMiddleware } from "./types";

// A minimal retrying middleware, inline so the acceptance test stays inside
// @loom/effect-runtime (no dependency on @loom/middleware). Retries the chain up
// to `times` on any throw — enough to prove "configured middleware still runs
// transiently" without pulling in the real retry package.
const retrying = (times: number): EffectMiddleware => {
  return async (_ctx, input, next) => {
    let lastErr: unknown;
    for (let i = 0; i <= times; i++) {
      try {
        return await next(input);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  };
};

describe("EffectRuntime.invokeTransient", () => {
  it("R1: invokes the effect and returns its result (no store is even reachable)", async () => {
    // The EffectRuntime holds no event store by construction, so "zero events"
    // is structural here — proven end-to-end against a real store in the
    // WorkflowRuntime suite (invokeTransient.test.ts there). This asserts the
    // one-shot invoke-and-return behaviour.
    const runtime = new EffectRuntime();
    runtime.register(
      "hydrate",
      new ToolEffect(async (_input, ctx: EffectContext) => {
        // A drop-sink emit is wired — the effect can call it and nothing happens.
        ctx.emit("SHOULD_BE_DROPPED", { foo: 1 });
        return { rows: 3 };
      })
    );

    const result = await runtime.invokeTransient("hydrate", { window: "5m" });
    expect(result).toEqual({ rows: 3 });
  });

  it("R2: caller passes no EffectContext — the façade synthesizes it", async () => {
    const runtime = new EffectRuntime();
    const seen: EffectContext[] = [];
    runtime.register(
      "peek",
      new ToolEffect(async (_input, ctx: EffectContext) => {
        seen.push(ctx);
        return "ok";
      })
    );

    await runtime.invokeTransient("peek", {}, { label: "hydrate" });
    const ctx = seen[0]!;
    // Synthetic identity: label surfaces on executionId for trace correlation;
    // stepId is the toolId; workflowId is the fixed transient marker.
    expect(ctx.executionId).toBe("transient:hydrate");
    expect(ctx.stepId).toBe("peek");
    expect(ctx.workflowId).toBe("transient");
    expect(ctx.attempt).toBe(1);
    // idempotencyKey is deliberately unset — no stable provider-side dedup key.
    expect(ctx.idempotencyKey).toBeUndefined();
  });

  it("R3: configured retry middleware runs; a flaky effect retries per policy", async () => {
    const runtime = new EffectRuntime([retrying(2)]);
    let calls = 0;
    runtime.register(
      "flaky",
      new ToolEffect(async () => {
        calls += 1;
        if (calls < 3) throw new Error("transient blip");
        return "recovered";
      })
    );

    const result = await runtime.invokeTransient("flaky", {});
    expect(result).toBe("recovered");
    expect(calls).toBe(3); // two failures + one success — the middleware retried
  });

  it("R3: the K2 authorizer is still enforced transiently", async () => {
    // workflowId is the synthetic "transient" marker, so grants key off it.
    const allowed = new EffectRuntime([], {
      authorizer: new GrantTable({ transient: ["ok-tool"] }),
    });
    allowed.register("ok-tool", new ToolEffect(async () => "yes"));
    expect(await allowed.invokeTransient("ok-tool", {})).toBe("yes");

    const denied = new EffectRuntime([], {
      authorizer: new GrantTable({ transient: [] }),
    });
    denied.register("blocked", new ToolEffect(async () => "should-not-run"));
    await expect(denied.invokeTransient("blocked", {})).rejects.toBeInstanceOf(
      CapabilityDeniedError
    );
  });

  it("R4: an emitted event is dropped — the effect neither throws nor persists", async () => {
    const runtime = new EffectRuntime();
    runtime.register(
      "emitter",
      new ToolEffect(async (_input, ctx: EffectContext) => {
        // Must not throw, must not buffer, must not later flush.
        ctx.emit("DURABLE_STATE", { leaked: true });
        return "done";
      })
    );

    await expect(runtime.invokeTransient("emitter", {})).resolves.toBe("done");
  });

  it("R5: an aborted signal cancels the in-flight effect and rejects the call", async () => {
    const runtime = new EffectRuntime();
    const controller = new AbortController();
    controller.abort(new Error("deadline exceeded"));
    runtime.register("slow", new ToolEffect(async () => "should-not-reach"));

    await expect(
      runtime.invokeTransient("slow", {}, { signal: controller.signal })
    ).rejects.toThrow("deadline exceeded");
  });

  it("R5: an in-flight effect observing the signal aborts mid-run", async () => {
    const runtime = new EffectRuntime();
    const controller = new AbortController();
    runtime.register(
      "watcher",
      new ToolEffect(async (_input, ctx: EffectContext) => {
        controller.abort(new Error("cancelled mid-flight"));
        // A well-behaved effect forwards the signal and checks it at await points.
        if (ctx.signal?.aborted === true) throw ctx.signal.reason;
        return "should-not-reach";
      })
    );

    await expect(
      runtime.invokeTransient("watcher", {}, { signal: controller.signal })
    ).rejects.toThrow("cancelled mid-flight");
  });

  it("R2: label defaults to the toolId when omitted", async () => {
    const runtime = new EffectRuntime();
    let executionId = "";
    runtime.register(
      "nolabel",
      new ToolEffect(async (_input, ctx: EffectContext) => {
        executionId = ctx.executionId;
        return null;
      })
    );

    await runtime.invokeTransient("nolabel", {});
    expect(executionId).toBe("transient:nolabel");
  });
});

describe("EffectRuntime.invokeTransient `as` (L30)", () => {
  it("stamps the supplied identity; absent, the synthesized identity is unchanged", async () => {
    const seen: EffectContext[] = [];
    const runtime = new EffectRuntime([
      (ctx, input, next) => {
        seen.push(ctx);
        return next(input);
      },
    ]);
    runtime.register("t", new ToolEffect(async () => 1));
    await runtime.invokeTransient("t", {}, { label: "x" });
    await runtime.invokeTransient(
      "t",
      {},
      { as: { workflowId: "wf", executionId: "ex", stepId: "s" } }
    );
    expect(seen[0]).toMatchObject({
      workflowId: "transient",
      executionId: "transient:x",
      stepId: "t",
    });
    expect(seen[1]).toMatchObject({ workflowId: "wf", executionId: "ex", stepId: "s" });
  });

  it("callKey and resources reach the context; stepId defaults to the toolId even when stamped", async () => {
    const seen: EffectContext[] = [];
    const runtime = new EffectRuntime([
      (c, i, next) => {
        seen.push(c);
        return next(i);
      },
    ]);
    runtime.register("t", new ToolEffect(async () => 1));
    const resources = { tokens: 1, costUsd: 2, ms: 3, count: 4 };
    await runtime.invokeTransient(
      "t",
      {},
      { as: { workflowId: "wf", executionId: "ex", callKey: "k0" }, resources }
    );
    expect(seen[0]).toMatchObject({ stepId: "t", callKey: "k0", resources });
    await runtime.invokeTransient("t", {});
    expect(seen[1]?.callKey).toBeUndefined();
    expect(seen[1]?.resources).toBeUndefined();
  });
});
