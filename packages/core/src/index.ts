// Explicit named re-exports (not `export *`). When compiled to CommonJS, a
// barrel of `export *` becomes a runtime `__exportStar(require(...))` call that
// bundlers (Rollup, used by Vite `build`) cannot statically trace — so consumers
// like the Angular example fail with "step$ is not exported by dist/index.js".
// Explicit re-exports compile to detectable named exports and fix that.
export type { EventEnvelope } from "./types/event";
export type {
  Execution,
  ExecutionFrame,
  ExecutionFromStateOpts,
  ExecutionPolicy,
  ExecutionResources,
  ExecutionState,
  ExecutionStatus,
  FrameStatus,
  SuspendCondition,
  SuspendWait,
} from "./types/execution";
export { executionFromState } from "./types/execution";
export { KERNEL_EVENT_KINDS } from "./eventKinds";
export type { EventKind } from "./eventKinds";
export { flowContentHash } from "./flowHash";
export { checkVersionPins } from "./versionPins";
export type { PinFinding, PinFindingCode, PinReport, VersionPins } from "./versionPins";
export { canonicalJson, fnv1a64, jsonSchemaHash } from "./schemaHash";
export { schedule$ } from "./builders/schedule";
export type { ScheduleConfig } from "./builders/schedule";
export {
  fail,
  ReplayError,
  StepError,
  StorageWriteError,
  SuspendError,
  TypedFailure,
  WorkflowNotFoundError,
} from "./types/errors";
export { BadRequestError, exposeError } from "./types/exposure";
export type { ExposedError } from "./types/exposure";
export type {
  AgentDefinition,
  AgentSkillDef,
  AnyProjectionDefinition,
  EffectKind,
  KnownEffectKind,
  KnownTaskKind,
  EffectMode,
  FlowDefinition,
  HandlerFn,
  HandlerLoader,
  HandlerRef,
  HandlerSpec,
  InstructionsLoader,
  InstructionsRef,
  InstructionsSpec,
  MemoryDefinition,
  PolicyDefinition,
  ProjectionDefinition,
  ProjectionHandlers,
  ProjectionHandlersRef,
  ProjectionHandlersSpec,
  ReachableTool,
  ScheduleDefinition,
  RetryPolicy,
  SkillDefinition,
  StepDefinition,
  StepHandlerContext,
  ExecutableTask,
  TaskDefinition,
  TaskKind,
  ToolDefinition,
} from "./types/definitions";
export { VOCABULARY_NAME_PATTERN, isVocabularyName } from "./types/definitions";
export {
  agent$,
  flow$,
  handler$,
  instructions$,
  loadInstructions,
  memory$,
  policy$,
  projection$,
  isProjectionHandlersRef,
  projectionEventTypes,
  loadProjectionHandlers,
  skill$,
  step$,
  tool$,
} from "./builders/index";
export type { SkillConfig } from "./builders/index";
