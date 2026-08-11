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
