import { describe, expect, it } from "vitest";
import { TAINT_SCAN_EXCEEDED_ORIGIN, nestedTaintOrigin, scanTaint, tainted } from "./index";

describe("scanTaint", () => {
  it("is clean for a value with no wrapper, primitives and null included", () => {
    for (const v of [1, "s", null, undefined, { a: [1, { b: "__loomTainted" }] }]) {
      expect(scanTaint(v)).toEqual({ origins: [], exceeded: false, tainted: false });
      expect(nestedTaintOrigin(v)).toBeUndefined();
    }
  });

  it("finds a top-level and nested wrappers, distinct origins in discovery order", () => {
    const v = { a: tainted("x", "o1"), b: [tainted("y", "o2"), { c: tainted("z", "o1") }] };
    expect(scanTaint(v).origins).toEqual(["o1", "o2"]);
    expect(nestedTaintOrigin(v)).toBe("o1, o2");
    expect(scanTaint(tainted(1, "top")).origins).toEqual(["top"]);
  });

  it("finds a wrapper inside another wrapper", () => {
    const inner = { __loomTainted: { origin: "in" }, value: 1 };
    const outer = { __loomTainted: { origin: "out" }, value: { inner } };
    expect(scanTaint(outer).origins).toEqual(["out", "in"]);
  });

  it("is cycle-safe", () => {
    const a: Record<string, unknown> = { t: tainted(1, "c") };
    a.self = a;
    expect(scanTaint(a).origins).toEqual(["c"]);
  });

  it("FAILS CLOSED past the depth bound, with no stack overflow on a 200k-deep value", () => {
    let deep: unknown = {};
    for (let i = 0; i < 200_000; i++) deep = { n: deep };
    const s = scanTaint(deep);
    expect(s.exceeded).toBe(true);
    expect(s.tainted).toBe(true);
    expect(nestedTaintOrigin(deep)).toBe(TAINT_SCAN_EXCEEDED_ORIGIN);
  });

  it("FAILS CLOSED past the node bound", () => {
    const wide = Array.from({ length: 50 }, () => ({}));
    expect(scanTaint(wide, { maxNodes: 10 }).exceeded).toBe(true);
    expect(scanTaint(wide, { maxNodes: 100 }).exceeded).toBe(false);
  });

  it("respects an exact depth boundary", () => {
    const v = { a: { b: { c: tainted(1, "d3") } } }; // wrapper node sits at depth 3
    expect(scanTaint(v, { maxDepth: 3 }).origins).toEqual(["d3"]);
    expect(scanTaint(v, { maxDepth: 2 }).exceeded).toBe(true);
  });

  it("skips binary views (they cannot hold a wrapper and would burn the node bound)", () => {
    const s = scanTaint({ bytes: new Uint8Array(500_000) }, { maxNodes: 10 });
    expect(s.tainted).toBe(false);
  });
});
