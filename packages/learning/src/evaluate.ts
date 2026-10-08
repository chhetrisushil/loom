import { quantileSorted, seededRandom } from "./stats";
import { stableKey } from "./trajectories";
import type {
  EstimateInterval,
  EvalReport,
  Policy,
  PolicyContext,
  Trajectory,
  TrajectoryStep,
} from "./types";

// ── Off-policy evaluation (ADR 0080) ─────────────────────────────────────────
//
// The question this answers: "is this new policy better than the one currently
// running?" — asked BEFORE the new policy is allowed to choose anything, and
// answered from real production traffic rather than a simulator.
//
// It works because the log already contains what a counterfactual needs: the
// observation (`context`), the action taken, the action set it was taken from
// (`alternatives`), the probability of taking it (`policy.propensity`), and the
// reward that followed. Replay determinism is what makes those records
// trustworthy — the recorded choice IS what ran.

export interface EvaluateOptions {
  /**
   * Cap on a single step's importance weight, `1/propensity`. A step logged with
   * propensity 0.001 otherwise contributes 1000× a normal step and the "estimate"
   * becomes a report about that one step. Default 100; raise only with a reason.
   */
  clipWeight?: number;
  /**
   * Treat a step whose logged propensity is missing as if it were this value.
   * Default: leave it out of the SNIPS estimate entirely, which is honest —
   * inventing a propensity fabricates the very quantity the estimate rests on.
   */
  assumePropensity?: number;
  /**
   * R18 - also compute the doubly-robust estimate (`report.doublyRobust`). `true` fits a
   * leave-one-out per-action mean reward from the log itself; pass `{ rewardModel }` to supply a
   * better `q(context, action)`. SNIPS is still computed and `estimatedValue` is unchanged.
   */
  doublyRobust?: boolean | { rewardModel: RewardModel };
  /**
   * R18 - percentile-bootstrap confidence intervals (`report.intervals`), resampling whole units
   * (or executions when no `unit` was attributed) so correlated steps are not treated as
   * independent. Seeded, so the same inputs give the same interval. Off by default.
   */
  bootstrap?: { resamples?: number; level?: number; seed?: number };
}

/** `q(context, action)`: the expected reward of taking `action` in `context`. */
export type RewardModel = (context: PolicyContext, action: unknown) => number | undefined;

/** Hard ceiling on bootstrap resamples: the cost is resamples x clusters. */
export const MAX_BOOTSTRAP_RESAMPLES = 20_000;

interface Row {
  cluster: string;
  reward: number;
  /** Clipped importance weight; undefined when there is no usable propensity. */
  weight?: number;
  agrees: boolean;
  actionKey: string;
  candidateKey: string;
  candidate: unknown;
  context: PolicyContext;
}

/**
 * Evaluate a candidate policy against historical trajectories WITHOUT running it.
 *
 * Returns a SNIPS (self-normalized inverse propensity scoring) estimate of the
 * candidate's value when the log carries propensities, and an agreement rate
 * always. SNIPS is used rather than plain IPS because plain IPS has unbounded
 * variance and routinely reports a policy as 3× better on the strength of one
 * low-propensity step; self-normalizing trades a little bias for an estimate that
 * does not explode.
 *
 * The report is deliberately full of caveats. An off-policy estimate computed
 * from a deterministic logging policy is not evidence, and this says so rather
 * than printing a confident number.
 */
export function evaluatePolicy<A>(
  trajectories: readonly Trajectory<A>[],
  policy: Policy<A>,
  opts: EvaluateOptions = {}
): EvalReport {
  const clip = opts.clipWeight ?? 100;
  if (!(clip > 0)) throw new Error(`evaluatePolicy: clipWeight must be > 0, got ${clip}`);

  const skipped = { noContext: 0, noActions: 0, noReward: 0 };
  let evaluated = 0;
  let agreed = 0;
  let rewardSum = 0;
  // SNIPS accumulators: Σ w·r and Σ w over the steps the candidate agrees with.
  let weightedReward = 0;
  let weightSum = 0;
  let weightSquares = 0;
  let withPropensity = 0;
  let clippedSteps = 0;
  let deterministicLogging = 0;
  let fallbackActionSets = 0;
  // Per-unit accumulators. Pooling several units' logs is what makes a thin
  // per-unit exploration budget usable; it is also how one heavy unit quietly
  // becomes the whole estimate, so every unit's contribution is tracked.
  const perUnit = new Map<string, { weightedReward: number; weightSum: number }>();
  const wantRows = opts.doublyRobust !== undefined && opts.doublyRobust !== false;
  const wantBoot = opts.bootstrap !== undefined;
  const rows: Row[] = [];

  for (const t of trajectories) {
    for (const step of t.steps) {
      if (step.context === undefined) {
        skipped.noContext += 1;
        continue;
      }
      if (step.actions.length === 0) {
        skipped.noActions += 1;
        continue;
      }
      if (step.reward === undefined) {
        skipped.noReward += 1;
        continue;
      }
      // An action set of one is not a choice — the candidate cannot disagree, so
      // the step carries no counterfactual information (it still counts as agreement).
      if (step.actions.length === 1) fallbackActionSets += 1;

      evaluated += 1;
      rewardSum += step.reward;

      const chosen = policy.select(step.context, step.actions);
      const candidateKey = stableKey(chosen.action);
      const actionKey = stableKey(step.action);
      const agrees = candidateKey === actionKey;
      if (agrees) agreed += 1;

      const p = step.policy?.propensity ?? opts.assumePropensity;
      const usable = p !== undefined && p > 0;
      if (wantRows || wantBoot) {
        const raw = usable ? 1 / (p as number) : undefined;
        rows.push({
          cluster: t.unit ?? `\u0000exec:${t.executionId}`,
          reward: step.reward,
          ...(raw !== undefined && { weight: Math.min(raw, clip) }),
          agrees,
          actionKey,
          candidateKey,
          candidate: chosen.action,
          context: step.context,
        });
      }
      if (p === undefined || !(p > 0)) continue;
      withPropensity += 1;
      if (p >= 1) deterministicLogging += 1;
      if (!agrees) continue; // w·r is zero when the candidate would not have taken this action

      const raw = 1 / p;
      const w = Math.min(raw, clip);
      if (raw > clip) clippedSteps += 1;
      weightedReward += w * step.reward;
      weightSum += w;
      weightSquares += w * w;
      if (t.unit !== undefined) {
        const u = perUnit.get(t.unit) ?? { weightedReward: 0, weightSum: 0 };
        u.weightedReward += w * step.reward;
        u.weightSum += w;
        perUnit.set(t.unit, u);
      }
    }
  }

  // A non-finite accumulator (a reward of 1.7e308 summed twice, or an Infinity/NaN that reached
  // the log) makes every estimate NaN, and `NaN < minLift` is false: the gate would PASS on
  // poisoned evidence. Refuse to produce a report at all.
  if (![rewardSum, weightedReward, weightSum, weightSquares].every(Number.isFinite)) {
    throw new Error(
      "evaluatePolicy: the logged rewards sum to a non-finite value (an overflowing, Infinity or NaN reward is in the log); no estimate can be trusted. Find and exclude the offending outcomes."
    );
  }

  const warnings: string[] = [];
  const loggedValue = evaluated === 0 ? 0 : rewardSum / evaluated;
  const agreement = evaluated === 0 ? 0 : agreed / evaluated;

  let estimatedValue: number | undefined;
  let effectiveSampleSize: number | undefined;
  let estimator: EvalReport["estimator"] = "agreement-only";
  if (weightSum > 0) {
    estimator = "snips";
    estimatedValue = weightedReward / weightSum;
    // Kish's ESS: (Σw)² / Σw². How many equally-weighted steps this estimate is worth.
    effectiveSampleSize = (weightSum * weightSum) / weightSquares;
  }

  // ── Unit-level (cluster-robust) statistics ─────────────────────────────────
  let units: number | undefined;
  let unitEstimatedValue: number | undefined;
  let unitEffectiveSampleSize: number | undefined;
  let maxUnitWeightShare: number | undefined;
  const contributing = [...perUnit.values()].filter((u) => u.weightSum > 0);
  if (contributing.length > 0) {
    units = contributing.length;
    // Equal weight per unit — "what is this worth for a typical unit", as opposed
    // to `estimatedValue`, which is dominated by whichever unit supplied the weight.
    unitEstimatedValue =
      contributing.reduce((acc, u) => acc + u.weightedReward / u.weightSum, 0) / units;
    const total = contributing.reduce((acc, u) => acc + u.weightSum, 0);
    const squares = contributing.reduce((acc, u) => acc + u.weightSum * u.weightSum, 0);
    unitEffectiveSampleSize = (total * total) / squares;
    maxUnitWeightShare = Math.max(...contributing.map((u) => u.weightSum)) / total;
  }

  const loggedForExtras = evaluated === 0 ? 0 : rewardSum / evaluated;
  let doublyRobust: EvalReport["doublyRobust"];
  let intervals: EvalReport["intervals"];
  if (wantRows || wantBoot) {
    const extras = estimateExtras(rows, opts, loggedForExtras, perUnit.size > 0);
    doublyRobust = extras.doublyRobust;
    intervals = extras.intervals;
    for (const w of extras.warnings) warnings.push(w);
  }

  if (evaluated === 0) {
    warnings.push("no evaluable steps — nothing was compared, every number here is zero");
  }
  if (skipped.noContext > 0) {
    warnings.push(
      `${skipped.noContext} step(s) had no recorded context (pre-1.18.0 log, or the decision passed no context) and were skipped`
    );
  }
  if (skipped.noReward > 0) {
    warnings.push(`${skipped.noReward} step(s) had no reward and were skipped`);
  }
  if (estimator === "agreement-only" && evaluated > 0) {
    warnings.push(
      "no logged propensities — value is NOT estimated, only agreement. Log policy.propensity at decision time to get an unbiased estimate"
    );
  }
  if (withPropensity > 0 && deterministicLogging === withPropensity) {
    warnings.push(
      "the logging policy was deterministic (propensity 1 throughout) — an off-policy estimate over it is biased by construction; the log contains no counterfactuals"
    );
  }
  if (clippedSteps > 0) {
    warnings.push(
      `${clippedSteps} step(s) hit the importance-weight clip of ${clip} — their contribution is truncated and the estimate is conservative`
    );
  }
  if (effectiveSampleSize !== undefined && effectiveSampleSize < evaluated / 10) {
    warnings.push(
      `effective sample size ${effectiveSampleSize.toFixed(1)} is under a tenth of the ${evaluated} evaluated steps — a handful of steps dominate this estimate`
    );
  }
  if (fallbackActionSets > 0) {
    warnings.push(
      `${fallbackActionSets} step(s) had only one candidate action, so agreement there was guaranteed and means nothing`
    );
  }
  if (units !== undefined) {
    if (maxUnitWeightShare !== undefined && maxUnitWeightShare > 0.5) {
      warnings.push(
        `one unit supplies ${(maxUnitWeightShare * 100).toFixed(0)}% of the importance weight — this is that unit's estimate wearing a pooled label`
      );
    }
    if (unitEffectiveSampleSize !== undefined && unitEffectiveSampleSize < units / 2) {
      warnings.push(
        `effective UNIT sample size ${unitEffectiveSampleSize.toFixed(1)} is under half of the ${units} contributing units — pooling widened the log but not the evidence`
      );
    }
    if (
      unitEstimatedValue !== undefined &&
      estimatedValue !== undefined &&
      Math.abs(unitEstimatedValue - estimatedValue) > 0.1 * Math.max(1e-9, Math.abs(estimatedValue))
    ) {
      warnings.push(
        `pooled (${estimatedValue.toFixed(4)}) and per-unit (${unitEstimatedValue.toFixed(4)}) estimates differ by more than 10% — the population is heterogeneous and the pooled number does not describe a typical unit`
      );
    }
  } else if (evaluated > 0) {
    warnings.push(
      "no unit attribution — pooled evidence cannot be distinguished from one unit's, and the effective sample size below treats steps within a unit as independent. Pass `unitOf` to trajectories()"
    );
  }

  return {
    policy: { id: policy.id, version: policy.version },
    evaluated,
    skipped,
    agreement,
    loggedValue,
    ...(estimatedValue !== undefined && { estimatedValue }),
    estimator,
    ...(estimatedValue !== undefined && { lift: estimatedValue - loggedValue }),
    ...(effectiveSampleSize !== undefined && { effectiveSampleSize }),
    ...(units !== undefined && { units }),
    ...(unitEstimatedValue !== undefined && { unitEstimatedValue }),
    ...(unitEffectiveSampleSize !== undefined && { unitEffectiveSampleSize }),
    ...(maxUnitWeightShare !== undefined && { maxUnitWeightShare }),
    ...(doublyRobust !== undefined && { doublyRobust }),
    ...(intervals !== undefined && { intervals }),
    warnings,
  };
}

interface ClusterAgg {
  /** SNIPS numerator / denominator over agreeing steps with a propensity. */
  wr: number;
  w: number;
  /** Logged reward sum and count over ALL evaluated steps. */
  r: number;
  n: number;
  /** Doubly-robust per-step contributions and their count. */
  dr: number;
  m: number;
}

/**
 * The R18 additions, computed from the buffered rows so the single-pass SNIPS path above is
 * untouched: the doubly-robust point estimate and the cluster-bootstrap intervals.
 */
function estimateExtras(
  rows: readonly Row[],
  opts: EvaluateOptions,
  loggedValue: number,
  hasUnits: boolean
): {
  doublyRobust?: EvalReport["doublyRobust"];
  intervals?: EvalReport["intervals"];
  warnings: string[];
} {
  const warnings: string[] = [];
  const dr = opts.doublyRobust;
  const wantDr = dr !== undefined && dr !== false;
  const supplied = typeof dr === "object" && dr !== null ? dr.rewardModel : undefined;

  // The fitted reward model: per-action sum and count over the rows with a usable propensity (the
  // same population the estimate averages over), used leave-one-out so a row never predicts itself.
  const sum = new Map<string, number>();
  const cnt = new Map<string, number>();
  let gSum = 0;
  let gCnt = 0;
  if (wantDr && supplied === undefined) {
    for (const r of rows) {
      if (r.weight === undefined) continue;
      sum.set(r.actionKey, (sum.get(r.actionKey) ?? 0) + r.reward);
      cnt.set(r.actionKey, (cnt.get(r.actionKey) ?? 0) + 1);
      gSum += r.reward;
      gCnt += 1;
    }
  }
  const fitted = (r: Row, key: string): number => {
    const own = key === r.actionKey;
    const c = (cnt.get(key) ?? 0) - (own ? 1 : 0);
    if (c > 0) return ((sum.get(key) ?? 0) - (own ? r.reward : 0)) / c;
    const gc = gCnt - 1;
    return gc > 0 ? (gSum - r.reward) / gc : 0;
  };
  const q = (r: Row, key: string, action: unknown): number => {
    if (supplied !== undefined) {
      const v = supplied(r.context, action);
      if (v !== undefined && Number.isFinite(v)) return v;
      return 0;
    }
    return fitted(r, key);
  };

  const clusters = new Map<string, ClusterAgg>();
  let drTotal = 0;
  let drSteps = 0;
  let loggedSum = 0;
  let loggedN = 0;
  for (const r of rows) {
    if (r.weight === undefined) continue;
    loggedSum += r.reward;
    loggedN += 1;
  }
  const loggedOnSame = loggedN === 0 ? loggedValue : loggedSum / loggedN;
  for (const r of rows) {
    // The lift compares the estimate with the logged mean over the SAME rows the estimate averages
    // over (those with a usable propensity); mixing in steps the estimate never saw would make the
    // "lift" partly a difference between two populations. A cluster with no such row is not a
    // cluster of evidence either, so it is not counted.
    if (r.weight === undefined) continue;
    let c = clusters.get(r.cluster);
    if (c === undefined) {
      c = { wr: 0, w: 0, r: 0, n: 0, dr: 0, m: 0 };
      clusters.set(r.cluster, c);
    }
    c.r += r.reward;
    c.n += 1;
    if (r.agrees) {
      c.wr += r.weight * r.reward;
      c.w += r.weight;
    }
    if (wantDr) {
      const direct = q(r, r.candidateKey, r.candidate);
      const correction = r.agrees ? r.weight * (r.reward - q(r, r.actionKey, r.candidate)) : 0;
      const d = direct + correction;
      c.dr += d;
      c.m += 1;
      drTotal += d;
      drSteps += 1;
    }
  }

  let doublyRobust: EvalReport["doublyRobust"];
  if (wantDr) {
    if (drSteps === 0) {
      warnings.push(
        "doubly-robust estimate requested but no step had a usable propensity - none computed"
      );
    } else if (!Number.isFinite(drTotal)) {
      throw new Error(
        "evaluatePolicy: the doubly-robust estimate is non-finite (a poisoned reward or reward model); no estimate can be trusted."
      );
    } else {
      const value = drTotal / drSteps;
      doublyRobust = {
        value,
        lift: value - loggedOnSame,
        steps: drSteps,
        rewardModel: supplied === undefined ? "fitted" : "supplied",
      };
    }
  }

  let intervals: EvalReport["intervals"];
  const boot = opts.bootstrap;
  if (boot !== undefined) {
    const resamples = boot.resamples ?? 1000;
    const level = boot.level ?? 0.95;
    const seed = boot.seed ?? 1;
    if (!Number.isInteger(resamples) || resamples < 100 || resamples > MAX_BOOTSTRAP_RESAMPLES) {
      throw new Error(
        `evaluatePolicy: bootstrap.resamples must be an integer in [100, ${MAX_BOOTSTRAP_RESAMPLES}], got ${resamples}`
      );
    }
    if (!(level > 0 && level < 1)) {
      throw new Error(`evaluatePolicy: bootstrap.level must be in (0,1), got ${level}`);
    }
    const aggs = [...clusters.values()];
    const make = (kind: "snips" | "dr"): EstimateInterval | undefined => {
      const usable = aggs.filter((a) => (kind === "snips" ? a.w > 0 : a.m > 0));
      if (usable.length === 0 || (kind === "dr" && !wantDr)) return undefined;
      const rand = seededRandom(seed);
      const values: number[] = [];
      const lifts: number[] = [];
      const c = aggs.length;
      for (let b = 0; b < resamples; b++) {
        let wr = 0;
        let w = 0;
        let r = 0;
        let n = 0;
        let d = 0;
        let m = 0;
        for (let i = 0; i < c; i++) {
          const a = aggs[Math.floor(rand() * c)] as ClusterAgg;
          wr += a.wr;
          w += a.w;
          r += a.r;
          n += a.n;
          d += a.dr;
          m += a.m;
        }
        const denom = kind === "snips" ? w : m;
        if (!(denom > 0) || n === 0) continue; // a resample with no evidence for the estimate
        const value = kind === "snips" ? wr / w : d / m;
        values.push(value);
        lifts.push(value - r / n);
      }
      if (values.length < resamples / 2) return undefined;
      values.sort((x, y) => x - y);
      lifts.sort((x, y) => x - y);
      const lo = (1 - level) / 2;
      return {
        estimator: kind,
        level,
        resamples: values.length,
        seed,
        clusters: hasUnits ? "unit" : "execution",
        clusterCount: c,
        value: { lower: quantileSorted(values, lo), upper: quantileSorted(values, 1 - lo) },
        lift: { lower: quantileSorted(lifts, lo), upper: quantileSorted(lifts, 1 - lo) },
      };
    };
    const snips = make("snips");
    const drI = make("dr");
    if (snips !== undefined || drI !== undefined) {
      intervals = { ...(snips !== undefined && { snips }), ...(drI !== undefined && { dr: drI }) };
      if (aggs.length < 10) {
        warnings.push(
          `the bootstrap resamples only ${aggs.length} cluster(s) - an interval over so few is not trustworthy`
        );
      }
    } else {
      warnings.push("bootstrap requested but there was no weighted evidence to resample");
    }
  }
  return {
    ...(doublyRobust !== undefined && { doublyRobust }),
    ...(intervals !== undefined && { intervals }),
    warnings,
  };
}

/** Human-readable rendering of an {@link EvalReport}, for CLI output and PR comments. */
export function formatEvalReport(report: EvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `Policy ${report.policy.id}@${report.policy.version} — off-policy evaluation`,
    "",
    `  steps evaluated     ${report.evaluated}`,
    `  agreement with log  ${pct(report.agreement)}`,
    `  logged value        ${report.loggedValue.toFixed(4)}`,
  ];
  if (report.estimatedValue !== undefined) {
    lines.push(`  estimated value     ${report.estimatedValue.toFixed(4)} (${report.estimator})`);
    const lift = report.lift ?? 0;
    lines.push(`  lift                ${lift >= 0 ? "+" : ""}${lift.toFixed(4)}`);
  } else {
    lines.push(`  estimated value     — (${report.estimator})`);
  }
  if (report.doublyRobust !== undefined) {
    const d = report.doublyRobust;
    lines.push(
      `  doubly-robust value ${d.value.toFixed(4)} (lift ${d.lift >= 0 ? "+" : ""}${d.lift.toFixed(4)}, ${d.rewardModel} reward model)`
    );
  }
  for (const iv of [report.intervals?.snips, report.intervals?.dr]) {
    if (iv === undefined) continue;
    lines.push(
      `  ${iv.estimator} ${(iv.level * 100).toFixed(0)}% CI    lift [${iv.lift.lower.toFixed(4)}, ${iv.lift.upper.toFixed(4)}], value [${iv.value.lower.toFixed(4)}, ${iv.value.upper.toFixed(4)}] (${iv.resamples} resamples over ${iv.clusterCount} ${iv.clusters}s)`
    );
  }
  if (report.effectiveSampleSize !== undefined) {
    lines.push(`  effective samples   ${report.effectiveSampleSize.toFixed(1)}`);
  }
  if (report.units !== undefined) {
    lines.push(`  units pooled        ${report.units}`);
    if (report.unitEstimatedValue !== undefined) {
      lines.push(`  per-unit value      ${report.unitEstimatedValue.toFixed(4)}`);
    }
    if (report.unitEffectiveSampleSize !== undefined) {
      lines.push(`  effective units     ${report.unitEffectiveSampleSize.toFixed(1)}`);
    }
    if (report.maxUnitWeightShare !== undefined) {
      lines.push(`  largest unit share  ${(report.maxUnitWeightShare * 100).toFixed(0)}%`);
    }
  }
  const { noContext, noActions, noReward } = report.skipped;
  if (noContext + noActions + noReward > 0) {
    lines.push(
      `  skipped             ${noContext} no-context, ${noActions} no-actions, ${noReward} no-reward`
    );
  }
  if (report.warnings.length > 0) {
    lines.push("", "  Warnings:");
    for (const w of report.warnings) lines.push(`    ! ${w}`);
  }
  return lines.join("\n");
}
