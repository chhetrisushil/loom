import { tainted, unwrapTainted } from "@loom/classify";
import { describe, expect, it } from "vitest";
import { EffectRuntime } from "./EffectRuntime";
import { LlmEffect } from "./effects/LlmEffect";
import { ToolEffect } from "./effects/ToolEffect";
import type { EffectContext, EffectDelta, EffectMiddleware } from "./types";

// ADR 0133 D6 — a reasoning chunk is a separate channel through the same governed pipe.

const emitter = (): ToolEffect<unknown, string> =>
  new ToolEffect<unknown, string>(async (_i, ctx: EffectContext) => {
    ctx.onDelta?.({ delta: tainted("", "t"), reasoning: tainted("r1", "t") });
    ctx.onDelta?.({ delta: tainted("text", "t") });
    ctx.onDelta?.({ delta: tainted("", "t"), reasoning: tainted("BAD", "t") });
    return "done";
  });

const guard = (seen: string[]): EffectMiddleware =>
  Object.assign(
    async (_c: EffectContext, i: unknown, next: (i: unknown) => Promise<unknown>) => next(i),
    {
      deltaGuard: () => (d: string) => {
        seen.push(d);
        if (d === "BAD") throw new Error("severed");
      },
    }
  ) as unknown as EffectMiddleware;

describe("EffectRuntime reasoning deltas", () => {
  it("passes reasoning through deltaGuard (apart from text) and severs before delivery", async () => {
    const seen: string[] = [];
    const got: EffectDelta[] = [];
    const rt = new EffectRuntime([guard(seen)]);
    rt.register("e", emitter());
    await expect(rt.invokeTransient("e", {}, { onDelta: (c) => got.push(c) })).rejects.toThrow(
      "severed"
    );
    expect(seen).toEqual(["r1", "text", "BAD"]);
    expect(got.filter((c) => c.reasoning).map((c) => unwrapTainted(c.reasoning as never))).toEqual([
      "r1",
    ]);
  });

  it("never reaches the effect's configured deltaSink", async () => {
    const configured: EffectDelta[] = [];
    const eff = new LlmEffect<unknown, string>(
      async (_i, ctx: EffectContext) => {
        ctx.onDelta?.({ delta: tainted("", "t"), reasoning: tainted("r1", "t") });
        ctx.onDelta?.({ delta: tainted("text", "t") });
        return "done";
      },
      { deltaSink: (c: EffectDelta) => configured.push(c) }
    );
    const rt = new EffectRuntime();
    rt.register("e", eff);
    await rt.invokeTransient("e", {}, { onDelta: () => {} });
    expect(configured.map((c) => unwrapTainted(c.delta))).toEqual(["text"]);
  });
  it("reaches the configured reasoningSink only through the guards, tainted, and never the text sink", async () => {
    const seen: string[] = [];
    const text: string[] = [];
    const reasoning: string[] = [];
    const eff = new LlmEffect<unknown, string>(
      async (_i, ctx: EffectContext) => {
        ctx.onDelta?.({ delta: tainted("", "t"), reasoning: tainted("r1", "t") });
        ctx.onDelta?.({ delta: tainted("text", "t") });
        ctx.onDelta?.({ delta: tainted("", "t"), reasoning: tainted("BAD", "t") });
        return "done";
      },
      {
        deltaSink: (c: EffectDelta) => text.push(unwrapTainted(c.delta)),
        reasoningSink: (d) => reasoning.push(unwrapTainted(d)),
      }
    );
    const rt = new EffectRuntime([guard(seen)]);
    rt.register("e", eff);
    await expect(
      rt.execute("e", {}, { executionId: "x", stepId: "s", workflowId: "w", attempt: 1 } as never)
    ).rejects.toThrow("severed");
    expect(reasoning).toEqual(["r1"]); // BAD was severed before delivery
    expect(text).toEqual(["text"]);
  });

  it("an effect with ONLY a reasoningSink still gets the governed pipe", async () => {
    const reasoning: string[] = [];
    const eff = new LlmEffect<unknown, string>(
      async (_i, ctx: EffectContext) => {
        ctx.onDelta?.({ delta: tainted("", "t"), reasoning: tainted("r1", "t") });
        return "done";
      },
      { reasoningSink: (d) => reasoning.push(unwrapTainted(d)) }
    );
    const rt = new EffectRuntime();
    rt.register("e", eff);
    await rt.execute("e", {}, {
      executionId: "x",
      stepId: "s",
      workflowId: "w",
      attempt: 1,
    } as never);
    expect(reasoning).toEqual(["r1"]);
  });
});
