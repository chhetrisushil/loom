import { describe, expect, it } from "vitest";
import { decoratedInnerOf, forwardStoreMarkers, installOptional } from "./installOptional";

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

  it("carries the tenant marker (ADR 0138 H3) up, never overwriting a decorator's own", () => {
    const outer: Record<string, unknown> = {};
    installOptional(outer, { tenantScope: "acme" }, {});
    expect(outer.tenantScope).toBe("acme");
    const own: Record<string, unknown> = { tenantScope: "mine" };
    forwardStoreMarkers(own, { tenantScope: "acme" });
    expect(own.tenantScope).toBe("mine");
    const none: Record<string, unknown> = {};
    forwardStoreMarkers(none, {});
    expect("tenantScope" in none).toBe(false);
  });

  it("records who a decorator wraps, so a layer that hides `inner` can still be walked", () => {
    const inner = { tenantScope: "acme" };
    const outer = {};
    installOptional(outer, inner, {});
    expect(decoratedInnerOf(outer)).toBe(inner);
    expect(decoratedInnerOf({})).toBeUndefined();
  });
});
