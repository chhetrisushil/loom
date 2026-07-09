// `ExecutionRuntime` is the Loom 2.0 name for the durable runtime; `WorkflowRuntime`
// remains an alias for source compatibility.
export { WorkflowRuntime, WorkflowRuntime as ExecutionRuntime } from "./WorkflowRuntime";
export { EFFECT_INDOUBT_RESOLVED, StepTimeoutError } from "./types";
export type {
  EffectInDoubtResolution,
  ExecutionContext,
  ExecutionHandle,
  ForkOptions,
  ForkResult,
  FlowRunner,
  RegisteredFlow,
  ResumeEvent,
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
