import { describe, expect, it } from "vitest";
import { analyzeNonDeterminism } from "./nondeterminism";

describe("analyzeNonDeterminism", () => {
  it("flags non-deterministic calls reachable outside ctx.decide/ctx.execute", () => {
    const calls = analyzeNonDeterminism(
      "async (ctx) => { const t = Date.now(); const r = Math.random(); return { t, r }; }"
    );
    const names = calls.map((c) => c.callee).sort();
    expect(names).toEqual(["Date.now", "Math.random"]);
    expect(calls.every((c) => c.insideDecide === false)).toBe(true);
  });

  it("marks a call inside ctx.decide as insideDecide (safe — result is logged)", () => {
    const calls = analyzeNonDeterminism(`async (ctx) => ctx.decide("seed", () => Math.random())`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ callee: "Math.random", insideDecide: true });
  });

  it("marks a call inside ctx.execute as insideDecide", () => {
    const calls = analyzeNonDeterminism("async (ctx) => ctx.execute(step, () => Date.now())");
    expect(calls[0]?.insideDecide).toBe(true);
  });

  it("flags new Date() with no args but not new Date(arg)", () => {
    expect(analyzeNonDeterminism("() => new Date()").map((c) => c.callee)).toEqual(["new Date"]);
    expect(analyzeNonDeterminism(`() => new Date("2020-01-01")`)).toEqual([]);
  });

  it("flags bare fetch and crypto.randomUUID", () => {
    const calls = analyzeNonDeterminism(
      `async () => { await fetch("/x"); return crypto.randomUUID(); }`
    );
    expect(calls.map((c) => c.callee).sort()).toEqual(["crypto.randomUUID", "fetch"]);
  });

  it("attaches a location when given", () => {
    expect(analyzeNonDeterminism("() => Date.now()", "my-flow")[0]?.location).toBe("my-flow");
  });

  it("returns nothing for deterministic code", () => {
    expect(analyzeNonDeterminism("async (ctx) => ctx.run(step, { a: 1 })")).toEqual([]);
  });
});
