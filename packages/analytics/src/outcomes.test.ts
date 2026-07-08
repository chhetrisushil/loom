import type { EventEnvelope } from "@loom/core";
import { describe, expect, it, vi } from "vitest";
import { outcomeAnalytics, rankFromOutcomes, recordOutcome } from "./outcomes";

let seq = 0;
function ev(eventType: string, payload: unknown = {}): EventEnvelope {
  seq += 1;
  return {
    id: `x-${seq}`,
    workflowId: "wf",
    executionId: "x",
    eventType,
    sequence: seq,
    timestamp: seq,
    payload,
  };
}

describe("learning seam — outcomes → rankings", () => {
  it("recordOutcome emits a durable OUTCOME_RECORDED fact", () => {
    const emit = vi.fn();
    recordOutcome({ emit }, { key: "opus", success: true, decisionId: "route:1" });
    expect(emit).toHaveBeenCalledWith(
      "OUTCOME_RECORDED",
      expect.objectContaining({ key: "opus", success: true, decisionId: "route:1" })
    );
  });

  it("ranks a higher-success key above a lower-success one (binary outcomes)", () => {
    seq = 0;
    const log = [
      ev("OUTCOME_RECORDED", { key: "model-a", success: false }),
      ev("OUTCOME_RECORDED", { key: "model-a", success: true }),
      ev("OUTCOME_RECORDED", { key: "model-b", success: true }),
      ev("OUTCOME_RECORDED", { key: "model-b", success: true }),
    ];
    const rankings = rankFromOutcomes(log);
    expect(rankings["model-b"]).toBe(1); // 2/2
    expect(rankings["model-a"]).toBe(0.5); // 1/2
    expect(rankings["model-b"]).toBeGreaterThan(rankings["model-a"] as number);

    // Closes the loop: feed these into `rankedRouter` (@loom/reasoning) and future
    // routes prefer model-b — its choice is then a logged DECISION_RECORDED (P9).
    const stats = outcomeAnalytics(log);
    expect(stats[0]?.key).toBe("model-b");
    expect(stats.map((s) => s.key)).toEqual(["model-b", "model-a"]);
  });

  it("averages continuous scores and prefers score over success", () => {
    seq = 0;
    const log = [
      ev("OUTCOME_RECORDED", { key: "fast", score: 0.9 }),
      ev("OUTCOME_RECORDED", { key: "fast", score: 0.7 }),
      ev("OUTCOME_RECORDED", { key: "slow", score: 0.2 }),
    ];
    const rankings = rankFromOutcomes(log);
    expect(rankings.fast).toBeCloseTo(0.8);
    expect(rankings.slow).toBeCloseTo(0.2);
  });

  it("ignores non-outcome events and malformed keys", () => {
    seq = 0;
    const log = [ev("STEP_COMPLETED", {}), ev("OUTCOME_RECORDED", { success: true }) /* no key */];
    expect(rankFromOutcomes(log)).toEqual({});
  });
});
