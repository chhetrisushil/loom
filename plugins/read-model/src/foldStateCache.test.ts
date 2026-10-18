import { describe, expect, it } from "vitest";
import { FoldStateCache } from "./foldStateCache";

const base = (sequence: number) => ({ sequence, state: { n: sequence }, erased: false });

describe("FoldStateCache (ADR 0132 D15)", () => {
  it("take returns the entry and REMOVES it, so a failed fold never leaves a half-mutated base behind", () => {
    const c = new FoldStateCache(4);
    c.put("m", "x", base(2));
    expect(c.take("m", "x")).toEqual(base(2));
    expect(c.take("m", "x")).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it("evicts the least recently used entry beyond maxEntries", () => {
    const c = new FoldStateCache(2);
    c.put("m", "a", base(1));
    c.put("m", "b", base(1));
    c.put("m", "c", base(1)); // a is the oldest
    expect(c.size).toBe(2);
    expect(c.take("m", "a")).toBeUndefined();
    expect(c.take("m", "b")).toBeDefined();
  });

  it("a re-put makes the key the most recent", () => {
    const c = new FoldStateCache(2);
    c.put("m", "a", base(1));
    c.put("m", "b", base(1));
    c.put("m", "a", base(2));
    c.put("m", "c", base(1)); // b is now the oldest
    expect(c.take("m", "b")).toBeUndefined();
    expect(c.take("m", "a")).toEqual(base(2));
  });

  it("keys are per model", () => {
    const c = new FoldStateCache(4);
    c.put("m1", "x", base(1));
    c.put("m2", "x", base(5));
    expect(c.take("m2", "x")).toEqual(base(5));
  });

  it("deleteModel drops one model's entries only; clear drops all", () => {
    const c = new FoldStateCache(8);
    c.put("m1", "a", base(1));
    c.put("m1", "b", base(1));
    c.put("m2", "a", base(1));
    c.deleteModel("m1");
    expect(c.size).toBe(1);
    c.clear();
    expect(c.size).toBe(0);
  });

  it("refuses a non-positive or fractional size (disable by not constructing one)", () => {
    expect(() => new FoldStateCache(0)).toThrow(RangeError);
    expect(() => new FoldStateCache(1.5)).toThrow(RangeError);
  });
});
