import { describe, expect, it } from "vitest";
import { exceedingMetrics, failingMetrics, toRows } from "./gate";

describe("exceedingMetrics (ceilings for cost metrics)", () => {
  it("names every metric above its ceiling and none at or below it", () => {
    expect(exceedingMetrics({ a: 3, b: 4.1 }, { a: 3, b: 4 })).toEqual(["b"]);
  });
  it("a ceiling whose metric is not computed FAILS, named (missing)", () => {
    expect(exceedingMetrics({}, { a: 1 })).toEqual(["a (missing)"]);
  });
  it("toRows gates a ceiling metric and flags it lowerIsBetter", () => {
    expect(toRows("x", { a: 1, c: 2 }, { a: 0.5 }, { c: 3 })).toEqual([
      { key: "x/a", value: 1, gated: true },
      { key: "x/c", value: 2, gated: true, lowerIsBetter: true },
    ]);
  });
});

describe("failingMetrics", () => {
  it("names every metric below its floor and none at or above it", () => {
    expect(failingMetrics({ a: 0.9, b: 0.5, c: 1 }, { a: 0.9, b: 0.6, c: 0.99 })).toEqual(["b"]);
  });
  it("a floor whose metric is not computed FAILS, named (missing): a gate nothing feeds is vacuous", () => {
    expect(failingMetrics({ a: 1 }, { a: 0.5, b: 0.5 })).toEqual(["b (missing)"]);
  });
});

describe("toRows", () => {
  it("prefixes the key and gates exactly the metrics that have a floor", () => {
    expect(toRows("x/y", { a: 1, b: 2 }, { a: 0.5 })).toEqual([
      { key: "x/y/a", value: 1, gated: true },
      { key: "x/y/b", value: 2, gated: false },
    ]);
  });
});
