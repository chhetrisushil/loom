import type { EventEnvelope, ExecutionState } from "@loom/core";
import { flowEmitCount } from "./eventHandlers";
import { foldEvents } from "./foldEvents";

export class ReplayVM {
  private state: ExecutionState;
  // R1a — the containers (frames, decision map, audit lists, emit trie) THIS VM created and
  // may therefore write in place on the next commit. Dropped whenever the state escapes
  // (`getState`), so a state a caller holds is never mutated afterwards.
  private owned = new WeakSet<object>();

  // ADR 0113 D3 — the step ids that completed AFTER the execution's last `EXECUTION_MIGRATED`
  // (the replay-divergence detector's baseline resets there: a migration deliberately changes the
  // frame set). `undefined` until a migration is known: then every completed frame is baseline.
  // Allocated only for an execution that has been migrated, so the common path pays one string
  // compare per applied event.
  private postMigration: Set<string> | undefined;

  constructor(events: EventEnvelope[], initial?: Partial<ExecutionState>) {
    this.state = foldEvents(events, initial, this.owned);
    // A snapshot taken after a migration carries `_migrations`, but not WHEN: everything the
    // snapshot already holds is exempt, so only the tail's completions count.
    const migrated = initial?.variables?._migrations;
    if (Array.isArray(migrated) && migrated.length > 0) this.postMigration = new Set();
    for (const e of events) this.track(e);
  }

  private track(event: EventEnvelope): void {
    if (event.eventType === "EXECUTION_MIGRATED") {
      this.postMigration = new Set();
    } else if (this.postMigration !== undefined && event.eventType === "STEP_COMPLETED") {
      const id = (event.payload as { stepId?: unknown } | null)?.stepId;
      if (typeof id === "string") this.postMigration.add(id);
    }
  }

  /** ADR 0113 D3 — every recorded frame id, in first-start order (the order the log began them). */
  recordedFrameOrder(): string[] {
    return Object.keys(this.state.frames);
  }

  /**
   * ADR 0113 D3 — the ids of the COMPLETED frames a re-run of this execution is expected to
   * visit: every completed frame, except those recorded before the execution's last
   * `EXECUTION_MIGRATED` (a migration changes the frame set on purpose). A fresh array.
   */
  expectedReplayFrames(): string[] {
    const frames = this.state.frames;
    const out: string[] = [];
    for (const id of Object.keys(frames)) {
      if (frames[id]?.status !== "completed") continue;
      if (this.postMigration !== undefined && !this.postMigration.has(id)) continue;
      out.push(id);
    }
    return out;
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

  /** ADR 0113 D3 — the steps a decision's decider ran (`innerSteps`), when the record carries them. */
  getDecisionInnerSteps(decisionId: string): readonly string[] | undefined {
    const decisions = this.state.variables._decisions as
      | Record<string, { innerSteps?: unknown }>
      | undefined;
    if (decisions === undefined || !Object.hasOwn(decisions, decisionId)) return undefined;
    const inner = decisions[decisionId]?.innerSteps;
    return Array.isArray(inner) ? (inner as string[]) : undefined;
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
    this.track(event);
  }
}
