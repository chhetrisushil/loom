import { describe, expect, it } from "vitest";
import { isTainted, taintOf, tainted, unwrapTainted } from "./taint";

describe("the integrity axis", () => {
  it("wraps a value with its origin, leaving the value reachable", () => {
    const t = tainted("body", "mcp:acme/chart");
    expect(t).toEqual({ __loomTainted: { origin: "mcp:acme/chart" }, value: "body" });
    expect(unwrapTainted(t)).toBe("body");
    expect(taintOf(t)?.origin).toBe("mcp:acme/chart");
  });

  it("survives a JSON round-trip — which is what makes it survive the log", () => {
    // The whole design rests on this: the wrapper IS the step output, so it is
    // what STEP_COMPLETED records and what a replay hands back.
    const t = tainted({ rows: [1, 2] }, "a2a:peer-7");
    const roundTripped: unknown = JSON.parse(JSON.stringify(t));
    expect(isTainted(roundTripped)).toBe(true);
    expect(taintOf(roundTripped)?.origin).toBe("a2a:peer-7");
  });

  it("keeps the ORIGINAL origin when re-tainted", () => {
    // Provenance records where content entered. A re-wrap must not let a later,
    // more flattering label overwrite the true one.
    const once = tainted("body", "mcp:acme/chart");
    expect(taintOf(tainted(once, "trusted-internal"))?.origin).toBe("mcp:acme/chart");
  });

  it("does not mistake look-alike objects for taint", () => {
    expect(isTainted({ __loomTainted: { origin: "x" } })).toBe(false); // no `value`
    expect(isTainted({ __loomTainted: "x", value: 1 })).toBe(false); // mark not an object
    expect(isTainted({ __loomTainted: {}, value: 1 })).toBe(false); // no origin
    expect(isTainted({ value: 1 })).toBe(false);
    expect(isTainted("plain")).toBe(false);
    expect(isTainted(null)).toBe(false);
  });

  it("tolerates a tainted falsy or nullish value", () => {
    const t = tainted(null, "o");
    expect(isTainted(t)).toBe(true);
    expect(unwrapTainted(t)).toBeNull();
    expect(unwrapTainted(tainted("", "o"))).toBe("");
  });

  it("unwraps a plain value unchanged, so callers need no guard", () => {
    expect(unwrapTainted("plain")).toBe("plain");
    expect(unwrapTainted(7)).toBe(7);
  });
});
