import { describe, expect, it } from "vitest";
import { EffectRuntime } from "./EffectRuntime";
import { ToolEffect } from "./effects/ToolEffect";

// K9.3 — the effect registry is where the kernel reads a tool's declared
// delivery semantic; recovery's park-vs-rerun decision hangs off this.
describe("K9 — declaredIdempotence", () => {
  it("reports the registered effect's declaration; undeclared/unknown → undefined (G2)", () => {
    const rt = new EffectRuntime();
    rt.register("mutate", new ToolEffect(async () => ({}), { idempotent: false }));
    rt.register("safe", new ToolEffect(async () => ({}), { idempotent: true }));
    rt.register("legacy", new ToolEffect(async () => ({})));

    expect(rt.declaredIdempotence("mutate")).toBe(false);
    expect(rt.declaredIdempotence("safe")).toBe(true);
    expect(rt.declaredIdempotence("legacy")).toBeUndefined();
    expect(rt.declaredIdempotence("not-registered")).toBeUndefined();
  });
});
