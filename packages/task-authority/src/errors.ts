/** A task grant failed its structural bounds (ADR 0150 D2). */
export class TaskGrantShapeError extends Error {
  constructor(message: string) {
    super(`task-grant shape: ${message}`);
    this.name = "TaskGrantShapeError";
  }
}

/**
 * `toRef` met a chain carrying a `taskGrant` it cannot record as a `ta1:` ref (ADR 0150 R13). Thrown, not
 * returned as `undefined`: the kernel then refuses the start before anything is appended, instead of
 * writing a default record that drops the grant and runs every effect at the authorizer's base authority.
 */
export class TaskAuthorityPrincipalError extends Error {
  constructor(reason: string) {
    super(`task-authority principal: ${reason}`);
    this.name = "TaskAuthorityPrincipalError";
  }
}
