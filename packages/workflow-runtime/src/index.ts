// `ExecutionRuntime` is the Loom 2.0 name for the durable runtime; `WorkflowRuntime`
// remains an alias for source compatibility.
export { WorkflowRuntime, WorkflowRuntime as ExecutionRuntime } from "./WorkflowRuntime";
export {
  ApprovalRejectedError,
  CompactedForkPointError,
  DecideScopeClosedError,
  EFFECT_INDOUBT_RESOLVED,
  EXECUTION_RECOVERED,
  ExecutionAlreadyExistsError,
  ExecutionCancelledError,
  SnapshotIdentityMismatchError,
  ExecutionDeniedError,
  ExecutionNotTerminalError,
  OutcomeContendedError,
  OutcomeRefusedError,
  FlowCodeMismatchError,
  FlowDivergenceError,
  FlowMigrationCheckError,
  InboxClosedError,
  InboxFullError,
  InboxMessageRefusedError,
  InputValidationError,
  ParallelScopeFailedError,
  ResumePayloadValidationError,
  ResumeContendedError,
  ResumeRefusedError,
  StartFencedOutError,
  StateMigrationError,
  StepTimeoutError,
  TIMER_FIRED,
} from "./types";
export { PrincipalUnrestorableError } from "./principal";
export {
  CarryTooLargeError,
  ChainHopLimitError,
  ContinuationConflictError,
  ContinueAsNewRefusedError,
  ContinueAsNewUnavailableError,
  DEFAULT_MAX_CARRY_BYTES,
  DEFAULT_MAX_CHAIN_HOPS,
  ForkPastContinuationError,
  ReservedSuccessorIdError,
  chainOfState,
  successorIdOf,
  type ChainIdentity,
} from "./continuation";
export type {
  PrincipalCodec,
  PrincipalIdentityMode,
  PrincipalRecord,
  PrincipalResolver,
} from "./principal";
export {
  DEFAULT_MAX_REDRIVE_ATTEMPTS,
  RedriveExhaustedError,
  TimerService,
  redriveDelayMs,
  scheduleRedrive,
  type RedriveBackoff,
  type RedriveVerdict,
  type Redriver,
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
  DEFAULT_INBOX_MAX_BACKLOG,
  DEFAULT_INBOX_MAX_PAYLOAD_BYTES,
  MAX_MESSAGE_ID_LENGTH,
  INBOX_STREAM_PREFIX,
  INBOX_WAKE_AT,
  createInboxSource,
  inboxStreamId,
} from "./inbox";
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
  assertPinnedEventTypes,
  UnsafeCompactionError,
  CompactionCheckpointMissingError,
  type RetentionPolicy,
  type ArchiveStores,
  type RetentionOutcome,
  type PinPredicate,
  type RestoreTerminalResult,
} from "./LogLifecycle";
export {
  REHOMED_FROM_KEY,
  type BlankSegmentStatus,
  type BlankStreamCensus,
  type BlankStreamSegment,
  type RehomeAssignment,
  type RehomeProof,
  type UnattributedRun,
} from "./blankStream";
export { parseCron, nextOccurrence, type CronSpec } from "./cron";
export { answerApproval, approvalViewDigest, viewDigest } from "./approvalBinding";
export {
  MIN_SECRET_BYTES,
  SIGNED_RESUME_VERIFIED_BY,
  signResume,
  signedResumeAuthenticator,
  type SignedResumeOptions,
} from "./signedResumeAuthenticator";
export { executionAccessPolicy } from "./executionAccessPolicy";
export type {
  ExecutionOwner,
  ExecutionAccessPolicy,
  ExecutionAccessOptions,
  ExecutionScope,
} from "./executionAccessPolicy";
export type {
  DecideOptions,
  DecideScope,
  EffectInDoubtResolution,
  ExecutionAuthorizer,
  ExecutionAuthzRequest,
  ExecutionAuthzVerdict,
  ExecutionContext,
  ExecutionHandle,
  ExecutionOp,
  SystemGrant,
  LineageGrant,
  ForkOptions,
  ForkResult,
  FlowRunner,
  RegisteredFlow,
  ResourceDimension,
  ResumeAuthenticator,
  ResumeVerificationContext,
  ResumeEvent,
  ResumeRefusalReason,
  ResumeVerdict,
  RunOptions,
  SuspendConfig,
  BranchContext,
  ErrorClassCtor,
  InboxMessage,
  InboxSource,
  ParallelOptions,
  SelectArm,
  SelectResult,
  SendMessage,
  RecordOutcomeInput,
  RecordOutcomeOptions,
  RecordOutcomeResult,
  SendOptions,
  SendResult,
  WorkflowContext,
  ExecutionContextExtensions,
} from "./types";
// Re-exported so apps that name `runtime.invokeTransient(...)` options through
// the top-level runtime (or @loom/sdk) can name the type too (ADR 0066).
export type { TransientInvokeOptions } from "@loom/effect-runtime";
export { KERNEL_ABI, KERNEL_ABI_VERSION, KERNEL_SYSCALLS } from "./abi";
export type { SurfaceFactory } from "./WorkflowContext";
export type { KernelAbi, KernelSyscall, SyscallKind } from "./abi";
export {
  serializeExecution,
  deserializeExecution,
  serializeProjections,
  deserializeProjections,
} from "./resumability";
export type { ProjectionSnapshot } from "./resumability";
