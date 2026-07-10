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

  // Loom 2.0 (P9) — decision short-circuit, the twin of hasCompleted/getOutput.
  // On replay, a decisionId already present in the log is served from state so the
  // optimizer/router is never re-consulted.
  hasDecision(decisionId: string): boolean {
    const decisions = this.state.variables._decisions as Record<string, unknown> | undefined;
    return decisions !== undefined && Object.hasOwn(decisions, decisionId);
  }

  getDecision(decisionId: string): unknown {
    const decisions = this.state.variables._decisions as
      | Record<string, { choice: unknown }>
      | undefined;
    // Own-key check (matches hasDecision) so a `__proto__`/inherited name can never read
    // through the prototype chain.
    if (decisions === undefined || !Object.hasOwn(decisions, decisionId)) return undefined;
    return decisions[decisionId]?.choice;
  }

  getState(): ExecutionState {
    return this.state;
  }

  applyEvent(event: EventEnvelope): void {
    this.state = foldEvents([event], this.state);
  }
}
