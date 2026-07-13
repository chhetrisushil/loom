import type { EventEnvelope, ExecutionState } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import { foldEvents } from "@loom/replay-vm";
import type { SubjectIndex } from "./SubjectIndex";

// ── T3-R3/R4.5 — subject erasure (GDPR Art. 17, right to be forgotten) ─────────
//
// Erasure destroys a subject's crypto key so its sensitive fields become unrecoverable
// (K10.2). The one hard rule (R4.5): NEVER shred a fold that is still in flight — a live
// execution reading the just-destroyed key would fail. So erasure is liveness-gated:
//   • all of a subject's executions terminal  → shred now.
//   • any still live                          → PARK the request (durable ERASURE_PENDING on a
//                                               control stream) and complete it automatically
//                                               when the last live execution terminates.
// Parking is honest (the request is recorded, not silently dropped) and survives a restart
// (the control stream folds back to the pending set).

/** Reserved control stream carrying deferred-erasure facts (ERASURE_PENDING). */
export const ERASURE_STREAM = "__loom_erasure__";

const TERMINAL_STATUS = new Set<ExecutionState["status"]>(["completed", "failed", "cancelled"]);
const TERMINAL_EVENTS = new Set(["EXECUTION_COMPLETED", "EXECUTION_FAILED", "EXECUTION_CANCELLED"]);

/**
 * Destroy a subject's erasure key across the given executions. Wire this to the crypto
 * plugin's `shredSubject` (bound to the KeyStore + raw store). MUST be idempotent — a
 * re-invocation for an already-erased subject should be a no-op (guard on key existence) so
 * restart-time re-completion never double-tombstones.
 */
export type Shredder = (subjectId: string, executionIds: readonly string[]) => Promise<void>;

export interface EraseCoordinatorOptions {
  index: SubjectIndex;
  eventStore: Pick<EventStore, "read" | "append">;
  shred: Shredder;
}

export interface EraseSubjectResult {
  subjectId: string;
  /** `erased` — key destroyed now; `parked` — deferred (live execution); `unknown` — no records. */
  outcome: "erased" | "parked" | "unknown";
  /** Executions whose data is now shredded (all of the subject's, when erased). */
  erased: string[];
  /** Live executions blocking completion (a parked request completes when these terminate). */
  pending: string[];
}

/**
 * Coordinates liveness-gated subject erasure and the auto-completion of parked requests.
 * Feed `handleEvent` the event stream (e.g. from `defineConfig`'s `onEvent`) so a parked
 * erasure completes the moment the subject's last live execution terminates.
 */
export class EraseCoordinator {
  /** Subjects awaiting completion in THIS process (authoritative live view; also durable). */
  private readonly parked = new Set<string>();

  constructor(private readonly options: EraseCoordinatorOptions) {}

  /** Best-effort: repopulate the parked set from the durable control stream (restart recovery). */
  async loadParked(): Promise<void> {
    for (const event of await this.options.eventStore.read(ERASURE_STREAM)) {
      if (event.eventType === "ERASURE_PENDING") {
        this.parked.add((event.payload as { subjectId: string }).subjectId);
      }
    }
  }

  /** Request erasure of a subject. Shreds now if all executions are terminal, else parks. */
  async eraseSubject(subjectId: string): Promise<EraseSubjectResult> {
    const executions = this.options.index.executionsOf(subjectId);
    if (executions.length === 0) {
      return { subjectId, outcome: "unknown", erased: [], pending: [] };
    }
    const live = await this.liveExecutions(executions);
    if (live.length === 0) {
      await this.options.shred(subjectId, executions);
      this.parked.delete(subjectId);
      return { subjectId, outcome: "erased", erased: executions, pending: [] };
    }
    // R4.5 — a live fold is in flight; record the request durably and defer.
    if (!this.parked.has(subjectId)) {
      this.parked.add(subjectId);
      await this.appendPending(subjectId);
    }
    return { subjectId, outcome: "parked", erased: [], pending: live };
  }

  /** Complete a parked erasure when the subject's last live execution terminates. */
  async handleEvent(event: EventEnvelope): Promise<void> {
    if (!TERMINAL_EVENTS.has(event.eventType) || this.parked.size === 0) return;
    const subjectId = this.options.index.subjectOfExecution(event.executionId);
    if (subjectId === undefined || !this.parked.has(subjectId)) return;
    const executions = this.options.index.executionsOf(subjectId);
    if ((await this.liveExecutions(executions)).length > 0) return; // still blocked
    await this.options.shred(subjectId, executions);
    this.parked.delete(subjectId);
  }

  /** Subjects with a deferred erasure still awaiting completion (sorted). */
  pendingSubjects(): string[] {
    return [...this.parked].sort();
  }

  /** The subset of `executions` that are not yet terminal (a live fold reading the key). */
  private async liveExecutions(executions: readonly string[]): Promise<string[]> {
    const live: string[] = [];
    for (const executionId of executions) {
      const events = await this.options.eventStore.read(executionId);
      if (events.length === 0) continue; // deleted by retention — nothing to protect
      const state = foldEvents(events, { executionId });
      if (!TERMINAL_STATUS.has(state.status)) live.push(executionId);
    }
    return live;
  }

  private async appendPending(subjectId: string): Promise<void> {
    const prior = await this.options.eventStore.read(ERASURE_STREAM);
    await this.options.eventStore.append({
      id: `erasure-${subjectId}-${prior.length}`,
      workflowId: ERASURE_STREAM,
      executionId: ERASURE_STREAM,
      eventType: "ERASURE_PENDING",
      sequence: prior.length,
      timestamp: 0, // deterministic; the fact of the request is what matters
      payload: { subjectId },
    });
  }
}
