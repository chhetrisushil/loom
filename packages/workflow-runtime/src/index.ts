// `ExecutionRuntime` is the Loom 2.0 name for the durable runtime; `WorkflowRuntime`
// remains an alias for source compatibility.
export { WorkflowRuntime, WorkflowRuntime as ExecutionRuntime } from "./WorkflowRuntime";
export {
  ApprovalRejectedError,
  EFFECT_INDOUBT_RESOLVED,
  EXECUTION_RECOVERED,
  ExecutionAlreadyExistsError,
  ExecutionDeniedError,
  FlowCodeMismatchError,
  FlowMigrationCheckError,
  InputValidationError,
  ResumePayloadValidationError,
  ResumeRefusedError,
  StateMigrationError,
  StepTimeoutError,
  TIMER_FIRED,
} from "./types";
export {
  TimerService,
  type TimerServiceOptions,
  type TimerDispatcher,
} from "./TimerService";
export {
  recoverAbandoned,
  type AbandonedCandidate,
  type RecoverAbandonedOptions,
  type RecoverAbandonedSummary,
} from "./recoverAbandoned";
export {
  retireAbandonedBranches,
  type BranchCandidate,
  type RetireAbandonedBranchesOptions,
  type RetireAbandonedBranchesSummary,
} from "./retireAbandonedBranches";
export { placementOf, COMPUTE_TARGET_KEY } from "./placement";
export {
  orphanCensus,
  type CensusStateReader,
  type LeaseCoverage,
  type OrphanBand,
  type OrphanCensus,
  type OrphanCensusOptions,
} from "./orphanCensus";
export {
  reconcileTimers,
  type ReconcileTimersOptions,
  type ReconcileTimersSummary,
} from "./reconcileTimers";
export {
  pruneBranchRefs,
  type PruneBranchRefsOptions,
  type PruneBranchRefsSummary,
} from "./pruneBranchRefs";
export {
  LogLifecycle,
  UnsafeCompactionError,
  type RetentionPolicy,
  type ArchiveStores,
  type RetentionOutcome,
  type PinPredicate,
} from "./LogLifecycle";
export { parseCron, nextOccurrence, type CronSpec } from "./cron";
export type {
  DecideOptions,
  EffectInDoubtResolution,
  ExecutionAuthorizer,
  ExecutionAuthzRequest,
  ExecutionAuthzVerdict,
  ExecutionContext,
  ExecutionHandle,
  ExecutionOp,
  ForkOptions,
  ForkResult,
  FlowRunner,
  RegisteredFlow,
  ResourceDimension,
  ResumeAuthenticator,
  ResumeEvent,
  ResumeRefusalReason,
  ResumeVerdict,
  RunOptions,
  SuspendConfig,
  WorkflowContext,
} from "./types";
// Re-exported so apps that name `runtime.invokeTransient(...)` options through
// the top-level runtime (or @loom/sdk) can name the type too (ADR 0066).
export type { TransientInvokeOptions } from "@loom/effect-runtime";
export { KERNEL_ABI, KERNEL_ABI_VERSION, KERNEL_SYSCALLS } from "./abi";
export type { KernelAbi, KernelSyscall, SyscallKind } from "./abi";
export {
  serializeExecution,
  deserializeExecution,
  serializeProjections,
  deserializeProjections,
} from "./resumability";
export type { ProjectionSnapshot } from "./resumability";
