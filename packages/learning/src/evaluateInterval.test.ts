import { describe, expect, it } from "vitest";
import { evaluatePolicy, formatEvalReport } from "./evaluate";
import { promotionGate } from "./promote";
import { seededRandom } from "./stats";
import type { Policy, Trajectory } from "./types";

// Synthetic logs with a KNOWN true value. Two arms, A pays 0.3 and B pays 0.7 on average; the
// logging policy picks uniformly (propensity 0.5), so the candidate "always B" is worth 0.7 and
// the logged value is 0.5. Everything is drawn from a seeded generator: no flake, no clock.

const ACTIONS = ["A", "B"];

function log(units: number, perUnit: number, seed: number, noise = 0): Trajectory<string>[] {
  const rand = seededRandom(seed);
  const out: Trajectory<string>[] = [];
  for (let u = 0; u < units; u++) {
    const bias = (rand() - 0.5) * noise; // a per-unit shift: correlated steps within a unit
    const steps = [];
    for (let i = 0; i < perUnit; i++) {
      const action = rand() < 0.5 ? "A" : "B";
      const p = action === "A" ? 0.3 : 0.7;
      const reward = Math.min(1, Math.max(0, (rand() < p ? 1 : 0) + bias));
      steps.push({
        decisionId: `d${i}`,
        executionId: `x${u}`,
        sequence: i,
        timestamp: i,
        action,
        context: { u, i },
        policy: { id: "uniform", version: "1", propensity: 0.5 },
        actions: ACTIONS,
        reward,
        rewardSource: "direct" as const,
      });
    }
    out.push({ executionId: `x${u}`, unit: `u${u}`, steps, outcome: "completed" });
  }
  return out;
}

const alwaysB: Policy<string> = {
  id: "always-b",
  version: "1",
  select: () => ({ action: "B" }),
};
const alwaysA: Policy<string> = {
  id: "always-a",
  version: "1",
  select: () => ({ action: "A" }),
};

describe("evaluatePolicy - doubly robust and bootstrap intervals (R18)", () => {
  it("keeps the SNIPS number and report shape unchanged when the new options are absent", () => {
    const report = evaluatePolicy(log(40, 25, 7), alwaysB);
    expect(report.doublyRobust).toBeUndefined();
    expect(report.intervals).toBeUndefined();
    expect(report.estimator).toBe("snips");
  });

  it("recovers the known value with SNIPS and doubly-robust, and the CI covers it", () => {
    const traj = log(60, 30, 11);
    const report = evaluatePolicy(traj, alwaysB, {
      doublyRobust: true,
      bootstrap: { resamples: 500, seed: 3 },
    });
    expect(report.estimatedValue).toBeGreaterThan(0.64);
    expect(report.estimatedValue).toBeLessThan(0.76);
    expect(report.doublyRobust?.value).toBeGreaterThan(0.64);
    expect(report.doublyRobust?.value).toBeLessThan(0.76);
    expect(report.doublyRobust?.rewardModel).toBe("fitted");
    for (const iv of [report.intervals?.snips, report.intervals?.dr]) {
      expect(iv).toBeDefined();
      expect(iv?.value.lower).toBeLessThanOrEqual(0.7);
      expect(iv?.value.upper).toBeGreaterThanOrEqual(0.7);
      expect(iv?.clusters).toBe("unit");
      expect(iv?.clusterCount).toBe(60);
      // true lift is 0.2, strictly positive and well resolved at this sample size
      expect(iv?.lift.lower).toBeGreaterThan(0);
    }
  });

  it("is deterministic: same inputs and seed give the identical report, another seed differs", () => {
    const traj = log(30, 20, 5);
    const opts = { doublyRobust: true as const, bootstrap: { resamples: 300, seed: 9 } };
    const a = evaluatePolicy(traj, alwaysB, opts);
    const b = evaluatePolicy(traj, alwaysB, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = evaluatePolicy(traj, alwaysB, { ...opts, bootstrap: { resamples: 300, seed: 10 } });
    expect(c.intervals?.snips?.lift.lower).not.toBe(a.intervals?.snips?.lift.lower);
  });

  it("a worse candidate's interval sits below zero lift, so the CI gate refuses it", () => {
    const report = evaluatePolicy(log(60, 30, 13), alwaysA, {
      bootstrap: { resamples: 500 },
    });
    expect(report.intervals?.snips?.lift.upper).toBeLessThan(0);
    const verdict = promotionGate(report, {
      minSteps: 10,
      requireEstimate: true,
      minLift: -1,
      minLiftLowerBound: 0,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/lower bound/);
  });

  it("the CI gate passes a clearly better candidate and FAILS a report with no interval", () => {
    const traj = log(60, 30, 17);
    const good = evaluatePolicy(traj, alwaysB, { bootstrap: { resamples: 500 } });
    expect(promotionGate(good, { minSteps: 100, minLiftLowerBound: 0, minUnits: 10 }).ok).toBe(
      true
    );
    const bare = evaluatePolicy(traj, alwaysB);
    const verdict = promotionGate(bare, { minSteps: 100, minLiftLowerBound: 0 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/no .*confidence interval/);
  });

  it("a point estimate that is positive on thin, noisy evidence has an interval straddling zero", () => {
    const report = evaluatePolicy(log(4, 3, 21, 0.6), alwaysB, { bootstrap: { resamples: 300 } });
    const iv = report.intervals?.snips;
    expect(iv).toBeDefined();
    expect(iv?.lift.lower).toBeLessThan(0);
    expect(report.warnings.join(" ")).toMatch(/resamples only 4 cluster/);
  });

  it("DR uses a supplied reward model and reports it", () => {
    const truth = (_c: unknown, a: unknown) => (a === "B" ? 0.7 : 0.3);
    const report = evaluatePolicy(log(40, 25, 29), alwaysB, {
      doublyRobust: { rewardModel: truth },
    });
    expect(report.doublyRobust?.rewardModel).toBe("supplied");
    expect(report.doublyRobust?.value).toBeGreaterThan(0.66);
    expect(report.doublyRobust?.value).toBeLessThan(0.74);
  });

  it("with no unit attribution it resamples executions, and says so", () => {
    const traj = log(30, 10, 31).map(({ unit: _u, ...t }) => t as Trajectory<string>);
    const report = evaluatePolicy(traj, alwaysB, { bootstrap: { resamples: 200 } });
    expect(report.intervals?.snips?.clusters).toBe("execution");
  });

  it("refuses nonsense bootstrap options", () => {
    const traj = log(5, 5, 1);
    expect(() => evaluatePolicy(traj, alwaysB, { bootstrap: { resamples: 5 } })).toThrow(
      /resamples/
    );
    expect(() => evaluatePolicy(traj, alwaysB, { bootstrap: { level: 1.5 } })).toThrow(/level/);
    expect(() => evaluatePolicy(traj, alwaysB, { bootstrap: { resamples: 1_000_000 } })).toThrow(
      /resamples/
    );
  });

  it("formats the new lines", () => {
    const text = formatEvalReport(
      evaluatePolicy(log(20, 10, 2), alwaysB, { doublyRobust: true, bootstrap: { resamples: 200 } })
    );
    expect(text).toMatch(/doubly-robust value/);
    expect(text).toMatch(/95% CI/);
  });

  it("DR with no propensity anywhere is not computed and warns", () => {
    const traj = log(5, 5, 3).map((t) => ({
      ...t,
      steps: t.steps.map(({ policy: _p, ...s }) => s),
    })) as Trajectory<string>[];
    const report = evaluatePolicy(traj, alwaysB, { doublyRobust: true });
    expect(report.doublyRobust).toBeUndefined();
    expect(report.warnings.join(" ")).toMatch(/doubly-robust estimate requested/);
  });
});
