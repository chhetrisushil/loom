export { decideWithPolicy } from "./decideWithPolicy";
export type { DecideCapable, DecideWithPolicyOptions } from "./decideWithPolicy";
export { trajectories, steps, stableKey, RECORDED_FACT_SOURCES } from "./trajectories";
export { evidenceEvents } from "./evidence";
export { evaluatePolicy, formatEvalReport, MAX_BOOTSTRAP_RESAMPLES } from "./evaluate";
export type { EvaluateOptions, RewardModel } from "./evaluate";
export { promotionGate, policyManifest } from "./promote";
export type { PolicyManifest, PromotionThresholds, PromotionVerdict } from "./promote";
export { seededRandom } from "./stats";
// R18 (ADR 0124) — the learning lifecycle.
export {
  InMemoryPolicyKv,
  MAX_REGISTRY_HISTORY,
  MAX_REGISTRY_VERSIONS,
  PolicyAccessDeniedError,
  PolicyConflictError,
  PolicyNotFoundError,
  PolicyRegistry,
  PolicyRegistryError,
  PolicyVersionConflictError,
  PromotionRefusedError,
} from "./registry";
export type {
  PolicyKvStore,
  PolicyRegistryOptions,
  PromoteInput,
  RegisteredVersion,
  RolloutHistoryEntry,
  RolloutMode,
  RolloutState,
} from "./registry";
export { decideWithRollout, rolloutBucket } from "./rollout";
export type { DecideWithRolloutOptions, PolicyResolver, RolloutSource } from "./rollout";
export {
  canonicalJson,
  contentHash,
  modelVersion,
  promptVersion,
  refMatches,
  sliceByVersion,
} from "./versions";
export { EXPORT_FORMAT, exportJsonl, newExportStats } from "./export";
export type { ExportExecutionRef, ExportOptions, ExportSource, ExportStats } from "./export";
export type {
  EstimateInterval,
  Estimator,
  EvalReport,
  Policy,
  PolicyChoice,
  PolicyContext,
  PolicyStamp,
  RewardSource,
  RolloutStamp,
  Trajectory,
  TrajectoryOptions,
  TrajectoryStep,
  VersionRef,
} from "./types";
