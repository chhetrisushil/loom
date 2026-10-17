import { describe, expect, it } from "vitest";
import { failingMetrics, toRows } from "./gate";

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
