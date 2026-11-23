/** Slice-1 marker for `@loomwork/task-authority` (ADR 0150). */
export const TASK_AUTHORITY_VERSION = "0.0.0-slice1";

export { TaskGrantShapeError } from "./errors";
export type { LeaseSpec, TaskGrant, UnsignedTaskGrant } from "./grant";
export { signTaskGrant, taskGrantDigest, validateGrantShape, verifyTaskGrant } from "./grant";
export type { TaskGrantAuthorizerOptions } from "./authorizer";
export { TASK_GRANT_DENIAL, TaskGrantAuthorizer } from "./authorizer";
