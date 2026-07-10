// `ExecutionRuntime` is the Loom 2.0 name for the durable runtime; `WorkflowRuntime`
// remains an alias for source compatibility.
export { WorkflowRuntime, WorkflowRuntime as ExecutionRuntime } from "./WorkflowRuntime";
export {
  ApprovalRejectedError,
  EFFECT_INDOUBT_RESOLVED,
  ExecutionDeniedError,
  FlowCodeMismatchError,
  FlowMigrationCheckError,
  StepTimeoutError,
  TIMER_FIRED,
} from "./types";
export { TimerService, type TimerServiceOptions } from "./TimerService";
export {
  LogLifecycle,
  type RetentionPolicy,
  type ArchiveStores,
  type RetentionOutcome,
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
  ResumeVerdict,
  RunOptions,
  SuspendConfig,
  WorkflowContext,
} from "./types";
export { KERNEL_ABI, KERNEL_ABI_VERSION, KERNEL_SYSCALLS } from "./abi";
export type { KernelAbi, KernelSyscall, SyscallKind } from "./abi";
export {
  serializeExecution,
  deserializeExecution,
  serializeProjections,
  deserializeProjections,
} from "./resumability";
export type { ProjectionSnapshot } from "./resumability";
