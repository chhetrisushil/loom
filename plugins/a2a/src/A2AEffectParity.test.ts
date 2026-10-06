import { A2AEffect as DeprecatedA2AEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { describe, expect, it } from "vitest";
import { A2AEffect } from "./A2AEffect";

// ADR 0115: effect-runtime keeps a deprecated copy of A2AEffect for one minor. The two must not
// drift while both exist.
describe("A2AEffect: plugin class and deprecated effect-runtime copy agree", () => {
  it("same kind and same behaviour on a stub", async () => {
    const fn = async (input: { n: number }, _ctx: EffectContext) => ({ doubled: input.n * 2 });
    const a = new A2AEffect(fn);
    const b = new DeprecatedA2AEffect(fn);
    expect(a.kind).toBe("a2a");
    expect(b.kind).toBe(a.kind);
    const ctx = {} as EffectContext;
    expect(await b.execute({ n: 3 }, ctx)).toEqual(await a.execute({ n: 3 }, ctx));
  });
});
