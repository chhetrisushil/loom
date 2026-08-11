import { stableKey } from "./trajectories";
import type { EvalReport, Policy, Trajectory, TrajectoryStep } from "./types";

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
}

/** How the candidate would have chosen, replayed against one historical step. */
function agreesWith<A>(step: TrajectoryStep<A>, policy: Policy<A>): boolean | undefined {
  if (step.context === undefined || step.actions.length === 0) return undefined;
  const chosen = policy.select(step.context, step.actions);
  return stableKey(chosen.action) === stableKey(step.action);
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

      const agrees = agreesWith(step, policy) === true;
      if (agrees) agreed += 1;

      const p = step.policy?.propensity ?? opts.assumePropensity;
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
    }
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
  if (report.effectiveSampleSize !== undefined) {
    lines.push(`  effective samples   ${report.effectiveSampleSize.toFixed(1)}`);
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
