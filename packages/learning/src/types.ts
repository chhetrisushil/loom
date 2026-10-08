import type { EventEnvelope } from "@loom/core";

// ── The learning substrate (ADR 0080) ────────────────────────────────────────
//
// Loom does not ship reinforcement learning. It ships the substrate a learning
// loop needs and cannot build for itself: the durable (state, action, propensity,
// reward) record, credit assignment across an execution, and — the part no other
// runtime can offer — evaluation of a candidate policy against REAL historical
// traffic before it is ever allowed to choose anything.
//
// The learning algorithm is deliberately outside: implement `Policy` in a
// third-party package (see ../loom-plugins). Everything here is read-only over
// the log, exactly like @loom/analytics.

/** The observation a policy keys its choice on — the `s` in `(s, a, r)`. */
export type PolicyContext = Record<string, unknown>;

/** Which policy chose, and how likely it was to choose what it chose. */
export interface PolicyStamp {
  id: string;
  version: string;
  /**
   * `P(chosen action | context)` under the policy that chose it. Convention: `(0,1]`.
   *
   * This cannot be reconstructed after the fact, and without it an off-policy
   * estimate is biased by whatever the logging policy preferred. A deterministic
   * policy logs `1`; an exploring one logs its actual sampling probability.
   */
  propensity?: number;
  /**
   * R18 (ADR 0124) - the prompt template and model configuration that were in force when this
   * decision was made, as content-addressed references (see `promptVersion` / `modelVersion`).
   * Recorded verbatim in the decision's `policy` stamp (the fold keeps the object whole), so an
   * evaluation can slice by prompt or model version. Descriptive: never a replay input.
   */
  refs?: { prompt?: VersionRef; model?: VersionRef };
  /**
   * R18 (ADR 0124) - set when a `PolicyRegistry` rollout chose which policy acted: the mode, the
   * traffic bucket, and (shadow/canary) what the OTHER candidate would have chosen. Recorded in
   * the decision so a replay is identical and off-policy evaluation can use the shadow arm.
   */
  rollout?: RolloutStamp;
}

/** A content-addressed reference to a prompt template or a model configuration. */
export interface VersionRef {
  /** Human-meaningful name, e.g. `"triage-system"` or `"claude-sonnet"`. */
  id: string;
  /** `sha256:<hex>` of the canonical form of the content - the version IS the content. */
  version: string;
}

/** What a rollout recorded about who acted and who merely watched. */
export interface RolloutStamp {
  registry: string;
  mode: "full" | "canary" | "shadow";
  /** The stable traffic bucket in [0,1) derived from the unit key; absent for `full`. */
  bucket?: number;
  /** Canary only: the probability of the arm that acted (`f` or `1 - f`). */
  armProbability?: number;
  /** Canary only: the unit fell in the candidate's slice but the candidate had no code, so the incumbent acted. */
  fellBack?: true;
  /** The policy that ACTED. */
  acted: { id: string; version: string };
  /** The other arm: the candidate (canary: when the incumbent acted; shadow: always). */
  shadow?: {
    id: string;
    version: string;
    action: unknown;
    propensity?: number;
    /** Set when the shadow policy threw: it never affects the acting arm. */
    error?: string;
  };
}

/** What a policy returns: the action, and the probability it assigned to picking it. */
export interface PolicyChoice<A> {
  action: A;
  /** Omit only for a deterministic policy; see {@link PolicyStamp.propensity}. */
  propensity?: number;
}

/**
 * The SPI a learner implements. Deliberately tiny: one method, no training hook,
 * no lifecycle. Training happens offline, out of band, and produces a NEW version
 * — a policy object is immutable evidence of one snapshot of what was learned.
 */
export interface Policy<A = string> {
  readonly id: string;
  readonly version: string;
  select(context: PolicyContext, actions: readonly A[]): PolicyChoice<A>;
}

/** How a step's reward was arrived at. */
export type RewardSource =
  /** An OUTCOME_RECORDED naming this decisionId — the reward is measured, not inferred. */
  | "direct"
  /** Credit assigned from the execution's terminal result. */
  | "terminal"
  /** Nothing scored this decision; `reward` is undefined. */
  | "none";

/** One decision, with everything needed to learn from it. */
export interface TrajectoryStep<A = unknown> {
  decisionId: string;
  executionId: string;
  sequence: number;
  timestamp: number;
  /** The action taken (the recorded `choice`). */
  action: A;
  /** The observation the policy saw (ADR 0079). Absent on pre-1.18.0 logs. */
  context?: PolicyContext;
  /** Which policy chose, and with what propensity (ADR 0079). */
  policy?: PolicyStamp;
  /**
   * R18 - the prompt/model versions in force: the decision's own `policy.refs`, else those the
   * run's `agentLoop$` stamped on its model-response decisions (recorded facts, which are not steps).
   */
  refs?: { prompt?: VersionRef; model?: VersionRef };
  /**
   * The action set the policy chose FROM, recovered from the decision's
   * `alternatives` (ADR 0030 D1) or, failing that, from every choice observed for
   * this `decisionId` across the log. Empty when neither is available — such a
   * step cannot be counterfactually evaluated.
   */
  actions: A[];
  /** Resolved reward: the direct outcome if one exists, else assigned terminal credit. */
  reward?: number;
  rewardSource: RewardSource;
  /** The measured outcome alone, before any terminal credit was considered. */
  directReward?: number;
}

/** One execution's decisions, in order, with its terminal result. */
export interface Trajectory<A = unknown> {
  executionId: string;
  /**
   * The unit this execution belongs to — a user, tenant, or cohort member.
   *
   * Pooling several units' logs into one evaluation is how a thin per-unit
   * exploration budget becomes a usable evidence base. It is also how a pooled
   * estimate quietly becomes one heavy unit's estimate, so evaluation reports
   * unit-level statistics whenever this is set. Populate via
   * {@link TrajectoryOptions.unitOf}.
   */
  unit?: string;
  steps: TrajectoryStep<A>[];
  /** Terminal reward for the execution as a whole, if one could be determined. */
  terminalReward?: number;
  outcome: "completed" | "failed" | "cancelled" | "continued" | "open";
}

export interface TrajectoryOptions {
  /**
   * Reward for an execution that reached EXECUTION_COMPLETED / EXECUTION_FAILED.
   * Defaults to `1` / `0`. Return `undefined` to assign no terminal credit — the
   * right choice when success/failure says nothing about decision quality.
   */
  terminalReward?: (
    outcome: Trajectory["outcome"],
    events: readonly EventEnvelope[]
  ) => number | undefined;
  /**
   * Discount applied to terminal credit, counting BACKWARDS from the last decision
   * in the execution: the final decision gets `γ^0`, the one before it `γ^1`, and so
   * on. Default `1` (undiscounted — every decision on the path shares the credit
   * equally). Lower values blame the decisions nearest the outcome.
   */
  discount?: number;
  /**
   * Whether a step that already has a DIRECT outcome should also receive terminal
   * credit. Default `false`: a measured reward is better evidence than an inferred
   * one, and summing the two double-counts.
   */
  terminalCreditOnScored?: boolean;
  /**
   * Attribute each execution to a unit (user/tenant). Receives the execution id
   * and the context of its first recorded decision, which covers both the common
   * case (the unit is a context feature) and an external id → unit map.
   */
  unitOf?: (executionId: string, firstContext?: PolicyContext) => string | undefined;
}

/** How a candidate policy's value was estimated. */
export type Estimator =
  /** Self-normalized inverse propensity scoring — unbiased given logged propensities. */
  | "snips"
  /** No usable propensities; only how often the candidate agrees with the log. */
  | "agreement-only";

export interface EvalReport {
  policy: { id: string; version: string };
  /** Steps considered (those with a context and a recoverable action set). */
  evaluated: number;
  /** Steps skipped, by reason. */
  skipped: { noContext: number; noActions: number; noReward: number };
  /** Fraction of evaluated steps where the candidate would have made the logged choice. */
  agreement: number;
  /** Mean reward actually achieved by the logging policy over the evaluated steps. */
  loggedValue: number;
  /** SNIPS estimate of the candidate's value. Undefined when no propensities were logged. */
  estimatedValue?: number;
  estimator: Estimator;
  /** `estimatedValue - loggedValue` when both exist. */
  lift?: number;
  /**
   * Effective sample size of the importance weights — how many steps the estimate is
   * REALLY resting on. Far below `evaluated` means one or two lucky steps dominate it.
   */
  effectiveSampleSize?: number;
  /**
   * Distinct units (users/tenants) contributing weight, when trajectories carry a
   * `unit`. Pooling is what makes a small per-unit exploration budget usable, so
   * this is the number that says how broad the evidence actually is.
   */
  units?: number;
  /**
   * Cluster-robust estimate: the mean of each unit's OWN SNIPS estimate, equally
   * weighted per unit. Answers "what would this policy be worth for a typical
   * unit", where `estimatedValue` answers "…across the pooled step population" and
   * is dominated by whichever unit contributed most weight. A material gap between
   * the two means the population is heterogeneous and the pooled number is
   * misleading.
   */
  unitEstimatedValue?: number;
  /**
   * Kish effective sample size over per-unit total weights — how many UNITS the
   * estimate rests on. `effectiveSampleSize` treats steps within a unit as
   * independent, which they are not, so it overstates the evidence under pooling.
   */
  unitEffectiveSampleSize?: number;
  /** Largest single unit's share of total importance weight, in [0,1]. */
  maxUnitWeightShare?: number;
  /**
   * R18 - the doubly-robust estimate, present when `EvaluateOptions.doublyRobust` is set. It is
   * the direct-method prediction plus an importance-weighted correction of that prediction's
   * residual, so it is lower-variance than SNIPS when the reward model is decent and still
   * consistent when only the logged propensities are right.
   */
  doublyRobust?: {
    value: number;
    /** `value - loggedValue`. */
    lift: number;
    /** Steps the estimate averages over (those with a usable propensity). */
    steps: number;
    /** `"fitted"`: leave-one-out per-action mean reward; `"supplied"`: the caller's model. */
    rewardModel: "fitted" | "supplied";
  };
  /** R18 - bootstrap intervals, present when `EvaluateOptions.bootstrap` is set. */
  intervals?: { snips?: EstimateInterval; dr?: EstimateInterval };
  /** Everything that makes this report weaker than it looks. Never empty by default. */
  warnings: string[];
}

/** A percentile-bootstrap interval, resampled by whole cluster (unit, else execution). */
export interface EstimateInterval {
  estimator: "snips" | "dr";
  /** Two-sided coverage, e.g. 0.95. */
  level: number;
  resamples: number;
  seed: number;
  /** What was resampled: users/tenants when trajectories carry a `unit`, else executions. */
  clusters: "unit" | "execution";
  clusterCount: number;
  /** Interval for the candidate's value. */
  value: { lower: number; upper: number };
  /** Interval for `value - loggedValue`, resampling both together. */
  lift: { lower: number; upper: number };
}
