import type { EventEnvelope, ExecutionState } from "@loom/core";
import { type BranchRegistry, type EventStore, headOf } from "@loom/event-runtime";
import { appendBatchOf } from "@loom/event-runtime";
import { ReplayVM, knownEventTypes, normalizeSnapshotState } from "@loom/replay-vm";
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
  | "unsupported" // the store can't delete (no deleteExecution)
  // the log is encrypted and the archive does not share its KeyStore: archiving would copy
  // decrypted rows out of the erasure boundary (ADR 0022 Amendment) — nothing is touched
  | "unsafe-archive";

/**
 * Thrown by {@link LogLifecycle.compact} when the event store encrypts at rest and the
 * snapshot store does not share its `KeyStore` (ADR 0022 Amendment).
 *
 * Compaction saves the DECRYPTED fold as a snapshot and then truncates the ciphertext it came
 * from. Into a plaintext snapshot store — or one encrypting under different keys — that turns
 * shreddable ciphertext into data a key shred no longer erases: the A1 "erasure theater" hole.
 * A throw, not a `null`: `null` already means "nothing to compact", and a guard that answers
 * like a no-op is one nobody notices firing.
 */
export class UnsafeCompactionError extends Error {
  constructor(readonly executionId: string) {
    super(
      `refusing to compact "${executionId}": the event store encrypts at rest, but the snapshot store does not share its KeyStore — the checkpoint would hold the decrypted fold outside the erasure boundary, so shredding the subject would no longer erase it. Wrap the snapshot store in an EncryptingSnapshotStore over the SAME KeyStore.`
    );
    this.name = "UnsafeCompactionError";
  }
}

/**
 * The structural encryption marker (`keys`) an encrypting store exposes — the same probe
 * `loom doctor` uses, so this package does not depend on `@loom/plugin-crypto`. Decorators
 * carry it up (`installOptional`), so a store wrapped above the encrypting one still shows it.
 */
function keysOf(store: unknown): object | undefined {
  const keys = (store as { keys?: unknown } | undefined)?.keys;
  return typeof keys === "object" && keys !== null ? keys : undefined;
}

/**
 * Thrown by {@link LogLifecycle.compact} when the log was compacted before and the checkpoint
 * that prefix was folded into is gone (ADR 0106). Folding what survives would checkpoint a
 * state missing the whole compacted prefix, and truncating on top of it would make the loss
 * permanent — so nothing is saved or truncated.
 */
export class CompactionCheckpointMissingError extends Error {
  constructor(
    readonly executionId: string,
    readonly missingThrough: number
  ) {
    super(
      `refusing to compact "${executionId}": its log has no events through sequence ${missingThrough} (an earlier compaction) and no snapshot at or above it holds that prefix — the checkpoint is missing, so the fold of what survives would be wrong.`
    );
    this.name = "CompactionCheckpointMissingError";
  }
}

/**
 * The highest sequence missing BELOW the log's tip, or -1 when the log is contiguous from 0.
 * Compaction is the only thing that removes events, and it always removes its own checkpoint
 * sequence (ADR 0106), so this is the lowest sequence any valid checkpoint may sit at. One
 * backward pass; stops at the first gap from the top.
 */
function highestMissing(events: readonly EventEnvelope[]): number {
  for (let i = events.length - 1; i > 0; i--) {
    const at = events[i]!.sequence;
    if (at - events[i - 1]!.sequence > 1) return at - 1;
  }
  return events.length > 0 && events[0]!.sequence !== 0 ? events[0]!.sequence - 1 : -1;
}

const KERNEL_EVENT_TYPES = new Set(knownEventTypes());

export class LogLifecycle {
  constructor(
    private readonly eventStore: EventStore,
    private readonly snapshotStore: SnapshotStore,
    private readonly options: {
      archive?: ArchiveStores;
      branchRegistry?: BranchRegistry;
      pinned?: PinPredicate;
      /**
       * ADR 0106 — the app's pinned event KINDS (ADR 0055 D1: the same list it gives
       * `pinByEventKinds` and `sweepUnpinnedContent`). {@link compact} keeps every event of
       * these kinds in place instead of truncating it, so a compacted run still carries its
       * findings. Kernel event kinds are refused: the fold already carries what they record,
       * and kernel log readers assume none survive below a checkpoint.
       */
      pinnedEventTypes?: readonly string[];
    } = {}
  ) {
    const kernel = (options.pinnedEventTypes ?? []).filter((t) => KERNEL_EVENT_TYPES.has(t));
    if (kernel.length > 0) {
      throw new TypeError(
        `LogLifecycle: pinnedEventTypes names kernel event kind(s) ${kernel.join(", ")} — compaction keeps app evidence events, not kernel facts (the checkpoint already carries their fold). Pin the execution (\`pinned\`) to keep its whole log.`
      );
    }
    this.keep = new Set(options.pinnedEventTypes);
  }

  /** {@link LogLifecycle} options' `pinnedEventTypes`, as a set. */
  private readonly keep: ReadonlySet<string>;

  /**
   * The archive retention copies into, if one is configured. Read-only. Operator passes that
   * must see every store holding citations (the content sweep's orphan pass, ADR 0055 D6)
   * take it from here, so a `--config` run cannot forget it.
   */
  get archive(): ArchiveStores | undefined {
    return this.options.archive;
  }

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
  /**
   * Every gate `applyRetention` applies, with nothing done — `"reclaimable"` means a real run
   * would delete this execution.
   *
   * Exists so a preview cannot drift from the thing it previews. `loom retention run`'s dry
   * run used to re-implement eligibility locally (terminal + aged), which silently omitted the
   * branch and pin gates: it printed `would-reclaim` for executions the library would refuse,
   * and a `--apply` flag whose preview disagrees with its apply is worse than no preview.
   */
  async evaluate(
    executionId: string,
    policy: RetentionPolicy,
    now: number
  ): Promise<RetentionOutcome | "reclaimable"> {
    if (this.eventStore.deleteExecution === undefined) return "unsupported";
    if (!this.archiveIsSafe()) return "unsafe-archive";
    const events = await this.eventStore.read(executionId);
    if (events.length === 0) return "unknown";

    const state = await this.foldForRetention(executionId, events);
    if (!TERMINAL.has(state.status)) return "not-terminal";
    // A compacted log's last surviving event may be the bootstrap, so the folded state's
    // `updatedAt` (the terminal event's timestamp) is the end when it is later.
    const endedAt = Math.max(events[events.length - 1]!.timestamp, state.updatedAt);
    if (now - endedAt < policy.terminalTtlMs) return "kept";

    // R5.3 — never delete a parent a live descendant branch still depends on.
    if (await this.hasLiveDescendant(executionId)) return "blocked-by-branch";

    // K10.6 — the pin gate, last before anything is copied or destroyed.
    if (this.options.pinned !== undefined && (await this.options.pinned(executionId)) === true) {
      return "pinned";
    }
    return "reclaimable";
  }

  /**
   * Fold what retention judges eligibility on. A log that was compacted keeps its prefix in
   * the checkpoint: folding the surviving events alone reads a completed execution as
   * not-terminal forever, so a compacted execution could never be reclaimed. A compacted log
   * is not always visibly gapped — compacting past a kept (pinned-kind) event at the tip
   * leaves `[0, 1, …]` contiguous with the checkpoint above it (ADR 0106) — so the latest
   * snapshot is always consulted: one point-read.
   */
  private async foldForRetention(
    executionId: string,
    events: EventEnvelope[]
  ): Promise<ExecutionState> {
    const snapshot = await this.snapshotStore.loadLatest(executionId);
    if (snapshot === null || snapshot.sequence < highestMissing(events)) {
      return new ReplayVM(events).getState();
    }
    const suffix = events.filter((e) => e.sequence > snapshot.sequence);
    return new ReplayVM(suffix, normalizeSnapshotState(snapshot.state)).getState();
  }

  /**
   * ADR 0022 Amendment — an archive receives what retention READ through the event store,
   * i.e. plaintext, plus the DECRYPTED latest snapshot. When the source encrypts, each archive
   * store must encrypt under the SAME KeyStore, or archiving moves the subject's data out of
   * reach of a key shred. Structural (identity of `keys`); whether the archive's `sensitive`
   * paths cover the source's cannot be checked this way (ADR 0022, `loom doctor`).
   */
  private archiveIsSafe(): boolean {
    const archive = this.options.archive;
    if (archive === undefined) return true;
    const eventKeys = keysOf(this.eventStore);
    if (eventKeys !== undefined && keysOf(archive.eventStore) !== eventKeys) return false;
    if (archive.snapshotStore !== undefined) {
      const snapshotKeys = keysOf(this.snapshotStore);
      const target = keysOf(archive.snapshotStore);
      if (eventKeys !== undefined && target !== eventKeys) return false;
      if (snapshotKeys !== undefined && target !== snapshotKeys) return false;
    }
    return true;
  }

  async applyRetention(
    executionId: string,
    policy: RetentionPolicy,
    now: number
  ): Promise<RetentionOutcome> {
    const verdict = await this.evaluate(executionId, policy, now);
    if (verdict !== "reclaimable") return verdict;
    // `evaluate` already refused a store that cannot delete; this re-reads it to narrow the
    // type rather than asserting one.
    const deleteExecution = this.eventStore.deleteExecution;
    if (deleteExecution === undefined) return "unsupported";
    const events = await this.eventStore.read(executionId);

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
    await deleteExecution.call(this.eventStore, executionId);
    await this.snapshotStore.deleteExecution?.(executionId);
    // The fork edge described data that no longer exists. Dropping it here is the only
    // point where the id is known AND the data is provably gone — and leaving it would
    // make every future sweep walk a dead child (see `hasLiveDescendant`), so the cost of
    // retention would grow with every fork ever taken. Optional on the SPI: a registry
    // that omits it keeps its edges, byte-identically to before.
    await this.options.branchRegistry?.removeLineage?.(executionId);
    return "reclaimed";
  }

  /**
   * K10.4 — compact an execution: checkpoint the folded state as a snapshot at sequence `c`,
   * then truncate the prefix `(0..c]` (sequence 0 stays as the bootstrap anchor). Afterward
   * the replay tail is bounded to events after the checkpoint, while
   * `fold(snapshot, suffix) === fold(events)` still holds — a resume/replay is identical.
   *
   * ADR 0106 (L11) — what the checkpoint and the truncation must preserve:
   *
   *  - **Identity.** The checkpoint's `executionId`/`workflowId` come from the log (sequence
   *    0 names both); `workflowVersion`, which no event records, is carried from the latest
   *    snapshot. A blank identity made every event a resume appended land in execution `""`.
   *  - **The earlier prefix.** A log compacted before is folded ON its latest checkpoint, never
   *    from the surviving events alone (which would drop everything the first compaction
   *    folded away). A gapped log with no checkpoint covering the gap throws
   *    {@link CompactionCheckpointMissingError}, touching nothing.
   *  - **Pinned kinds (ADR 0055 D1).** Events of `pinnedEventTypes` stay in place
   *    (`truncatePrefixKeeping`). `c` is the highest non-kept sequence ≤ the tip, so the
   *    checkpoint's own sequence is always removed and readers find it as the highest
   *    missing sequence. On a store without `truncatePrefixKeeping`, `c` stops below the
   *    first kept event instead — a shorter compaction, never a lost event. With a `pinned`
   *    predicate but no `pinnedEventTypes`, a pinned execution is not compacted at all: the
   *    kernel cannot tell which of its events carry the pin.
   *
   * Returns the sequence compacted through, or `null` when the store can't truncate (no
   * `truncatePrefix`), there is nothing to compact, or the execution is pinned as above.
   * Throws {@link UnsafeCompactionError} when the event store encrypts at rest and the
   * snapshot store does not share its KeyStore.
   */
  async compact(executionId: string): Promise<number | null> {
    const store = this.eventStore;
    if (store.truncatePrefix === undefined) return null;
    // ADR 0022 Amendment — checked before anything is read, saved or truncated.
    const eventKeys = keysOf(store);
    if (eventKeys !== undefined && keysOf(this.snapshotStore) !== eventKeys) {
      throw new UnsafeCompactionError(executionId);
    }
    const events = await store.read(executionId);
    if (events.length <= 1) return null; // nothing beyond the bootstrap to reclaim
    const keep = this.keep;
    if (keep.size === 0 && this.options.pinned !== undefined) {
      if ((await this.options.pinned(executionId)) === true) return null;
    }

    // The checkpoint sequence: the highest non-kept event. Its own slot is then removed, which
    // is what lets every reader find the checkpoint as the log's highest missing sequence.
    let at = events.length - 1;
    while (at > 0 && keep.has(events[at]!.eventType)) at--;
    if (at === 0) return null; // only kept events after the bootstrap
    let through = events[at]!.sequence;
    const canKeep = store.truncatePrefixKeeping !== undefined;
    let keptBelow = false;
    for (let i = 1; i < at; i++) {
      if (!keep.has(events[i]!.eventType)) continue;
      if (canKeep) {
        keptBelow = true;
        break;
      }
      // No atomic keep-in-place: stop below the first kept event. Its predecessor slot is
      // either a non-kept event (truncated now) or already missing — a valid checkpoint slot.
      through = events[i]!.sequence - 1;
      at = i - 1;
      break;
    }

    if (through <= 0) return null;

    // The fold at `through`. A gapped log was compacted before: fold ON the checkpoint that
    // holds the gap, never from the surviving events alone.
    const gap = highestMissing(events);
    // Every event above the checkpoint survives and the checkpoint's own slot does not, so
    // the checkpoint of a gapped log sits exactly at `gap`: at or below it, nothing is new.
    if (gap >= 0 && through <= gap) return null;
    let state: ExecutionState;
    let identity: { executionId: string; workflowId: string; workflowVersion: string };
    if (gap >= 0) {
      const base = await this.snapshotStore.loadLatestBefore(executionId, through);
      if (base === null || base.sequence < gap) {
        throw new CompactionCheckpointMissingError(executionId, gap);
      }
      // `base` may sit AT `through` (the runtime checkpoints every suspend at its tip): the
      // fold is then already there, and the truncation below is the whole of the work.
      identity = {
        executionId,
        workflowId: events[0]!.workflowId,
        workflowVersion: base.state.workflowVersion,
      };
      const tail = events.filter((e) => e.sequence > base.sequence && e.sequence <= through);
      state = new ReplayVM(tail, { ...normalizeSnapshotState(base.state), ...identity }).getState();
    } else {
      // Never compacted: the log IS the history. The version is not an event fact; a
      // snapshot the runtime took (at a suspend, or on its cadence) is where it is recorded.
      const latest = await this.snapshotStore.loadLatest(executionId);
      identity = {
        executionId,
        workflowId: events[0]!.workflowId,
        workflowVersion: latest?.state.workflowVersion ?? "",
      };
      state = new ReplayVM(events.slice(0, at + 1), identity).getState();
    }

    const snapshot: Snapshot = {
      id: ulid(),
      executionId,
      workflowId: identity.workflowId,
      sequence: through,
      state,
      createdAt: 0, // deterministic; the sequence, not the wall clock, is load-bearing
    };
    // MUST persist the checkpoint before truncating — the snapshot is what the
    // suffix folds onto; truncating first would lose the prefix irrecoverably.
    await this.snapshotStore.save(snapshot);
    if (keptBelow) {
      await store.truncatePrefixKeeping!(executionId, through, [...keep]);
    } else {
      await store.truncatePrefix(executionId, through);
    }
    return through;
  }
}
