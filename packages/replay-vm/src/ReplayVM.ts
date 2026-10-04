import type { EventEnvelope, ExecutionState } from "@loom/core";
import { flowEmitCount } from "./eventHandlers";
import { foldEvents } from "./foldEvents";

export class ReplayVM {
  private state: ExecutionState;
  // R1a — the containers (frames, decision map, audit lists, emit trie) THIS VM created and
  // may therefore write in place on the next commit. Dropped whenever the state escapes
  // (`getState`), so a state a caller holds is never mutated afterwards.
  private owned = new WeakSet<object>();

  constructor(events: EventEnvelope[], initial?: Partial<ExecutionState>) {
    this.state = foldEvents(events, initial, this.owned);
  }

  hasCompleted(stepId: string): boolean {
    return this.state.frames[stepId]?.status === "completed";
  }

  hasFailed(stepId: string): boolean {
    return this.state.frames[stepId]?.status === "failed";
  }

  // DE-4 (ADR 0060) — the typed-failure twin of hasCompleted/getOutput. Defined
  // only when the step's frame failed ON A DECLARED CHANNEL (a 1.17.0 typed
  // STEP_FAILED); untyped failures return undefined and keep the legacy
  // re-execute-on-replay semantics.
  getTypedFailure(
    stepId: string
  ): { channel: string; payload: unknown; error?: unknown } | undefined {
    const frame = this.state.frames[stepId];
    if (frame?.status !== "failed" || frame.errorChannel === undefined) return undefined;
    return {
      channel: frame.errorChannel,
      payload: frame.errorPayload,
      ...(frame.error !== undefined && { error: frame.error }),
    };
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

  // ADR 0102 — how many stamped flow-level emits with this content digest the log holds
  // (the `_flowEmits` fold). A re-run serves its n-th emit of a digest from the log while
  // n < this count.
  flowEmitCount(digest: string): number {
    return flowEmitCount(this.state.variables, digest);
  }

  /**
   * The folded state, for a caller that may KEEP it (a snapshot save, a returned handle, a
   * test). It is stable: later `applyEvent`s never write to it, at the price of one container
   * copy on the next commit (ownership is dropped). Callers that only read and drop the value
   * within the same synchronous turn should use {@link peekState}.
   */
  getState(): ExecutionState {
    this.owned = new WeakSet<object>();
    return this.state;
  }

  /**
   * A BORROWED view of the live state: read it and let go before the next `applyEvent`. It
   * does not retire fold ownership, so the commit path stays O(1) per event. Do not retain it,
   * hand it to a caller, or mutate it.
   */
  peekState(): ExecutionState {
    return this.state;
  }

  applyEvent(event: EventEnvelope): void {
    this.state = foldEvents([event], this.state, this.owned);
  }
}
