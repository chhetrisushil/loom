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

describe("learning seam — recency decay", () => {
  function at(ts: number, key: string, success: boolean): EventEnvelope {
    return {
      id: `o-${ts}-${key}`,
      workflowId: "wf",
      executionId: "x",
      eventType: "OUTCOME_RECORDED",
      sequence: ts,
      timestamp: ts,
      payload: { key, success },
    };
  }
  const DAY = 86_400_000;

  it("defaults to the flat lifetime mean (every outcome weighted equally)", () => {
    const log = [at(0, "a", true), at(0, "a", true), at(10 * DAY, "a", false)];
    expect(outcomeAnalytics(log)[0]?.rank).toBeCloseTo(2 / 3);
  });

  it("lets recent behaviour outvote an old reputation", () => {
    // "a" was great 30 days ago and has been failing since — the flat mean still
    // calls it a coin flip; with a 1-day half-life the stale wins barely count.
    const log = [
      at(0, "a", true),
      at(0, "a", true),
      at(0, "a", true),
      at(30 * DAY, "a", false),
      at(30 * DAY, "a", false),
      at(30 * DAY, "a", false),
    ];
    expect(outcomeAnalytics(log)[0]?.rank).toBeCloseTo(0.5);
    expect(outcomeAnalytics(log, { halfLifeMs: DAY })[0]?.rank).toBeLessThan(0.01);
  });

  it("decays against the newest outcome, not the wall clock (replay-stable)", () => {
    const log = [at(1_000, "a", true), at(2_000, "a", false)];
    const first = outcomeAnalytics(log, { halfLifeMs: 1_000 });
    const again = outcomeAnalytics(log, { halfLifeMs: 1_000 });
    expect(first).toEqual(again);
    // now = 2_000: the win is one half-life old (w=0.5), the loss is current (w=1).
    expect(first[0]?.rank).toBeCloseTo(0.5 / 1.5);
    expect(first[0]?.count).toBe(2); // raw count is untouched by weighting
  });

  it("honours an explicit `now` and never up-weights the future", () => {
    const log = [at(1_000, "a", true)];
    expect(outcomeAnalytics(log, { halfLifeMs: 1_000, now: 0 })[0]?.rank).toBeCloseTo(1);
  });

  it("rejects a non-positive half-life", () => {
    expect(() => outcomeAnalytics([], { halfLifeMs: 0 })).toThrow(/halfLifeMs/);
    expect(() => rankFromOutcomes([], { halfLifeMs: -1 })).toThrow(/halfLifeMs/);
  });
});
