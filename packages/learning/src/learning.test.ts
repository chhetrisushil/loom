import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { decideWithPolicy } from "./decideWithPolicy";
import { evaluatePolicy, formatEvalReport } from "./evaluate";
import { policyManifest, promotionGate } from "./promote";
import { stableKey, steps, trajectories } from "./trajectories";
import type { Policy, PolicyContext } from "./types";

let seq = 0;
function ev(executionId: string, eventType: string, payload: unknown): EventEnvelope {
  seq += 1;
  return {
    id: `e-${seq}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence: seq,
    timestamp: 1000 + seq,
    payload,
  };
}

function decision(
  executionId: string,
  decisionId: string,
  choice: string,
  extra: Record<string, unknown> = {}
): EventEnvelope {
  return ev(executionId, "DECISION_RECORDED", { decisionId, choice, ...extra });
}

/** A policy that always picks a named action when it is available. */
function fixed(id: string, target: string, propensity?: number): Policy<string> {
  return {
    id,
    version: "1",
    select: (_ctx, actions) => ({
      action: actions.includes(target) ? target : (actions[0] as string),
      ...(propensity !== undefined && { propensity }),
    }),
  };
}

describe("trajectories — extraction", () => {
  it("pairs a decision with the outcome that names it", () => {
    seq = 0;
    const log = [
      ev("x", "EXECUTION_STARTED", {}),
      decision("x", "route", "opus", {
        context: { tokens: 100 },
        policy: { id: "p", version: "1", propensity: 0.6 },
        alternatives: ["gemma", "opus"],
      }),
      ev("x", "OUTCOME_RECORDED", { key: "opus", score: 0.8, decisionId: "route" }),
      ev("x", "EXECUTION_COMPLETED", {}),
    ];
    const [t] = trajectories<string>(log);
    expect(t?.outcome).toBe("completed");
    expect(t?.steps).toHaveLength(1);
    expect(t?.steps[0]).toMatchObject({
      decisionId: "route",
      action: "opus",
      context: { tokens: 100 },
      policy: { id: "p", version: "1", propensity: 0.6 },
      actions: ["gemma", "opus"],
      reward: 0.8,
      directReward: 0.8,
      rewardSource: "direct",
    });
  });

  it("averages several outcomes that score the same decision", () => {
    seq = 0;
    const log = [
      decision("x", "route", "opus"),
      ev("x", "OUTCOME_RECORDED", { key: "opus", score: 1, decisionId: "route" }),
      ev("x", "OUTCOME_RECORDED", { key: "opus", score: 0, decisionId: "route" }),
    ];
    expect(trajectories(log)[0]?.steps[0]?.reward).toBe(0.5);
  });

  it("assigns terminal credit only to decisions nothing measured", () => {
    seq = 0;
    const log = [
      decision("x", "a", "1"),
      decision("x", "b", "2"),
      ev("x", "OUTCOME_RECORDED", { key: "1", score: 0.25, decisionId: "a" }),
      ev("x", "EXECUTION_COMPLETED", {}),
    ];
    const [t] = trajectories(log);
    expect(t?.steps[0]).toMatchObject({ reward: 0.25, rewardSource: "direct" });
    expect(t?.steps[1]).toMatchObject({ reward: 1, rewardSource: "terminal" });
  });

  it("discounts terminal credit backwards from the last decision", () => {
    seq = 0;
    const log = [
      decision("x", "a", "1"),
      decision("x", "b", "2"),
      decision("x", "c", "3"),
      ev("x", "EXECUTION_COMPLETED", {}),
    ];
    const [t] = trajectories(log, { discount: 0.5 });
    expect(t?.steps.map((s) => s.reward)).toEqual([0.25, 0.5, 1]);
  });

  it("adds terminal credit on top of a measured reward only when asked", () => {
    seq = 0;
    const log = [
      decision("x", "a", "1"),
      ev("x", "OUTCOME_RECORDED", { key: "1", score: 0.25, decisionId: "a" }),
      ev("x", "EXECUTION_COMPLETED", {}),
    ];
    expect(trajectories(log)[0]?.steps[0]?.reward).toBe(0.25);
    expect(trajectories(log, { terminalCreditOnScored: true })[0]?.steps[0]?.reward).toBe(1.25);
  });

  it("leaves reward undefined when nothing scored the decision and nothing terminated", () => {
    seq = 0;
    const [t] = trajectories([decision("x", "a", "1")]);
    expect(t?.outcome).toBe("open");
    expect(t?.steps[0]?.reward).toBeUndefined();
    expect(t?.steps[0]?.rewardSource).toBe("none");
  });

  it("scores a failure as 0 rather than skipping it", () => {
    seq = 0;
    const log = [decision("x", "a", "1"), ev("x", "EXECUTION_FAILED", { error: "boom" })];
    expect(trajectories(log)[0]?.steps[0]).toMatchObject({ reward: 0, rewardSource: "terminal" });
  });

  it("assigns no terminal credit to a cancelled execution", () => {
    seq = 0;
    const log = [decision("x", "a", "1"), ev("x", "EXECUTION_CANCELLED", {})];
    expect(trajectories(log)[0]?.steps[0]?.rewardSource).toBe("none");
  });

  it("separates executions and keeps decisions in sequence order", () => {
    seq = 0;
    const log = [decision("x", "a", "1"), decision("y", "a", "2"), decision("x", "b", "3")];
    const ts = trajectories(log);
    expect(ts).toHaveLength(2);
    const x = ts.find((t) => t.executionId === "x");
    expect(x?.steps.map((s) => s.decisionId)).toEqual(["a", "b"]);
    expect(steps(ts)).toHaveLength(3);
  });

  it("recovers an action set from observed choices when alternatives were not recorded", () => {
    seq = 0;
    const log = [decision("x", "route", "opus"), decision("y", "route", "gemma")];
    const ts = trajectories<string>(log);
    for (const t of ts) expect(t.steps[0]?.actions.sort()).toEqual(["gemma", "opus"]);
  });

  it("prefers recorded alternatives over the observed-choice fallback", () => {
    seq = 0;
    const log = [
      decision("x", "route", "opus", { alternatives: ["opus", "sonnet", "haiku"] }),
      decision("y", "route", "gemma"),
    ];
    const x = trajectories<string>(log).find((t) => t.executionId === "x");
    expect(x?.steps[0]?.actions).toEqual(["opus", "sonnet", "haiku"]);
  });

  it("rejects a discount outside (0,1]", () => {
    expect(() => trajectories([], { discount: 0 })).toThrow(/discount/);
    expect(() => trajectories([], { discount: 1.5 })).toThrow(/discount/);
  });
});

describe("stableKey", () => {
  it("is order-insensitive for object actions", () => {
    expect(stableKey({ a: 1, b: 2 })).toBe(stableKey({ b: 2, a: 1 }));
    expect(stableKey({ a: 1 })).not.toBe(stableKey({ a: 2 }));
  });
});

describe("evaluatePolicy", () => {
  // A log where the cheap arm was chosen 80% of the time and did badly, while the
  // expensive arm was chosen 20% of the time and did well. A candidate that always
  // picks the expensive arm should estimate ABOVE the logged value.
  function explorationLog(): EventEnvelope[] {
    seq = 0;
    const out: EventEnvelope[] = [];
    for (let i = 0; i < 100; i++) {
      const exec = `x${i}`;
      const cheap = i % 5 !== 0; // 80% cheap
      out.push(
        decision(exec, "route", cheap ? "gemma" : "opus", {
          context: { tokens: 100 },
          alternatives: ["gemma", "opus"],
          policy: { id: "logger", version: "1", propensity: cheap ? 0.8 : 0.2 },
        })
      );
      out.push(
        ev(exec, "OUTCOME_RECORDED", {
          key: cheap ? "gemma" : "opus",
          score: cheap ? 0.2 : 0.9,
          decisionId: "route",
        })
      );
    }
    return out;
  }

  it("estimates a better policy above the logged value (SNIPS)", () => {
    const ts = trajectories<string>(explorationLog());
    const report = evaluatePolicy(ts, fixed("always-opus", "opus"));
    expect(report.estimator).toBe("snips");
    expect(report.evaluated).toBe(100);
    expect(report.agreement).toBeCloseTo(0.2);
    expect(report.loggedValue).toBeCloseTo(0.34); // 0.8*0.2 + 0.2*0.9
    expect(report.estimatedValue).toBeCloseTo(0.9); // opus's true mean
    expect(report.lift as number).toBeGreaterThan(0);
  });

  it("estimates a worse policy below the logged value", () => {
    const ts = trajectories<string>(explorationLog());
    const report = evaluatePolicy(ts, fixed("always-gemma", "gemma"));
    expect(report.estimatedValue).toBeCloseTo(0.2);
    expect(report.lift as number).toBeLessThan(0);
  });

  it("falls back to agreement-only, and says so, when no propensities were logged", () => {
    seq = 0;
    const log = [
      decision("x", "route", "opus", { context: { t: 1 }, alternatives: ["gemma", "opus"] }),
      ev("x", "OUTCOME_RECORDED", { key: "opus", score: 1, decisionId: "route" }),
    ];
    const report = evaluatePolicy(trajectories<string>(log), fixed("p", "opus"));
    expect(report.estimator).toBe("agreement-only");
    expect(report.estimatedValue).toBeUndefined();
    expect(report.lift).toBeUndefined();
    expect(report.warnings.join(" ")).toMatch(/no logged propensities/);
  });

  it("warns that a deterministic logging policy makes the estimate biased", () => {
    seq = 0;
    const log = [
      decision("x", "route", "opus", {
        context: { t: 1 },
        alternatives: ["gemma", "opus"],
        policy: { id: "logger", version: "1", propensity: 1 },
      }),
      ev("x", "OUTCOME_RECORDED", { key: "opus", score: 1, decisionId: "route" }),
    ];
    const report = evaluatePolicy(trajectories<string>(log), fixed("p", "opus"));
    expect(report.warnings.join(" ")).toMatch(/deterministic/);
  });

  it("counts skipped steps by reason instead of silently dropping them", () => {
    seq = 0;
    const log = [
      decision("x", "no-ctx", "a", { alternatives: ["a", "b"] }),
      decision("x", "no-reward", "a", { context: { t: 1 }, alternatives: ["a", "b"] }),
      ev("x", "OUTCOME_RECORDED", { key: "a", score: 1, decisionId: "no-ctx" }),
    ];
    const report = evaluatePolicy(trajectories<string>(log), fixed("p", "a"));
    expect(report.skipped.noContext).toBe(1);
    expect(report.skipped.noReward).toBe(1);
    expect(report.evaluated).toBe(0);
    expect(report.warnings.join(" ")).toMatch(/no evaluable steps/);
  });

  it("clips a runaway importance weight and reports that it did", () => {
    seq = 0;
    const log = [
      decision("x", "route", "opus", {
        context: { t: 1 },
        alternatives: ["gemma", "opus"],
        policy: { id: "logger", version: "1", propensity: 0.0001 }, // weight 10000
      }),
      ev("x", "OUTCOME_RECORDED", { key: "opus", score: 1, decisionId: "route" }),
    ];
    const report = evaluatePolicy(trajectories<string>(log), fixed("p", "opus"), {
      clipWeight: 10,
    });
    expect(report.warnings.join(" ")).toMatch(/importance-weight clip/);
  });

  it("reports effective sample size and warns when a few steps dominate", () => {
    seq = 0;
    const out: EventEnvelope[] = [];
    for (let i = 0; i < 50; i++) {
      const exec = `x${i}`;
      // One step logged at a tiny propensity swamps 49 ordinary ones.
      const p = i === 0 ? 0.01 : 0.9;
      out.push(
        decision(exec, "route", "opus", {
          context: { t: 1 },
          alternatives: ["gemma", "opus"],
          policy: { id: "logger", version: "1", propensity: p },
        })
      );
      out.push(ev(exec, "OUTCOME_RECORDED", { key: "opus", score: 1, decisionId: "route" }));
    }
    const report = evaluatePolicy(trajectories<string>(out), fixed("p", "opus"));
    expect(report.effectiveSampleSize as number).toBeLessThan(50);
    expect(report.warnings.join(" ")).toMatch(/dominate/);
  });

  it("renders a readable report", () => {
    const ts = trajectories<string>(explorationLog());
    const text = formatEvalReport(evaluatePolicy(ts, fixed("always-opus", "opus")));
    expect(text).toMatch(/always-opus@1/);
    expect(text).toMatch(/estimated value/);
  });
});

describe("promotionGate", () => {
  const base = {
    policy: { id: "p", version: "2" },
    evaluated: 5000,
    skipped: { noContext: 0, noActions: 0, noReward: 0 },
    agreement: 0.4,
    loggedValue: 0.3,
    estimatedValue: 0.5,
    estimator: "snips" as const,
    lift: 0.2,
    effectiveSampleSize: 2000,
    warnings: [],
  };

  it("passes a well-evidenced improvement", () => {
    expect(promotionGate(base)).toEqual({ ok: true, reasons: [] });
  });

  it("refuses thin evidence", () => {
    const v = promotionGate({ ...base, evaluated: 10, effectiveSampleSize: 5 });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/evaluable steps/);
  });

  it("refuses a policy with no unbiased estimate", () => {
    const v = promotionGate({
      ...base,
      estimator: "agreement-only",
      estimatedValue: undefined,
      lift: undefined,
    });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/propensity/);
  });

  it("refuses a regression", () => {
    expect(promotionGate({ ...base, lift: -0.01 }).ok).toBe(false);
  });

  it("refuses an estimate resting on too few effective samples", () => {
    const v = promotionGate({ ...base, effectiveSampleSize: 12 });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/effective sample size/);
  });

  it("can refuse a candidate that is really just the incumbent", () => {
    const v = promotionGate({ ...base, agreement: 0.99 }, { maxAgreement: 0.95 });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/barely differs/);
  });

  it("surfaces surviving warnings even when it passes", () => {
    const v = promotionGate({ ...base, warnings: ["3 step(s) hit the clip"] });
    expect(v).toEqual({ ok: true, reasons: ["3 step(s) hit the clip"] });
  });

  it("builds a pinnable manifest and rejects a nonsense canary", () => {
    const verdict = promotionGate(base);
    const m = policyManifest(base, verdict, { promotedAt: 42, canary: 0.05 });
    expect(m).toMatchObject({ policy: { id: "p", version: "2" }, promotedAt: 42, canary: 0.05 });
    expect(() => policyManifest(base, verdict, { canary: 2 })).toThrow(/canary/);
  });
});

describe("decideWithPolicy", () => {
  /** A ctx double that records once and replays from its own map, like the kernel. */
  function fakeCtx() {
    const recorded = new Map<string, unknown>();
    const emitted: { decisionId: string; opts: unknown }[] = [];
    return {
      emitted,
      recorded,
      async decide<T>(id: string, decider: () => T | Promise<T>, opts?: unknown): Promise<T> {
        if (recorded.has(id)) return recorded.get(id) as T;
        const choice = await decider();
        recorded.set(id, choice);
        emitted.push({ decisionId: id, opts });
        return choice;
      },
    };
  }

  it("records context, policy stamp with propensity, and the action set", async () => {
    const ctx = fakeCtx();
    const chosen = await decideWithPolicy(ctx, "route", fixed("p", "opus", 0.7), { tokens: 10 }, [
      "gemma",
      "opus",
    ]);
    expect(chosen).toBe("opus");
    expect(ctx.emitted[0]?.opts).toMatchObject({
      context: { tokens: 10 },
      policy: { id: "p", version: "1", propensity: 0.7 },
      alternatives: ["gemma", "opus"],
    });
  });

  it("omits propensity when the policy is deterministic", async () => {
    const ctx = fakeCtx();
    await decideWithPolicy(ctx, "route", fixed("p", "opus"), {}, ["gemma", "opus"]);
    const stamp = (ctx.emitted[0]?.opts as { policy: Record<string, unknown> }).policy;
    expect(stamp).toEqual({ id: "p", version: "1" });
  });

  it("refuses an empty action set", async () => {
    await expect(decideWithPolicy(fakeCtx(), "route", fixed("p", "x"), {}, [])).rejects.toThrow(
      /no actions/
    );
  });

  it("propagates a policy failure on the first run", async () => {
    const broken: Policy<string> = {
      id: "broken",
      version: "1",
      select: () => {
        throw new Error("bad context");
      },
    };
    await expect(decideWithPolicy(fakeCtx(), "route", broken, {}, ["a"])).rejects.toThrow(
      /bad context/
    );
  });

  it("does NOT break replay when the policy has since started throwing", async () => {
    // The hazard: `select` runs before `decide`, so a policy that now rejects an old
    // context could take down the replay of an execution recorded months ago. The
    // failure must stay inside the decider, which replay never calls.
    const ctx = fakeCtx();
    await decideWithPolicy(ctx, "route", fixed("p", "opus", 0.7), { tokens: 10 }, [
      "gemma",
      "opus",
    ]);

    const nowBroken: Policy<string> = {
      id: "p",
      version: "2",
      select: (c: PolicyContext) => {
        throw new Error(`unsupported context ${JSON.stringify(c)}`);
      },
    };
    await expect(
      decideWithPolicy(ctx, "route", nowBroken, { tokens: 10 }, ["gemma", "opus"])
    ).resolves.toBe("opus");
    expect(ctx.emitted).toHaveLength(1); // nothing new was recorded
  });
});

describe("pooled evaluation across units", () => {
  /**
   * `users` × `stepsPerUser` explorer decisions. `heavy` (if given) gets
   * `heavySteps` instead — the "one enthusiastic user" case.
   */
  function pooledLog(opts: {
    users: number;
    stepsPerUser: number;
    heavy?: string;
    heavySteps?: number;
    rewardFor?: (unit: string) => number;
  }): EventEnvelope[] {
    seq = 0;
    const out: EventEnvelope[] = [];
    for (let u = 0; u < opts.users; u++) {
      const unit = `user-${u}`;
      const n = unit === opts.heavy ? (opts.heavySteps ?? opts.stepsPerUser) : opts.stepsPerUser;
      for (let i = 0; i < n; i++) {
        const exec = `${unit}-x${i}`;
        out.push(
          decision(exec, "route", "opus", {
            context: { unit, t: i },
            alternatives: ["gemma", "opus"],
            policy: { id: "logger", version: "1", propensity: 0.2 },
          })
        );
        out.push(
          ev(exec, "OUTCOME_RECORDED", {
            key: "opus",
            score: opts.rewardFor?.(unit) ?? 0.9,
            decisionId: "route",
          })
        );
      }
    }
    return out;
  }

  const byContextUnit = {
    unitOf: (_id: string, ctx?: Record<string, unknown>) => ctx?.unit as string | undefined,
  };

  it("attributes each execution to its unit and counts the pool", () => {
    const ts = trajectories<string>(pooledLog({ users: 5, stepsPerUser: 4 }), byContextUnit);
    expect(new Set(ts.map((t) => t.unit)).size).toBe(5);

    const report = evaluatePolicy(ts, fixed("p", "opus"));
    expect(report.units).toBe(5);
    expect(report.evaluated).toBe(20);
    expect(report.unitEstimatedValue).toBeCloseTo(0.9);
  });

  it("pooling turns a thin per-unit budget into a usable one — the LP-8/LP-6 fix", () => {
    // 2 exploratory decisions per unit is uselessly thin alone…
    const alone = evaluatePolicy(
      trajectories<string>(pooledLog({ users: 1, stepsPerUser: 2 }), byContextUnit),
      fixed("p", "opus")
    );
    expect(promotionGate(alone, { minSteps: 50 }).ok).toBe(false);

    // …but 40 units at 2 each is 80 steps of real evidence.
    const pooled = evaluatePolicy(
      trajectories<string>(pooledLog({ users: 40, stepsPerUser: 2 }), byContextUnit),
      fixed("p", "opus")
    );
    expect(pooled.evaluated).toBe(80);
    expect(pooled.units).toBe(40);
    expect(promotionGate(pooled, { minSteps: 50, minEffectiveSamples: 10, minUnits: 20 }).ok).toBe(
      true
    );
  });

  it("refuses a pool that is really one enthusiastic user", () => {
    // 20 users, but one supplies 400 of the 419 decisions.
    const ts = trajectories<string>(
      pooledLog({ users: 20, stepsPerUser: 1, heavy: "user-0", heavySteps: 400 }),
      byContextUnit
    );
    const report = evaluatePolicy(ts, fixed("p", "opus"));

    expect(report.units).toBe(20);
    // Step-level ESS looks reassuring; unit-level ESS tells the truth.
    expect(report.effectiveSampleSize as number).toBeGreaterThan(300);
    expect(report.unitEffectiveSampleSize as number).toBeLessThan(2);
    expect(report.maxUnitWeightShare as number).toBeGreaterThan(0.9);
    expect(report.warnings.join(" ")).toMatch(/wearing a pooled label/);
    expect(promotionGate(report, { minSteps: 100, minUnits: 10 }).ok).toBe(false);
  });

  it("flags a heterogeneous population where the pooled number describes nobody", () => {
    // Half the users get 0.9, half get 0.1, and one heavy user drags the pool.
    const ts = trajectories<string>(
      pooledLog({
        users: 10,
        stepsPerUser: 2,
        heavy: "user-0",
        heavySteps: 200,
        rewardFor: (u) => (u === "user-0" ? 0.1 : 0.9),
      }),
      byContextUnit
    );
    const report = evaluatePolicy(ts, fixed("p", "opus"));
    expect(report.estimatedValue as number).toBeLessThan(0.3); // dragged down by the heavy unit
    expect(report.unitEstimatedValue as number).toBeGreaterThan(0.7); // the typical unit
    expect(report.warnings.join(" ")).toMatch(/population is heterogeneous/);
  });

  it("says so when no unit attribution was recorded, and fails a minUnits gate", () => {
    const ts = trajectories<string>(pooledLog({ users: 5, stepsPerUser: 4 })); // no unitOf
    const report = evaluatePolicy(ts, fixed("p", "opus"));

    expect(report.units).toBeUndefined();
    expect(report.warnings.join(" ")).toMatch(/no unit attribution/);
    const verdict = promotionGate(report, { minSteps: 10, minUnits: 5 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/no unit attribution/);
  });

  it("renders the pooled statistics", () => {
    const ts = trajectories<string>(pooledLog({ users: 6, stepsPerUser: 3 }), byContextUnit);
    const text = formatEvalReport(evaluatePolicy(ts, fixed("p", "opus")));
    expect(text).toMatch(/units pooled\s+6/);
    expect(text).toMatch(/effective units/);
    expect(text).toMatch(/largest unit share/);
  });
});
