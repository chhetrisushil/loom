export {
  defineConfig,
  normalizeConfig,
  type CatalogLike,
  type ChecksOptions,
  type DurabilityOptions,
  type ExecutionOptions,
  type LoomApp,
  type LoomConfig,
  type LoomStores,
  type ObservabilityOptions,
  type SecurityOptions,
  type StorageConfig,
} from "./defineConfig";
export {
  PrincipalRecordingRefusedError,
  type PrincipalCryptoOptions,
  type SensitivePathRegistry,
  type SensitiveSnapshotRegistry,
} from "./principalPolicy";
export {
  STRICT_DEFAULTS,
  type AutonomyEnvelopeOptions,
  type ResolvedEnvelope,
  type SpawnLimits,
  type StrictOptions,
} from "./strict";
export {
  InProcessA2ABus,
  approvalPayload,
  unsafeAutoApprove,
  type ApprovalDecision,
  type ApprovalProof,
  type ApprovalRequest,
  type DispatchOptions,
  type DispatchResult,
} from "./InProcessA2ABus";
export { BroadcastingProjectionRuntime } from "./BroadcastingProjectionRuntime";
export { progressHub } from "./progressHub";
export {
  registerFlowsFrom,
  manifestWarnings,
  type FlowModule,
  type ManifestView,
} from "./registerFlows";
export {
  validateFlowGraph,
  type FlowGraphFlow,
  type FlowGraphInput,
  type FlowGraphIssue,
} from "./validate";
export {
  resolveVerifyInput,
  normalizeVerify,
  type VerifyConfig,
  type NormalizedVerify,
  type VerifyAdapterInputs,
  type VerifyLintInputs,
} from "./verifyAdapter";

// ADR 0114 — `ctx.ui` is typed by declaration merging owned by `@loom/agent-surface`. Re-exporting
// one of its types makes `app/dist/index.d.ts` pull that module (and its `declare module
// "@loom/workflow-runtime"` augmentation) into every program that imports `@loom/app`, so a
// composed app keeps `ctx.ui` typed without a direct agent-surface import.
export type { SurfaceEmitter } from "@loom/agent-surface";
export {
  runAgentOnce,
  type RunAgentOnceOptions,
  type RunAgentOnceResult,
} from "./runAgentOnce";
