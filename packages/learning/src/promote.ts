import type { EvalReport } from "./types";

// ── Promotion (ADR 0080) ─────────────────────────────────────────────────────
//
// A policy is a versioned artifact, not a running process. "Promoting" it means
// recording that a specific version passed a specific evaluation, so a deployment
// can pin it and a rollback is a re-pin rather than a retraining run.
//
// The gate is pure: it takes a report and thresholds and returns a verdict with
// reasons. It never writes anything and never mutates a runtime — adopting a
// promoted policy is still an explicit wiring change in application code, and the
// choice it then makes is still a logged `ctx.decide` (P9/P10).

export interface PromotionThresholds {
  /** Minimum evaluated steps. Default 1000 — below this, lift is noise. */
  minSteps?: number;
  /**
   * Minimum `estimatedValue - loggedValue`. Default 0 (must not be worse).
   * A gate on lift alone is not enough, which is why the checks below exist.
   */
  minLift?: number;
  /**
   * Minimum effective sample size. Default: a tenth of `minSteps`. Guards the case
   * where a big `evaluated` count hides an estimate resting on three steps.
   */
  minEffectiveSamples?: number;
  /**
   * Refuse a candidate that agrees with the logging policy more than this often.
   * Default 1 (no ceiling). Useful to reject a "new" policy that is a copy.
   */
  maxAgreement?: number;
  /** Require an unbiased estimator. Default true — agreement alone is not evidence. */
  requireEstimate?: boolean;
  /**
   * Minimum number of contributing units (users/tenants) for a POOLED evaluation.
   *
   * Set this whenever evidence is pooled across units to work around a thin
   * per-unit exploration budget: it is the check that stops "8 weeks across 40
   * users" from silently being "8 weeks of one enthusiastic user". Requires
   * `unitOf` at extraction — a report with no unit attribution FAILS this gate
   * rather than passing it vacuously.
   */
  minUnits?: number;
  /**
   * R18 - require the bootstrap CONFIDENCE INTERVAL on lift to clear this lower bound (typically
   * 0: "the candidate is better than the incumbent at the interval's confidence level"). A point
   * estimate that is positive on thin evidence passes `minLift` and fails this. The report must
   * carry an interval (`evaluatePolicy(..., { bootstrap })`) - a report without one FAILS this
   * gate rather than passing it vacuously.
   */
  minLiftLowerBound?: number;
  /**
   * Which interval `minLiftLowerBound` reads. Default: the doubly-robust one when the report has
   * it, else SNIPS.
   */
  intervalEstimator?: "snips" | "dr";
  /**
   * Minimum number of resampled CLUSTERS (units, else executions) behind the interval, applied
   * whenever `minLiftLowerBound` is set. Default 20. A bootstrap over one or two clusters resamples
   * the same few values, so its interval collapses to a point and "the lower bound clears zero" is
   * then true of any positive estimate: the interval only means something when there is something
   * to resample.
   */
  minClusters?: number;
}

export interface PromotionVerdict {
  ok: boolean;
  /** Why it failed, or — when `ok` — the caveats that survived. Never silent. */
  reasons: string[];
}

/**
 * Decide whether an evaluation justifies promoting a candidate policy.
 *
 * Deliberately conservative: every default is set so that a policy with thin,
 * biased, or unmeasured evidence fails. It is much cheaper to re-run an
 * evaluation than to discover in production that the estimate rested on four
 * lucky steps.
 */
export function promotionGate(
  report: EvalReport,
  thresholds: PromotionThresholds = {}
): PromotionVerdict {
  const minSteps = thresholds.minSteps ?? 1000;
  const minLift = thresholds.minLift ?? 0;
  const minEffective = thresholds.minEffectiveSamples ?? minSteps / 10;
  const maxAgreement = thresholds.maxAgreement ?? 1;
  const requireEstimate = thresholds.requireEstimate ?? true;

  const reasons: string[] = [];

  if (report.evaluated < minSteps) {
    reasons.push(`only ${report.evaluated} evaluable steps (need ${minSteps})`);
  }
  if (requireEstimate && report.estimator !== "snips") {
    reasons.push(
      `no unbiased value estimate (estimator: ${report.estimator}) — log policy.propensity at decision time`
    );
  }
  // `NaN < minLift` is false, so a non-finite number would otherwise pass every comparison.
  for (const [name, v] of [
    ["lift", report.lift],
    ["estimatedValue", report.estimatedValue],
    ["loggedValue", report.loggedValue],
    ["effectiveSampleSize", report.effectiveSampleSize],
  ] as const) {
    if (v !== undefined && !Number.isFinite(v)) {
      reasons.push(
        `${name} is not a finite number (${String(v)}) — the evidence is poisoned or the report is corrupt`
      );
    }
  }
  if (report.lift === undefined) {
    if (requireEstimate) reasons.push("no lift could be computed");
  } else if (report.lift < minLift) {
    reasons.push(`lift ${report.lift.toFixed(4)} is below the required ${minLift}`);
  }
  if (report.effectiveSampleSize !== undefined && report.effectiveSampleSize < minEffective) {
    reasons.push(
      `effective sample size ${report.effectiveSampleSize.toFixed(1)} is below the required ${minEffective}`
    );
  }
  if (thresholds.minUnits !== undefined) {
    if (report.units === undefined) {
      reasons.push(
        "minUnits was set but the evaluation carries no unit attribution — pass `unitOf` to trajectories(), or the pooled evidence cannot be distinguished from one unit's"
      );
    } else {
      if (report.units < thresholds.minUnits) {
        reasons.push(`only ${report.units} contributing unit(s) (need ${thresholds.minUnits})`);
      }
      if (
        report.unitEffectiveSampleSize !== undefined &&
        report.unitEffectiveSampleSize < thresholds.minUnits
      ) {
        reasons.push(
          `effective unit sample size ${report.unitEffectiveSampleSize.toFixed(1)} is below the required ${thresholds.minUnits} — the pool is wide but the evidence is not`
        );
      }
    }
  }
  if (thresholds.minLiftLowerBound !== undefined) {
    const want = thresholds.intervalEstimator;
    const iv =
      want !== undefined
        ? report.intervals?.[want]
        : (report.intervals?.dr ?? report.intervals?.snips);
    if (iv === undefined) {
      reasons.push(
        `minLiftLowerBound was set but the evaluation carries no ${want ?? ""}${want ? " " : ""}confidence interval - pass \`bootstrap\` to evaluatePolicy`
      );
    } else if (!Number.isFinite(iv.lift.lower)) {
      reasons.push("the lift confidence interval is not finite - the evidence is poisoned");
    } else if (iv.clusterCount < (thresholds.minClusters ?? 20)) {
      reasons.push(
        `the lift confidence interval resamples only ${iv.clusterCount} cluster(s) (need ${thresholds.minClusters ?? 20}): too few to bootstrap`
      );
    } else if (iv.lift.lower < thresholds.minLiftLowerBound) {
      reasons.push(
        `${iv.estimator} lift lower bound ${iv.lift.lower.toFixed(4)} (${(iv.level * 100).toFixed(0)}% CI) is below the required ${thresholds.minLiftLowerBound}`
      );
    }
  }
  if (report.agreement > maxAgreement) {
    reasons.push(
      `agreement ${(report.agreement * 100).toFixed(1)}% exceeds the ceiling of ${(maxAgreement * 100).toFixed(1)}% — this candidate barely differs from the policy already running`
    );
  }

  const ok = reasons.length === 0;
  // Passing is not the same as being safe. Surface what remains questionable.
  return { ok, reasons: ok ? report.warnings : reasons };
}

/** The durable record of "this version passed this evaluation". */
export interface PolicyManifest {
  policy: { id: string; version: string };
  promotedAt?: number;
  report: EvalReport;
  verdict: PromotionVerdict;
  /** Rollout fraction the deployment should start at, if the caller is canarying. */
  canary?: number;
}

/**
 * Build the manifest a deployment pins. Persisting it is the caller's business —
 * a file, a config entry, a row — because this package never writes.
 *
 * `promotedAt` must be supplied by the caller rather than read from a clock here,
 * so that a manifest built twice from the same inputs is byte-identical.
 */
export function policyManifest(
  report: EvalReport,
  verdict: PromotionVerdict,
  opts: { promotedAt?: number; canary?: number } = {}
): PolicyManifest {
  if (opts.canary !== undefined && !(opts.canary >= 0 && opts.canary <= 1)) {
    throw new Error(`policyManifest: canary must be in [0,1], got ${opts.canary}`);
  }
  return {
    policy: report.policy,
    ...(opts.promotedAt !== undefined && { promotedAt: opts.promotedAt }),
    report,
    verdict,
    ...(opts.canary !== undefined && { canary: opts.canary }),
  };
}
