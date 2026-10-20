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
});
