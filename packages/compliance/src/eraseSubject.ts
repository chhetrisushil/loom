import type { EventEnvelope, ExecutionState } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import { foldEvents, normalizeSnapshotState } from "@loom/replay-vm";
import { assertSnapshotIdentity } from "@loom/snapshot-runtime";
import { DEFAULT_TENANT, type SubjectIndex } from "./SubjectIndex";

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
 * plugin's `shredSubject` (bound to the KeyStore + raw store + snapshot store). MUST be
 * idempotent — a re-invocation for an already-erased subject must not double-tombstone.
 * `shredSubject` is (ADR 0106): it skips every log already carrying the subject's
 * `PAYLOAD_SHREDDED` and writes the rest. Do NOT guard on key existence — a key can be gone
 * while a tombstone append failed, and that guard would never retry it.
 */
export type Shredder = (subjectId: string, executionIds: readonly string[]) => Promise<void>;

export interface EraseCoordinatorOptions {
  index: SubjectIndex;
  eventStore: Pick<EventStore, "read" | "append">;
  shred: Shredder;
  /**
   * ADR 0106 — where compaction checkpoints live. A compacted execution's log no longer holds
   * its prefix (`[0]` after compacting through the tip), so folding the log alone reads a
   * TERMINAL execution as still running and a parked erasure would wait for it forever. With
   * this, liveness folds on the latest snapshot. Pass it whenever the log can be compacted.
   */
  snapshotStore?: {
    loadLatest(executionId: string): Promise<{ sequence: number; state: ExecutionState } | null>;
  };
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
  // Parked requests keyed by `tenant\x00subject` (T3-R2.4 — two tenants may share a subject
  // id; they must not collide into one park entry). Authoritative live view; also durable.
  private readonly parked = new Set<string>();

  constructor(private readonly options: EraseCoordinatorOptions) {}

  /** Best-effort: repopulate the parked set from the durable control stream (restart recovery). */
  async loadParked(): Promise<void> {
    for (const event of await this.options.eventStore.read(ERASURE_STREAM)) {
      if (event.eventType === "ERASURE_PENDING") {
        const p = event.payload as { subjectId: string; tenant?: string };
        this.parked.add(parkKey(p.tenant ?? DEFAULT_TENANT, p.subjectId));
      }
    }
  }

  /** Request erasure of a subject within a tenant. Shreds now if all executions are terminal, else parks. */
  async eraseSubject(
    subjectId: string,
    tenant: string = DEFAULT_TENANT
  ): Promise<EraseSubjectResult> {
    const executions = this.options.index.executionsOf(subjectId, tenant);
    if (executions.length === 0) {
      return { subjectId, outcome: "unknown", erased: [], pending: [] };
    }
    const live = await this.liveExecutions(executions);
    if (live.length === 0) {
      await this.options.shred(subjectId, executions);
      this.parked.delete(parkKey(tenant, subjectId));
      return { subjectId, outcome: "erased", erased: executions, pending: [] };
    }
    // R4.5 — a live fold is in flight; record the request durably and defer.
    if (!this.parked.has(parkKey(tenant, subjectId))) {
      this.parked.add(parkKey(tenant, subjectId));
      await this.appendPending(subjectId, tenant);
    }
    return { subjectId, outcome: "parked", erased: [], pending: live };
  }

  /** Complete a parked erasure when the subject's last live execution terminates. */
  async handleEvent(event: EventEnvelope): Promise<void> {
    if (!TERMINAL_EVENTS.has(event.eventType) || this.parked.size === 0) return;
    const subjectId = this.options.index.subjectOfExecution(event.executionId);
    if (subjectId === undefined) return;
    const tenant = this.options.index.tenantOfExecution(event.executionId) ?? DEFAULT_TENANT;
    if (!this.parked.has(parkKey(tenant, subjectId))) return;
    const executions = this.options.index.executionsOf(subjectId, tenant);
    if ((await this.liveExecutions(executions)).length > 0) return; // still blocked
    await this.options.shred(subjectId, executions);
    this.parked.delete(parkKey(tenant, subjectId));
  }

  /** Subjects with a deferred erasure still awaiting completion (sorted, deduped across tenants). */
  pendingSubjects(): string[] {
    return [...new Set([...this.parked].map(subjectOfKey))].sort();
  }

  /** The subset of `executions` that are not yet terminal (a live fold reading the key). */
  private async liveExecutions(executions: readonly string[]): Promise<string[]> {
    const live: string[] = [];
    for (const executionId of executions) {
      const events = await this.options.eventStore.read(executionId);
      if (events.length === 0) continue; // deleted by retention — nothing to protect
      const snapshot = (await this.options.snapshotStore?.loadLatest(executionId)) ?? null;
      // Fill a blank legacy identity; a NON-blank one naming another execution is a store or
      // tenant-scoping defect, refused as everywhere else a fold is seeded (ADR 0106).
      if (snapshot !== null) {
        assertSnapshotIdentity(snapshot.state, executionId, events[0]?.workflowId ?? "");
      }
      const state =
        snapshot !== null
          ? foldEvents(
              events.filter((e) => e.sequence > snapshot.sequence),
              // A pre-ADR-0106 checkpoint may carry a blank identity: fill it, as the kernel does.
              // A pre-1.21.0 snapshot may read `failed` for a caught step failure: repair it
              // (ADR 0105), or a live execution would read terminal and be shredded.
              {
                ...normalizeSnapshotState(snapshot.state),
                executionId: snapshot.state.executionId || executionId,
                workflowId: snapshot.state.workflowId || (events[0]?.workflowId ?? ""),
              }
            )
          : foldEvents(events, { executionId });
      if (!TERMINAL_STATUS.has(state.status)) live.push(executionId);
    }
    return live;
  }

  // `prior.length` is the next sequence only because a reserved stream is never compacted:
  // `LogLifecycle.compact` refuses one (ADR 0106).
  private async appendPending(subjectId: string, tenant: string): Promise<void> {
    const prior = await this.options.eventStore.read(ERASURE_STREAM);
    await this.options.eventStore.append({
      id: `erasure-${prior.length}`,
      workflowId: ERASURE_STREAM,
      executionId: ERASURE_STREAM,
      eventType: "ERASURE_PENDING",
      sequence: prior.length,
      timestamp: 0, // deterministic; the fact of the request is what matters
      payload: { subjectId, ...(tenant !== DEFAULT_TENANT && { tenant }) },
    });
  }
}

// `tenant\x00subject` — NUL separates the two id spaces (never appears in a real id), so a
// tenant/subject boundary can't be spoofed by crafting an id that contains the separator.
function parkKey(tenant: string, subject: string): string {
  return `${tenant}\x00${subject}`;
}
function subjectOfKey(key: string): string {
  return key.slice(key.indexOf("\x00") + 1);
}
