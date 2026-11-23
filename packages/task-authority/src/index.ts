/** Slice-1 marker for `@loomwork/task-authority` (ADR 0150). */
export const TASK_AUTHORITY_VERSION = "0.0.0-slice1";

export { TaskAuthorityPrincipalError, TaskGrantShapeError } from "./errors";
export type { GrantKeys, LeaseSpec, TaskGrant, UnsignedTaskGrant } from "./grant";
export {
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
  GrantRevokedError,
  LeaseDimensionDroppedError,
  LeaseDurabilityError,
  LeaseExhaustedError,
  LeaseGrantInvalidError,
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
  reserveChildLease,
} from "./childLease";
