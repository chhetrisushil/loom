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

/** A lease is spent (ADR 0150 D4). `renewable`: `withRenewal` may park for a broker renewal. */
export class LeaseExhaustedError extends Error {
  readonly renewable = true;
  readonly retryable = false;
  constructor(
    readonly lease: string,
    readonly ceiling: number,
    readonly spent: number,
    readonly epoch: number
  ) {
    super(`task lease "${lease}" exhausted: ${spent} of ${ceiling} spent (epoch ${epoch})`);
    this.name = "LeaseExhaustedError";
  }
}

/** The grant was revoked, or the revocation check could not be answered in time (fails closed). */
export class GrantRevokedError extends Error {
  readonly renewable = true;
  readonly retryable = false;
  constructor(detail: string) {
    super(`task grant revoked: ${detail}`);
    this.name = "GrantRevokedError";
  }
}

/** `strictLeases`: the effect is in scope but no lease counts it. */
export class LeaseUnmappedError extends Error {
  readonly renewable = false;
  readonly retryable = false;
  constructor(toolId: string) {
    super(`task lease: effect "${toolId}" is mapped to no lease (strictLeases)`);
    this.name = "LeaseUnmappedError";
  }
}

/** A leased effect met a context with no `flush()` (ADR 0151): its count could be lost, so it does not run. */
export class LeaseDurabilityError extends Error {
  readonly renewable = false;
  readonly retryable = false;
  constructor(toolId: string) {
    super(
      `task lease: effect "${toolId}" is lease-governed and runs only on a context that provides flush() (ADR 0150 D4, ADR 0151)`
    );
    this.name = "LeaseDurabilityError";
  }
}
