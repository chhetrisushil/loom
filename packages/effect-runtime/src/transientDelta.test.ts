import { describe, expect, it } from "vitest";
import { EffectRuntime } from "./EffectRuntime";
import { ToolEffect } from "./effects/ToolEffect";
import type { DeltaSink, EffectDelta } from "./types";

// ADR 0119 — the per-call sink's lifetime, on the bare runtime (no decide scope, so no
// scope signal that would mask a missing `settled` flag).

const tv = (value: string) => ({ __loomTainted: { origin: "t" }, value });

describe("EffectRuntime.invokeTransient onDelta lifetime (ADR 0119)", () => {
  it("is SILENT once the call settled: a late write through a stashed sink reaches nobody", async () => {
    let stashed: DeltaSink | undefined;
    const rt = new EffectRuntime([]);
    rt.register(
      "m",
      new ToolEffect(async (_i: unknown, ctx) => {
        stashed = ctx.onDelta;
        ctx.onDelta?.({ delta: tv("a") });
        return "ok";
      })
    );
    const got: EffectDelta[] = [];
    await rt.invokeTransient("m", {}, { onDelta: (d) => got.push(d) });
    expect(got.map((d) => d.delta.value)).toEqual(["a"]);
    stashed?.({ delta: tv("LATE") });
    stashed?.({ delta: tv(""), done: true });
    expect(got).toHaveLength(1);
  });

  it("is silent once the call's signal aborted, even if the effect ignores it", async () => {
    const ac = new AbortController();
    const rt = new EffectRuntime([]);
    rt.register(
      "m",
      new ToolEffect(async (_i: unknown, ctx) => {
        ctx.onDelta?.({ delta: tv("a") });
        ac.abort();
        ctx.onDelta?.({ delta: tv("b") });
        return "ok";
      })
    );
    const got: string[] = [];
    await rt.invokeTransient(
      "m",
      {},
      { signal: ac.signal, onDelta: (d) => got.push(d.delta.value) }
    );
    expect(got).toEqual(["a"]);
  });
});
