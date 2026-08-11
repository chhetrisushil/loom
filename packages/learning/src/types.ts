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
  steps: TrajectoryStep<A>[];
  /** Terminal reward for the execution as a whole, if one could be determined. */
  terminalReward?: number;
  outcome: "completed" | "failed" | "cancelled" | "open";
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
  /** Everything that makes this report weaker than it looks. Never empty by default. */
  warnings: string[];
}
