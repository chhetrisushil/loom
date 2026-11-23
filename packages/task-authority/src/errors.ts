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
    readonly epoch: number,
    readonly taskId?: string
  ) {
    super(`task lease "${lease}" exhausted: ${spent} of ${ceiling} spent (epoch ${epoch})`);
    this.name = "LeaseExhaustedError";
  }
}

/** The grant was revoked, or the revocation check could not be answered in time (fails closed). */
export class GrantRevokedError extends Error {
  readonly renewable = true;
  readonly retryable = false;
  constructor(
    detail: string,
    readonly taskId: string = detail,
    readonly epoch?: number
  ) {
    super(`task grant revoked: ${detail}`);
    this.name = "GrantRevokedError";
  }
}

/** R33: the effect under `CHILD_LEASE_TOOL` is not the one `childLeaseEffect()` made, or the middleware cannot tell. */
export class LeaseChildEffectUnbrandedError extends Error {
  readonly renewable = false;
  readonly retryable = false;
  constructor(toolId: string) {
    super(
      `task lease: the effect registered as "${toolId}" is not the branded child-lease effect: either the middleware was not given \`effects: () => runtime\`, or two copies of @loomwork/task-authority are installed (the brand is per module copy)`
    );
    this.name = "LeaseChildEffectUnbrandedError";
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

/** The grant a lease middleware was handed is not a verifiable task grant (forged or malformed). */
export class LeaseGrantInvalidError extends Error {
  readonly renewable = false;
  readonly retryable = false;
  constructor() {
    super("task lease: the task grant failed verification");
    this.name = "LeaseGrantInvalidError";
  }
}

/** The fold's custom-dimension cap is full, so `lease.<n>` could not be counted: the effect does not run. */
export class LeaseDimensionDroppedError extends Error {
  readonly renewable = false;
  readonly retryable = false;
  constructor(lease: string) {
    super(
      `task lease "${lease}": the meter was not folded (the execution's custom-dimension cap is full); the effect does not run`
    );
    this.name = "LeaseDimensionDroppedError";
  }
}

/** A renewal was refused (the broker said no, the gate answered `granted: false`, or `maxRenewals` ran out). Not renewable. */
export class RenewalDeniedError extends Error {
  readonly renewable = false;
  readonly retryable = false;
  constructor(reason: string) {
    super(`task renewal denied: ${reason}`);
    this.name = "RenewalDeniedError";
  }
}
