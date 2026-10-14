import { describe, expect, it } from "vitest";
import { installOptional } from "./installOptional";

describe("installOptional structural markers", () => {
  it("carries `keys` and `sealsWholeState` (ADR 0130 D8) up to a wrapping decorator", () => {
    const keys = { durable: true };
    const inner = { keys, sealsWholeState: true as const };
    const outer: Record<string, unknown> = {};
    installOptional(outer, inner, {});
    expect(outer.keys).toBe(keys);
    expect(outer.sealsWholeState).toBe(true);
  });

  it("does not invent sealsWholeState for a store that lacks it", () => {
    const outer: Record<string, unknown> = {};
    installOptional(outer, { keys: {} }, {});
    expect("sealsWholeState" in outer).toBe(false);
  });
});
