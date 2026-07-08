// `ExecutionRuntime` is the Loom 2.0 name for the durable runtime; `WorkflowRuntime`
// remains an alias for source compatibility.
export { WorkflowRuntime, WorkflowRuntime as ExecutionRuntime } from "./WorkflowRuntime";
export type {
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
export {
  serializeExecution,
  deserializeExecution,
  serializeProjections,
  deserializeProjections,
} from "./resumability";
export type { ProjectionSnapshot } from "./resumability";
