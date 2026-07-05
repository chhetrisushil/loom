// Explicit named re-exports (not `export *`). When compiled to CommonJS, a
// barrel of `export *` becomes a runtime `__exportStar(require(...))` call that
// bundlers (Rollup, used by Vite `build`) cannot statically trace — so consumers
// like the Angular example fail with "step$ is not exported by dist/index.js".
// Explicit re-exports compile to detectable named exports and fix that.
export type { EventEnvelope } from "./types/event";
export type {
  ExecutionFrame,
  ExecutionState,
  ExecutionStatus,
  FrameStatus,
  SuspendCondition,
} from "./types/execution";
export { ReplayError, StepError, SuspendError, WorkflowNotFoundError } from "./types/errors";
export type {
  AgentDefinition,
  AgentSkillDef,
  EffectKind,
  FlowDefinition,
  HandlerFn,
  HandlerLoader,
  HandlerRef,
  HandlerSpec,
  MemoryDefinition,
  PolicyDefinition,
  ProjectionDefinition,
  RetryPolicy,
  StepDefinition,
  StepHandlerContext,
  ToolDefinition,
} from "./types/definitions";
export {
  agent$,
  flow$,
  handler$,
  memory$,
  policy$,
  projection$,
  step$,
  tool$,
} from "./builders/index";
