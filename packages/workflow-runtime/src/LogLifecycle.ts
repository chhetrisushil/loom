import type { EventEnvelope, ExecutionState } from "@loom/core";
import { type BranchRegistry, type EventStore, headOf } from "@loom/event-runtime";
import { appendBatchOf } from "@loom/event-runtime";
import { ReplayVM } from "@loom/replay-vm";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import { ulid } from "ulid";

/** Reserved control stream carrying retention facts (EXECUTION_ARCHIVED/_DELETED). */
export const LIFECYCLE_STREAM = "__loom_lifecycle__";

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

/**
 * Envelopes per archive round-trip. Bounded so a long execution cannot turn a
 * bounded-memory sweep into an unbounded one; large enough that the round-trip saving is
 * the dominant effect.
 */
const ARCHIVE_CHUNK = 256;

/** Where an execution is copied before deletion (A6 — archive-before-delete). */
export interface ArchiveStores {
  eventStore: EventStore;
  snapshotStore?: SnapshotStore;
}

/**
 * K10.6 (ADR 0055) — the pin seam: retention consults this predicate before
 * reclaiming an execution; `true` exempts it. The kernel checks the predicate;
 * WHAT pins is app/plugin policy (G3) — e.g. "executions whose log carries
 * finding events" via `@loom/plugin-content`'s `pinByEventKinds`. Content-blob
 * pinning is the companion seam (`sweepUnpinnedContent`), keyed by ref so pins
 * survive archival.
 */
export type PinPredicate = (executionId: string) => boolean | Promise<boolean>;

export type RetentionOutcome =
  | "reclaimed" // archived (if configured) then deleted
  | "kept" // terminal but still within its TTL
  | "not-terminal" // still running/suspended — never reclaimed
  | "blocked-by-branch" // a live descendant branch still depends on this prefix (R5.3)
  | "pinned" // exempted by the pin predicate (K10.6)
  | "unknown" // no events for this id
  | "unsupported"; // the store can't delete (no deleteExecution)

export class LogLifecycle {
  constructor(
    private readonly eventStore: EventStore,
    private readonly snapshotStore: SnapshotStore,
    private readonly options: {
      archive?: ArchiveStores;
      branchRegistry?: BranchRegistry;
      pinned?: PinPredicate;
    } = {}
  ) {}

  /**
   * R5.3 — a terminal execution MUST NOT be deleted while a live descendant branch still
   * exists (a fork's copied prefix may alias this one, and deleting it would break that
   * branch's replay/lineage). Conservative: block if any direct child still has events.
   */
  private async hasLiveDescendant(executionId: string): Promise<boolean> {
    const registry = this.options.branchRegistry;
    if (registry === undefined) return false;
    for (const child of await registry.children(executionId)) {
      // "Has any events" is a tip query, not a read. This runs per child, per swept
      // execution, against branch logs — which are the long ones, since a branch is forked
      // precisely to do expensive work.
      if ((await headOf(this.eventStore, child.executionId)) !== null) return true;
    }
    return false;
  }

  /** Journal a retention control fact to the dedicated lifecycle stream (P9: audit its own pruning). */
  private async emitLifecycleFact(
    eventType: "EXECUTION_ARCHIVED" | "EXECUTION_DELETED",
    executionId: string,
    now: number
  ): Promise<void> {
    const prior = await this.eventStore.read(LIFECYCLE_STREAM);
    const fact: EventEnvelope = {
      id: ulid(),
      workflowId: LIFECYCLE_STREAM,
      executionId: LIFECYCLE_STREAM,
      eventType,
      sequence: prior.length,
      timestamp: now,
      payload: { executionId },
    };
    await this.eventStore.append(fact);
  }

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

    // R5.3 — never delete a parent a live descendant branch still depends on.
    if (await this.hasLiveDescendant(executionId)) return "blocked-by-branch";

    // K10.6 — the pin gate, last before anything is copied or destroyed.
    if (this.options.pinned !== undefined && (await this.options.pinned(executionId)) === true) {
      return "pinned";
    }

    if (this.options.archive !== undefined) {
      const archive = this.options.archive;
      // ADR 0074 R7 — one round-trip per chunk instead of one per event. Reclamation has
      // to keep pace with ingest or the log grows without bound, and a serialized
      // per-event append loop is orders of magnitude short of that. `appendBatchOf` falls
      // back to that loop when the archive backend has no `appendBatch`, so this is a
      // straight improvement for backends that implement the hook and a no-op for the rest.
      //
      // Chunked rather than one giant batch: an execution's log can be arbitrarily long,
      // and a single statement carrying all of it would trade a bounded-memory sweep for
      // an unbounded one — the opposite of what the paged enumeration exists for.
      for (let i = 0; i < events.length; i += ARCHIVE_CHUNK) {
        await appendBatchOf(archive.eventStore, events.slice(i, i + ARCHIVE_CHUNK));
      }
      if (archive.snapshotStore !== undefined) {
        const snap = await this.snapshotStore.loadLatest(executionId);
        if (snap !== null) await archive.snapshotStore.save(snap);
      }
      await this.emitLifecycleFact("EXECUTION_ARCHIVED", executionId, now);
    }

    // Journal the deletion fact BEFORE deleting — the values go, the fact survives (P9).
    await this.emitLifecycleFact("EXECUTION_DELETED", executionId, now);
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
