import type { ExecutionState } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import { ReplayVM } from "@loom/replay-vm";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import { ulid } from "ulid";

// ── K10.1 / K10.4 — log lifecycle: retention & compaction ─────────────────────
//
// A kernel reclaims resources. Retention removes terminal executions after their
// window elapses; compaction bounds a long-lived execution's replay tail. Both
// preserve the fold: retention only removes ELIGIBLE (terminal, aged, archived)
// executions, and compaction guarantees `fold(snapshot, suffix) === fold(events)`
// so a compacted execution still resumes/replays identically.

const TERMINAL = new Set<ExecutionState["status"]>(["completed", "failed", "cancelled"]);

export interface RetentionPolicy {
  /** Keep a terminal execution this long after its last event, then reclaim it. */
  terminalTtlMs: number;
}

/** Where an execution is copied before deletion (A6 — archive-before-delete). */
export interface ArchiveStores {
  eventStore: EventStore;
  snapshotStore?: SnapshotStore;
}

export type RetentionOutcome =
  | "reclaimed" // archived (if configured) then deleted
  | "kept" // terminal but still within its TTL
  | "not-terminal" // still running/suspended — never reclaimed
  | "unknown" // no events for this id
  | "unsupported"; // the store can't delete (no deleteExecution)

export class LogLifecycle {
  constructor(
    private readonly eventStore: EventStore,
    private readonly snapshotStore: SnapshotStore,
    private readonly options: { archive?: ArchiveStores } = {}
  ) {}

  /**
   * K10.1 — reclaim one execution if it is terminal AND older than the policy
   * window. Archive-before-delete when an archive is configured (A6 — naive
   * deletion starves the learning plane + deploy-sim corpus): every event is
   * copied to the archive, plus its latest snapshot, and only then is the
   * primary deleted. Replay of an archived execution requires rehydration but
   * remains byte-identical. Returns what happened (idempotent: a second call is
   * `unknown`).
   */
  async applyRetention(
    executionId: string,
    policy: RetentionPolicy,
    now: number
  ): Promise<RetentionOutcome> {
    if (this.eventStore.deleteExecution === undefined) return "unsupported";
    const events = await this.eventStore.read(executionId);
    if (events.length === 0) return "unknown";

    const state = new ReplayVM(events).getState();
    if (!TERMINAL.has(state.status)) return "not-terminal";
    const endedAt = events[events.length - 1]!.timestamp;
    if (now - endedAt < policy.terminalTtlMs) return "kept";

    if (this.options.archive !== undefined) {
      const archive = this.options.archive;
      for (const event of events) await archive.eventStore.append(event);
      if (archive.snapshotStore !== undefined) {
        const snap = await this.snapshotStore.loadLatest(executionId);
        if (snap !== null) await archive.snapshotStore.save(snap);
      }
    }

    await this.eventStore.deleteExecution(executionId);
    await this.snapshotStore.deleteExecution?.(executionId);
    return "reclaimed";
  }

  /**
   * K10.4 — compact an execution: checkpoint the folded state as a snapshot at
   * the current tip, then truncate the prefix (sequence 0 stays as the bootstrap
   * anchor). Afterward the replay tail is bounded to events appended AFTER the
   * checkpoint, while `fold(snapshot, suffix) === fold(events)` still holds — a
   * resume/replay is byte-identical. Returns the sequence compacted through, or
   * `null` when the store can't truncate (no `truncatePrefix`) or there is
   * nothing to compact.
   */
  async compact(executionId: string): Promise<number | null> {
    if (this.eventStore.truncatePrefix === undefined) return null;
    const events = await this.eventStore.read(executionId);
    if (events.length <= 1) return null; // nothing beyond the bootstrap to reclaim
    const tip = events[events.length - 1]!.sequence;

    const state = new ReplayVM(events).getState();
    const snapshot: Snapshot = {
      id: ulid(),
      executionId,
      workflowId: state.workflowId,
      sequence: tip,
      state,
      createdAt: 0, // deterministic; the sequence, not the wall clock, is load-bearing
    };
    // MUST persist the checkpoint before truncating — the snapshot is what the
    // suffix folds onto; truncating first would lose the prefix irrecoverably.
    await this.snapshotStore.save(snapshot);
    await this.eventStore.truncatePrefix(executionId, tip);
    return tip;
  }
}
