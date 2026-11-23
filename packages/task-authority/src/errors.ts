/** A task grant failed its structural bounds (ADR 0150 D2). */
export class TaskGrantShapeError extends Error {
  constructor(message: string) {
    super(`task-grant shape: ${message}`);
    this.name = "TaskGrantShapeError";
  }
}
