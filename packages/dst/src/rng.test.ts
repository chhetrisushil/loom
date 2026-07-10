import { describe, expect, it } from "vitest";
import { type Rng, seedFromLabel, splitmix64 } from "./rng";

const drawN = (rng: Rng, n: number): number[] => Array.from({ length: n }, () => rng.next());

describe("splitmix64", () => {
  it("is deterministic: same seed → same sequence", () => {
    expect(drawN(splitmix64(42n), 8)).toEqual(drawN(splitmix64(42n), 8));
  });

  it("differs across seeds", () => {
    expect(drawN(splitmix64(1n), 8)).not.toEqual(drawN(splitmix64(2n), 8));
  });

  it("next() stays in [0,1)", () => {
    const rng = splitmix64(7n);
    for (let i = 0; i < 1000; i++) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("int(n) stays in [0,n) and covers the range", () => {
    const rng = splitmix64(9n);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const v = rng.int(6);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
      seen.add(v);
    }
    expect(seen.size).toBe(6); // every face of a d6 appears
  });

  it("int(0) is 0, bool(0) never, bool(1) always", () => {
    const rng = splitmix64(3n);
    expect(rng.int(0)).toBe(0);
    expect(rng.bool(0)).toBe(false);
    expect(rng.bool(1)).toBe(true);
  });

  it("bool(p) approximates its probability", () => {
    const rng = splitmix64(11n);
    let hits = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) if (rng.bool(0.3)) hits++;
    expect(hits / N).toBeGreaterThan(0.27);
    expect(hits / N).toBeLessThan(0.33);
  });

  it("fork() yields independent, stable sub-streams", () => {
    const a = splitmix64(5n).fork("faults");
    const b = splitmix64(5n).fork("faults");
    const c = splitmix64(5n).fork("scenario");
    expect(drawN(a, 5)).toEqual(drawN(b, 5)); // same label + seed → same stream
    expect(drawN(splitmix64(5n).fork("faults"), 5)).not.toEqual(drawN(c, 5)); // different label
  });

  it("seedFromLabel is stable and label-sensitive", () => {
    expect(seedFromLabel("x")).toBe(seedFromLabel("x"));
    expect(seedFromLabel("x")).not.toBe(seedFromLabel("y"));
  });
});
