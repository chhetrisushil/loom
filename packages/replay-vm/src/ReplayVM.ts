import type { EventEnvelope, ExecutionState } from "@loom/core";
import { foldEvents } from "./foldEvents";

export class ReplayVM {
  private state: ExecutionState;

  constructor(events: EventEnvelope[], initial?: Partial<ExecutionState>) {
    this.state = foldEvents(events, initial);
  }

  hasCompleted(stepId: string): boolean {
    return this.state.frames[stepId]?.status === "completed";
  }

  hasFailed(stepId: string): boolean {
    return this.state.frames[stepId]?.status === "failed";
  }

  getOutput(stepId: string): unknown {
    return this.state.frames[stepId]?.output;
  }

  getState(): ExecutionState {
    return this.state;
  }

  applyEvent(event: EventEnvelope): void {
    this.state = foldEvents([event], this.state);
  }
}
