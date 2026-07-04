import type { SuspendCondition } from "./execution";

export class SuspendError extends Error {
  readonly condition: SuspendCondition;

  constructor(condition: SuspendCondition) {
    super("SUSPEND");
    this.name = "SuspendError";
    this.condition = condition;
    Object.setPrototypeOf(this, SuspendError.prototype);
  }
}

export class StepError extends Error {
  readonly stepId: string;
  readonly cause: unknown;

  constructor(stepId: string, cause: unknown) {
    super(`Step "${stepId}" failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "StepError";
    this.stepId = stepId;
    this.cause = cause;
    Object.setPrototypeOf(this, StepError.prototype);
  }
}

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
    Object.setPrototypeOf(this, ReplayError.prototype);
  }
}

export class WorkflowNotFoundError extends Error {
  constructor(executionId: string) {
    super(`No execution found for id: ${executionId}`);
    this.name = "WorkflowNotFoundError";
    Object.setPrototypeOf(this, WorkflowNotFoundError.prototype);
  }
}
