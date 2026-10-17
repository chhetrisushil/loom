import { beforeAll, describe, expect, it } from "vitest";
import { type Scores, failingMetrics } from "../gate";
import { scoreSkills, skillDefinitions, skillSearchWith, withRotatedDescriptions } from "./measure";
import { SKILL_THRESHOLDS } from "./thresholds";

// Skill discovery (`discovery: "search"`, ADR 0125 D12/D13): the right skill surfaces for an intent.

describe("skill discovery eval", () => {
  const scores: Record<string, Scores> = {};

  beforeAll(async () => {
    scores.combined = await scoreSkills(skillSearchWith(skillDefinitions(), "combined"));
    scores.twoRanker = await scoreSkills(skillSearchWith(skillDefinitions(), "two-ranker"));
    scores.shuffled = await scoreSkills(skillSearchWith(withRotatedDescriptions(1), "combined"));
  });

  it("the combined single index clears every floor", () => {
    expect(failingMetrics(scores.combined as Scores, SKILL_THRESHOLDS)).toEqual([]);
  });

  it("two rankers (a host skillRanker factory) clear the same floors", () => {
    expect(failingMetrics(scores.twoRanker as Scores, SKILL_THRESHOLDS)).toEqual([]);
  });

  it("FAIL-PROOF: shuffled skill descriptions drop hit@1 below the floor, and the failure names hit@1", () => {
    expect(failingMetrics(scores.shuffled as Scores, SKILL_THRESHOLDS)).toContain("hit@1");
    expect((scores.shuffled as Scores)["hit@1"]).toBeLessThan(
      (scores.combined as Scores)["hit@1"] as number
    );
  });
});
