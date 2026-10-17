import { describe, expect, it } from "vitest";
import { hitAtK, mean, mrr, ndcgAtK, recallAtK, reciprocalRank } from "./metrics";

// Every expected value below is computed by hand in the comment beside it.

describe("recallAtK", () => {
  it("is the fraction of the relevant set found in the top k", () => {
    // relevant {a,b,c,d}; top-3 of [a,x,b,c,d] holds a,b -> 2/4
    expect(recallAtK(["a", "x", "b", "c", "d"], ["a", "b", "c", "d"], 3)).toBe(0.5);
    // top-5 holds all four
    expect(recallAtK(["a", "x", "b", "c", "d"], ["a", "b", "c", "d"], 5)).toBe(1);
  });
  it("treats k larger than the list as the whole list", () => {
    expect(recallAtK(["a"], ["a", "b"], 50)).toBe(0.5);
  });
  it("scores 0 for an empty relevant set, an empty list, or k <= 0", () => {
    expect(recallAtK(["a"], [], 3)).toBe(0);
    expect(recallAtK([], ["a"], 3)).toBe(0);
    expect(recallAtK(["a"], ["a"], 0)).toBe(0);
    expect(recallAtK(["a"], ["a"], -2)).toBe(0);
  });
  it("credits a repeated hit once", () => {
    // [a,a,a] holds one distinct relevant id of two
    expect(recallAtK(["a", "a", "a"], ["a", "b"], 3)).toBe(0.5);
  });
});

describe("hitAtK", () => {
  it("is 1 when any relevant id is in the top k", () => {
    expect(hitAtK(["x", "y", "a"], ["a", "b"], 3)).toBe(1);
    expect(hitAtK(["x", "y", "a"], ["a", "b"], 2)).toBe(0);
  });
  it("is 0 for an empty relevant set and for k <= 0", () => {
    expect(hitAtK(["a"], [], 3)).toBe(0);
    expect(hitAtK(["a"], ["a"], 0)).toBe(0);
  });
});

describe("reciprocalRank / mrr", () => {
  it("is 1 / rank of the first relevant id", () => {
    expect(reciprocalRank(["x", "y", "a", "b"], ["a", "b"])).toBeCloseTo(1 / 3, 12);
    expect(reciprocalRank(["a"], ["a"])).toBe(1);
  });
  it("is 0 when nothing relevant is ranked, and for an empty relevant set", () => {
    expect(reciprocalRank(["x"], ["a"])).toBe(0);
    expect(reciprocalRank(["a"], [])).toBe(0);
  });
  it("ranks a repeated id at its first position only", () => {
    // [x,x,a]: after de-duplication a is 2nd, not 3rd
    expect(reciprocalRank(["x", "x", "a"], ["a"])).toBe(0.5);
  });
  it("mrr is the mean of the reciprocal ranks", () => {
    // (1 + 1/2 + 0) / 3 = 0.5
    expect(
      mrr([
        { ranked: ["a"], relevant: ["a"] },
        { ranked: ["x", "b"], relevant: ["b"] },
        { ranked: ["x"], relevant: ["c"] },
      ])
    ).toBe(0.5);
  });
});

describe("mean", () => {
  it("averages, and an empty list is 0 rather than NaN", () => {
    expect(mean([1, 2, 6])).toBe(3);
    expect(mean([])).toBe(0);
  });
});

describe("ndcgAtK", () => {
  const gains = { a: 2, b: 1, c: 0 };
  it("is 1 for the ideal ordering", () => {
    expect(ndcgAtK(["a", "b", "x"], gains, 3)).toBeCloseTo(1, 12);
  });
  it("discounts a swapped ordering", () => {
    // gain = 2^g - 1: a -> 3, b -> 1. discount log2(rank + 1): 1, log2(3), log2(4) = 2
    // ranked [b, a]: dcg = 1/1 + 3/log2(3) = 2.892789...
    // ideal  [a, b]: idcg = 3/1 + 1/log2(3) = 3.630930...   ratio = 0.79669...
    expect(ndcgAtK(["b", "a", "x"], gains, 3)).toBeCloseTo(0.7967, 4);
  });
  it("cuts both the list and the ideal at k", () => {
    // k = 1, ranked [b]: dcg = 1, ideal [a] = 3 -> 1/3
    expect(ndcgAtK(["b", "a"], gains, 1)).toBeCloseTo(1 / 3, 12);
  });
  it("is binary nDCG when every grade is 1", () => {
    // relevant {a,b}: ranked [x,a,b]: dcg = 0 + 1/log2(3) + 1/2; ideal = 1 + 1/log2(3)
    const dcg = 1 / Math.log2(3) + 1 / 2;
    const idcg = 1 + 1 / Math.log2(3);
    expect(ndcgAtK(["x", "a", "b"], { a: 1, b: 1 }, 10)).toBeCloseTo(dcg / idcg, 12);
  });
  it("scores 0 with no graded id, with an empty list, and for k <= 0", () => {
    expect(ndcgAtK(["a"], {}, 5)).toBe(0);
    expect(ndcgAtK(["a"], { a: 0 }, 5)).toBe(0);
    expect(ndcgAtK([], gains, 5)).toBe(0);
    expect(ndcgAtK(["a"], gains, 0)).toBe(0);
  });
  it("credits a repeated hit once", () => {
    expect(ndcgAtK(["a", "a", "a"], { a: 1 }, 3)).toBeCloseTo(1, 12);
  });
});
