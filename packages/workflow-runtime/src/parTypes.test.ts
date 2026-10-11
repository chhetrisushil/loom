// Type-level tests (checked by `pnpm typecheck:tests`); the functions are never called.
import type { StepDefinition } from "@loom/core";
import { describe, expectTypeOf, it } from "vitest";
import type { ExecutionContext } from "./types";

declare const ctx: ExecutionContext;
declare const byId: StepDefinition<{ id: string }, { n: number }>;
declare const byName: StepDefinition<{ name: string }, string>;

describe("ctx.parallel typing", () => {
  it("accepts typed-input steps, types outputs, rejects a wrong input (type-level only)", () => {
    const run = async (): Promise<void> => {
      const [a, b, c] = await ctx.parallel([
        [byId, { id: "x" }],
        [byName, { name: "y" }],
        async () => true,
      ]);
      expectTypeOf(a).toEqualTypeOf<{ n: number }>();
      expectTypeOf(b).toEqualTypeOf<string>();
      expectTypeOf(c).toEqualTypeOf<boolean>();
      // @ts-expect-error a wrong input for a typed step is rejected
      await ctx.parallel([[byId, { name: "x" }]]);
      // @ts-expect-error swapped inputs
      await ctx.parallel([
        [byId, { id: "x" }],
        [byName, { id: "x" }],
      ]);
    };
    expectTypeOf(run).toBeFunction();
  });

  it("keeps the explicit result-tuple form and never runs (type-level only)", () => {
    const explicit = (): Promise<[{ n: number }, string]> =>
      ctx.parallel<[{ n: number }, string]>([
        [byId, { id: "x" }],
        [byName, { name: "y" }],
      ]);
    expectTypeOf(explicit).returns.resolves.toEqualTypeOf<[{ n: number }, string]>();
    // a function-branch list of unknown length keeps its element type
    const list = (): Promise<number[]> => ctx.parallel([1, 2].map((n) => async () => n));
    expectTypeOf(list).returns.resolves.toEqualTypeOf<number[]>();
  });
});
