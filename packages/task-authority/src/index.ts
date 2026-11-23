/** Slice-1 marker for `@loomwork/task-authority` (ADR 0150). */
export const TASK_AUTHORITY_VERSION = "0.0.0-slice1";

export {
  ScheduleDeniedError,
  ScheduleGrantError,
  TaskAuthorityPrincipalError,
  TaskGrantShapeError,
} from "./errors";
export type { GrantKeys, LeaseSpec, TaskGrant, UnsignedTaskGrant } from "./grant";
/**
 * `globCovers` and `widensReadsOrSandbox` are the REFERENCE subset check for a child grant's `reads` / `sandbox`
 * (ADR 0150 S-R4): a third-party broker should call `widensReadsOrSandbox(parent, child)` at mint and refuse on a
 * string result. `READS_MAX_STARS` / `READS_MAX_TOTAL` are the bounds `validateGrantShape` enforces.
 */
export {
  READS_MAX_STARS,
  READS_MAX_TOTAL,
  globCovers,
  widensReadsOrSandbox,
  signTaskGrant,
  taskGrantDigest,
  validateGrantShape,
  verifyTaskGrant,
} from "./grant";
export type { TaskGrantAuthorizerOptions } from "./authorizer";
export { TASK_GRANT_DENIAL, TaskGrantAuthorizer } from "./authorizer";
export type {
  GrantBroker,
  GrantSource,
  MintRequest,
  RenewalRequest,
  RenewalVerdict,
} from "./broker";
export { GrantBrokerError, InMemoryGrantLedger } from "./broker";
export type { RenewalPolicy } from "./renew";
export { InMemoryGrantBroker, MAX_JUSTIFICATION, MAX_JUSTIFICATIONS_KEPT } from "./renew";
export type { TaskAuthorityCodecOptions, TaskAuthorityPrincipalCodec } from "./codec";
export { TASK_REF_PREFIX, TASK_REF_PREFIX_V2, taskAuthorityPrincipalCodec } from "./codec";
export type { PrincipalCodecHost } from "./install";
export { installTaskAuthority } from "./install";
export type { TaskLeaseOptions } from "./lease";
export { taskLeaseMiddleware } from "./lease";
export {
  CrossLineageParkError,
  GrantRevokedError,
  LeaseDimensionDroppedError,
  LeaseDurabilityError,
  LeaseExhaustedError,
  LeaseGrantInvalidError,
  LeaseChildEffectUnbrandedError,
  LeaseUnmappedError,
  RenewalDeniedError,
} from "./errors";
export type { RenewalContext, RenewalRuntime } from "./renewal";
export {
  RENEWAL_GATE,
  RENEWAL_TERMINAL_NAMES,
  answerRenewal,
  isRenewable,
  renewalDecisionId,
  renewalViewDigest,
  renewalResumeSchema,
  withRenewal,
} from "./renewal";
export type { ChildGrantMinter, ChildLeaseContext } from "./childLease";
export {
  CHILD_LEASE_TOOL,
  childGrantMinter,
  childLeaseEffect,
  isChildLeaseEffect,
  reserveChildLease,
} from "./childLease";
export type { LineagePrincipal } from "./lineage";
export {
  LINEAGE_ORIGIN_MAX,
  LINEAGE_TOO_LONG,
  LINEAGE_ORIGIN_PREFIX,
  lineageOrigin,
  lineageSend,
  lineageTainter,
  wrapLineage,
} from "./lineage";
export type { CrossLineageAction, DirectedByOptions } from "./directedBy";
export { UNTRACKED_ORIGIN, directedBy, foreignSetHash } from "./directedBy";
export type { SandboxRequirementOptions } from "./sandboxRequirement";
export { sandboxRequirement } from "./sandboxRequirement";
export type {
  ScheduleApprovalContext,
  ScheduleApprovalRuntime,
  ScheduleGrantSpec,
} from "./scheduleGrant";
export {
  SCHEDULE_GATE,
  answerScheduleApproval,
  mintScheduleGrant,
  requestScheduleApproval,
  scheduleResumeSchema,
  scheduleViewDigest,
} from "./scheduleGrant";
