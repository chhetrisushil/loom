import { describe, expect, it } from "vitest";
import { REACH_DECLARATION, declareReach, readReachDeclaration } from "./reach";

describe("reach declarations (L32)", () => {
  it("uses the well-known Symbol.for key so a 3P library needs no import", () => {
    expect(REACH_DECLARATION).toBe(Symbol.for("loom.verify.reach"));
    const lib = { compose() {} };
    Object.defineProperty(lib, Symbol.for("loom.verify.reach"), { value: { run: ["a"] } });
    expect(readReachDeclaration(lib)).toEqual({ run: ["a"] });
  });

  it("declareReach attaches non-enumerably and works on functions", () => {
    const fn = declareReach(() => 1, { transient: ["t"] });
    expect(readReachDeclaration(fn)).toEqual({ transient: ["t"] });
    const obj = declareReach({ x: 1 }, { run: [] });
    expect(JSON.stringify(obj)).toBe('{"x":1}');
    expect(readReachDeclaration(obj)).toEqual({ run: [] });
  });

  it("accepts a plain literal, and treats malformed or absent declarations as undeclared", () => {
    expect(readReachDeclaration({ transient: ["t"] })).toEqual({ transient: ["t"] });
    expect(readReachDeclaration({})).toBeUndefined();
    expect(readReachDeclaration({ run: "x" })).toBeUndefined();
    expect(readReachDeclaration({ run: [1] })).toBeUndefined();
    expect(readReachDeclaration(declareReach({}, { run: 5 as never }))).toBeUndefined();
    expect(readReachDeclaration(null)).toBeUndefined();
    expect(readReachDeclaration("planner")).toBeUndefined();
  });
});
