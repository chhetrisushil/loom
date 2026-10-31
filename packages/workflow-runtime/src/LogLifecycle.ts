import type { EventEnvelope, ExecutionState } from "@loom/core";
import {
  ARCHIVE_LEGACY_CHECKPOINT_EVENT,
  ArchiveIncarnationError,
  type ArchiveSegmentHeader,
  type ArchiveStore,
  type BranchRegistry,
  type EventStore,
  INBOX_STREAM_PREFIX,
  INBOX_TOPIC_SEQ_BASE,
  StaleFenceError,
  archivedReservedStreams,
  assertReservedSegmentDigest,
  assertSegmentDigest,
  buildSegment,
  chainIdOfFirst,
  headOf,
  isReservedStream,
  readRangeOf,
  reservedLateKey,
  reservedLateOrigin,
  segmentDigest,
} from "@loom/event-runtime";
import { appendBatchOf } from "@loom/event-runtime";
import { ReplayVM, knownEventTypes, normalizeSnapshotState } from "@loom/replay-vm";
import {
  COMPACTION_CHECKPOINT_ID_PREFIX,
  type Snapshot,
  type SnapshotStore,
  assertSnapshotIdentity,
  isArchivingCompactionCheckpointId,
} from "@loom/snapshot-runtime";
import { ulid } from "ulid";
import { ReservedStreamArchive, appendMoved, reservedIncarnationOf } from "./archiveMove";
import {
  type BlankStreamCensus,
  type BlankStreamSegment,
  type RehomeAssignment,
  planBlankStreamRepair,
  rehomedEnvelope,
} from "./blankStream";
import {
  ArchiveGapError,
  ArchiveIncompleteError,
  ArchiveLogMismatchError,
  ArchiveTenantMismatchError,
  CompactionArchiveRequiredError,
  PlaintextArchiveError,
  PlaintextCheckpointError,
  type UnarchivedRange,
  plaintextArchiveReason,
  plaintextCheckpointReason,
  tenantScopeOf,
} from "./checkpointGuard";
import { chainIdOf, deleteInbox } from "./inbox";
import { EFFECT_INDOUBT_RESOLVED, EXECUTION_RECOVERED } from "./types";
import { isWriteConflict } from "./writeConflict";

const RESTORABLE_TERMINAL: Record<string, string> = {
  completed: "EXECUTION_COMPLETED",
  failed: "EXECUTION_FAILED",
  cancelled: "EXECUTION_CANCELLED",
};

/** A per-topic inbox stream (`__loom_inbox__:<chain>#<16 hex>`): its sequences start at INBOX_TOPIC_SEQ_BASE. */
function isInboxTopicStreamId(streamId: string): boolean {
  return streamId.startsWith(INBOX_STREAM_PREFIX) && /#[0-9a-f]{16}$/.test(streamId);
}

/** What {@link LogLifecycle.restoreTerminalEvent} did (or, dry, would do) for one execution. */
export type RestoreTerminalResult =
  | {
      executionId: string;
      status: "restored" | "would-restore";
      sequence: number;
      eventType: string;
    }
  | { executionId: string; status: "intact" | "missing" | "not-an-execution" }
  | { executionId: string; status: "not-terminal"; foldedStatus: string }
  /** Nothing written: the execution is not quiescent (a holder, a writer, a racing repair). Retry later. */
  | { executionId: string; status: "busy"; reason: string };

const isStaleFence = (err: unknown): boolean =>
  err instanceof StaleFenceError || (err as { name?: unknown } | null)?.name === "StaleFenceError";

/** Reserved control stream carrying retention facts (EXECUTION_ARCHIVED/_DELETED). */
export const LIFECYCLE_STREAM = "__loom_lifecycle__";

// ── K10.1 / K10.4 — log lifecycle: retention & compaction ─────────────────────
//
// A kernel reclaims resources. Retention removes terminal executions after their
// window elapses; compaction bounds a long-lived execution's replay tail. Both
// preserve the fold: retention only removes ELIGIBLE (terminal, aged, archived)
// executions, and compaction guarantees `fold(snapshot, suffix) === fold(events)`
// so a compacted execution still resumes/replays identically.

/**
 * ADR 0116 — when an execution ended: the timestamp of its newest terminal event, found by
 * scanning the tail backwards (a late outcome sits after it). Compaction never removes a terminal
 * execution's terminal event (it stops just below it, ADR 0116 amendment), so the fallback to
 * `max(last event, folded updatedAt)` serves only a log compacted by an older version.
 */
function terminalEndedAt(events: readonly EventEnvelope[], state: ExecutionState): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as EventEnvelope;
    if (
      e.eventType === "EXECUTION_COMPLETED" ||
      e.eventType === "EXECUTION_FAILED" ||
      e.eventType === "EXECUTION_CANCELLED" ||
      (e.eventType === "EXECUTION_CONTINUED" && e.metadata?.kernel === true)
    ) {
      return e.timestamp;
    }
  }
  return Math.max(events[events.length - 1]!.timestamp, state.updatedAt);
}

/** Index of the newest terminal event of `events`, or -1 (see {@link terminalEndedAt}). */
function lastTerminalIndex(events: readonly EventEnvelope[]): number {
  for (let i = events.length - 1; i >= 1; i--) {
    const e = events[i] as EventEnvelope;
    if (
      e.eventType === "EXECUTION_COMPLETED" ||
      e.eventType === "EXECUTION_FAILED" ||
      e.eventType === "EXECUTION_CANCELLED" ||
      (e.eventType === "EXECUTION_CONTINUED" && e.metadata?.kernel === true)
    ) {
      return i;
    }
  }
  return -1;
}

const TERMINAL = new Set<ExecutionState["status"]>([
  "completed",
  "failed",
  "cancelled",
  "continued", // ADR 0109: terminal for retention; the successor's sequence 0 is durable first
]);

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

/** Options of {@link LogLifecycle.pruneSnapshots}. */
export interface PruneSnapshotsOptions {
  /** Newest snapshots to keep (integer >= 1, default 1). */
  keepLatest?: number;
  /** Extra snapshot sequences to keep. */
  keepSequences?: readonly number[];
  /**
   * ADR 0134 D6 - proceed when the ONLY thing blocking is unattributed runs in the pre-0106 blank
   * stream (events nobody can prove the owner of, so no repair will ever settle them). Default
   * false. A re-homable segment always refuses, with or without this.
   */
  acceptUnattributedBlankStream?: boolean;
}

/**
 * ADR 0134 D6 - `pruneSnapshots` refused because the pre-0106 blank stream (execution `""`) still
 * holds events `loom repair blank-stream` (ADR 0107) has not re-homed. The snapshots a pruning
 * would delete include the blank-identity ones that are the PROOF of whose those events are.
 * Nothing was deleted.
 */
export class BlankStreamUnrepairedError extends Error {
  constructor(
    readonly rehomable: number,
    readonly unattributed: number
  ) {
    super(
      `refusing to prune snapshots: the blank execution "" still holds events the pre-0106 compaction bug misfiled (${rehomable} segment(s) re-homable, ${unattributed} unattributed run(s)), and blank-identity snapshots are the proof of whose they are. Finish the repair first (\`loom repair blank-stream\`, ADR 0107). Nothing was deleted.`
    );
    this.name = "BlankStreamUnrepairedError";
  }
}

/**
 * ADR 0134 D6 - `pruneSnapshots` could not decide whether the pre-0106 blank stream is repaired:
 * the store holds one, and the census that settles it enumerates every execution, which this event
 * store cannot (it implements neither `listExecutions` nor `listExecutionsPage`). A refusal, never
 * a delete: nothing was deleted.
 */
export class BlankStreamCensusUnavailableError extends Error {
  constructor(readonly missing: readonly string[] = ["listExecutions", "listExecutionsPage"]) {
    super(
      `refusing to prune snapshots: the blank execution "" holds events, and deciding whether they are repaired needs the event store to enumerate executions, but it implements neither ${missing.join(" nor ")}. Nothing was deleted.`
    );
    this.name = "BlankStreamCensusUnavailableError";
  }
}

/**
 * The highest sequence missing BELOW the log's tip, or -1 when the log is contiguous from 0.
 * Compaction is the only thing that removes events; it always removes its own checkpoint's
 * slot and never the tip unless nothing is kept (the TIP RULE, ADR 0106), so this is exactly
 * the latest checkpoint's sequence — or, for a log compacted down to `[0]`, -1 with the
 * checkpoint above the tip. One backward pass; stops at the first gap from the top.
 */
export function highestMissing(events: readonly EventEnvelope[]): number {
  for (let i = events.length - 1; i > 0; i--) {
    const at = events[i]!.sequence;
    if (at - events[i - 1]!.sequence > 1) return at - 1;
  }
  return events.length > 0 && events[0]!.sequence !== 0 ? events[0]!.sequence - 1 : -1;
}

/** The lowest sequence in `[1..]` the log does not hold below its highest present one, or -1 when it has no gap. */
export function lowestMissing(events: readonly EventEnvelope[]): number {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.sequence - events[i - 1]!.sequence > 1) return events[i - 1]!.sequence + 1;
  }
  return events.length > 0 && events[0]!.sequence !== 0 ? 1 : -1;
}

type Range = readonly [number, number];

/** `r` minus the ranges of `segs` (inclusive bounds), ascending. */
function subtractRanges(
  r: Range,
  segs: readonly { from: number; through: number }[]
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let lo = r[0];
  for (const s of segs) {
    if (s.through < lo || s.from > r[1]) continue;
    if (s.from > lo) out.push([lo, s.from - 1]);
    lo = Math.max(lo, s.through + 1);
    if (lo > r[1]) break;
  }
  if (lo <= r[1]) out.push([lo, r[1]]);
  return out;
}

/** The parts of `r` that lie inside the ranges of `segs`, ascending. */
function intersectRanges(
  r: Range,
  segs: readonly { from: number; through: number }[]
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const s of segs) {
    const a = Math.max(r[0], s.from);
    const b = Math.min(r[1], s.through);
    if (a <= b) out.push([a, b]);
  }
  return out;
}

/** Archived ∪ surviving log, one entry per sequence, duplicates compared byte-exact (ADR 0138 M2). */
export function stitchArchived(
  executionId: string,
  archived: readonly EventEnvelope[],
  live: readonly EventEnvelope[]
): EventEnvelope[] {
  const bySeq = new Map<number, EventEnvelope>();
  for (const e of archived) bySeq.set(e.sequence, e);
  const differing: number[] = [];
  for (const e of live) {
    const a = bySeq.get(e.sequence);
    if (a !== undefined && segmentDigest([a]) !== segmentDigest([e])) differing.push(e.sequence);
    bySeq.set(e.sequence, e);
  }
  if (differing.length > 0) throw new ArchiveLogMismatchError(executionId, differing);
  return [...bySeq.values()].sort((a, b) => a.sequence - b.sequence);
}

/** Appends of one lifecycle fact before a write conflict is reported rather than retried. */
const LIFECYCLE_FACT_ATTEMPTS = 5;

/** How many executions a {@link LogLifecycle} remembers having warned about. */
const WARNED_MEMORY = 10_000;

/**
 * Every event kind the kernel writes: the fold's own kinds plus the resume signals the
 * runtime records itself (crash re-drive, in-doubt verdict). None may be kept below a
 * checkpoint: kernel log readers assume no kernel fact survives there.
 */
const KERNEL_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...knownEventTypes(),
  EXECUTION_RECOVERED,
  EFFECT_INDOUBT_RESOLVED,
]);

/**
 * ADR 0106 — validate `pinnedEventTypes`: non-empty strings, no kernel kinds. Exported for
 * `defineConfig`, which runs it at config time so a bad list fails at boot, not at the first
 * compaction pass.
 */
export function assertPinnedEventTypes(types: readonly unknown[]): asserts types is string[] {
  const bad = types.filter((t) => typeof t !== "string" || t.length === 0);
  if (bad.length > 0) {
    throw new TypeError(
      `pinnedEventTypes must be non-empty strings; got ${bad.map((t) => JSON.stringify(t) ?? String(t)).join(", ")}. A non-string would match nothing on SQL stores but still be compared in memory, so backends would disagree about what compaction keeps.`
    );
  }
  const kernel = (types as string[]).filter((t) => KERNEL_EVENT_TYPES.has(t));
  if (kernel.length > 0) {
    throw new TypeError(
      `pinnedEventTypes names kernel event kind(s) ${kernel.join(", ")} — compaction keeps app evidence events, not kernel facts (the checkpoint already carries their fold). To keep an execution's whole log uncompacted, leave pinnedEventTypes empty and pin the execution (\`pinned\`): the predicate is consulted only when no kinds are declared.`
    );
  }
}

export class LogLifecycle {
  /** The archive's snapshot store, if any: what `loom doctor` reads to judge it (ADR 0130 D8). */
  get archiveSnapshotStore(): SnapshotStore | undefined {
    return this.options.archive?.snapshotStore;
  }

  constructor(
    private readonly eventStore: EventStore,
    private readonly snapshotStore: SnapshotStore,
    private readonly options: {
      archive?: ArchiveStores;
      /**
       * ADR 0138 — where {@link compact} MOVES the events it removes. REQUIRED for compaction:
       * without one, `compact` throws {@link CompactionArchiveRequiredError} and changes nothing.
       * Distinct from `archive` (the retention copy of a WHOLE execution before deletion).
       */
      compactionArchive?: ArchiveStore;
      /**
       * ADR 0138 H3 - the tenant this lifecycle serves. When set, {@link compact} requires the event
       * store AND the compaction archive to both report exactly this `tenantScope`, and REFUSES
       * (ArchiveTenantMismatchError) when either does not - including a store stack whose scope cannot
       * be seen (a custom decorator that hides its inner store without forwarding the marker). Unset,
       * the two stores' markers are only compared with each other, so set it for every multi-tenant
       * deployment: it is the one check that does not depend on every layer forwarding a marker.
       */
      tenant?: string;
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
      /**
       * ADR 0106 — executions whose WHOLE log must stay uncompacted (a legal hold by tag, an
       * audit freeze): `compact` returns `null` for them, always. Distinct from `pinned`, which
       * governs retention and consults compaction only when no `pinnedEventTypes` are declared.
       */
      compactionExempt?: PinPredicate;
      /**
       * Where compaction reports a degraded pass — today, a store without
       * `truncatePrefixKeeping` that therefore cannot compact past a kept event (ADR 0106 D3).
       * Once per execution per `LogLifecycle` instance. Default: `console.warn`.
       */
      onWarn?: (message: string) => void;
      /**
       * ADR 0130 D8 - the same escape hatch as `WorkflowRuntime`'s: accept an ARCHIVE snapshot store
       * that does not seal the whole state under the event store's KeyStore. Off by default.
       */
      allowPlaintextCheckpoints?: boolean;
    } = {}
  ) {
    assertPinnedEventTypes(options.pinnedEventTypes ?? []);
    this.keep = new Set(options.pinnedEventTypes);
  }

  /** {@link LogLifecycle} options' `pinnedEventTypes`, as a set. */
  private readonly keep: ReadonlySet<string>;

  /**
   * ADR 0134 D6 - the tail of each execution's `compact`/`pruneSnapshots` chain. An
   * entry exists only while an operation is queued or running and is removed when the chain
   * drains, so the map is bounded by the executions in flight.
   */
  private readonly exclusive = new Map<string, Promise<void>>();

  /**
   * ADR 0134 D6 - the last blank-stream verdict with NO re-homable segment, keyed by the head
   * sequence of `""` it was taken at: `unattributed` runs then. A refusal for a re-homable segment
   * is never stored. Cleared by `rehomeBlankStream`. One entry per instance.
   */
  private blankVerdict: { head: number; unattributed: number } | null = null;

  private withExecution<T>(executionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.exclusive.get(executionId) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.exclusive.set(executionId, tail);
    void tail.then(() => {
      if (this.exclusive.get(executionId) === tail) this.exclusive.delete(executionId);
    });
    return run;
  }

  /** Executions already warned about (bounded, FIFO) — a sweep warns once per execution. */
  private readonly warned = new Set<string>();

  private warnOnce(executionId: string, message: string): void {
    if (this.warned.has(executionId)) return;
    if (this.warned.size >= WARNED_MEMORY) {
      const oldest = this.warned.values().next().value;
      if (oldest !== undefined) this.warned.delete(oldest);
    }
    this.warned.add(executionId);
    (this.options.onWarn ?? ((m: string) => console.warn(`[loom] ${m}`)))(message);
  }

  /** The compaction archive (ADR 0138), if one is configured. Read-only. */
  get compactionArchive(): ArchiveStore | undefined {
    return this.options.compactionArchive;
  }

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

  /**
   * Journal a retention control fact to the dedicated lifecycle stream (P9: audit its own
   * pruning). `read().length` is the next sequence only because a reserved stream is never
   * compacted — {@link compact} refuses one (ADR 0106).
   */
  private async emitLifecycleFact(
    eventType: "EXECUTION_ARCHIVED" | "EXECUTION_DELETED" | "EVENTS_REHOMED",
    executionId: string,
    now: number,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    // Two lifecycle writers (a retention sweep beside a repair, say) can read the same length.
    // The loser's append is a write conflict and nothing was written, so re-read and retry.
    // One imprecision, accepted: a `CoalescingEventStore` over a store without `appendBatch`
    // can hand a caller the conflict of a batch its own fact was part of AND landed in, so the
    // retry may journal that fact twice. A duplicated audit fact is harmless; a lost one is not.
    for (let attempt = 1; ; attempt++) {
      const prior = await this.eventStore.read(LIFECYCLE_STREAM);
      const fact: EventEnvelope = {
        id: ulid(),
        workflowId: LIFECYCLE_STREAM,
        executionId: LIFECYCLE_STREAM,
        eventType,
        sequence: prior.length,
        timestamp: now,
        payload: { executionId, ...detail },
      };
      try {
        await this.eventStore.append(fact);
        return;
      } catch (err) {
        if (attempt >= LIFECYCLE_FACT_ATTEMPTS || !isWriteConflict(err)) throw err;
      }
    }
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
    // ADR 0116 — the clock runs from the newest TERMINAL event, not the last event: a late
    // outcome (or an audit row) appended days after the end must not postpone reclamation.
    const endedAt = terminalEndedAt(events, state);
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
   * Fold what retention judges eligibility on. A contiguous log `[0..n]` with n > 0 IS the
   * whole history: under the tip rule (ADR 0106) compaction always leaves a gap below the tip
   * it keeps, so a gap-free log was never compacted. A gapped log — or only the bootstrap
   * left, which is what compacting through the tip leaves — keeps its prefix in the
   * checkpoint: folding the surviving suffix alone reads a completed execution as
   * not-terminal forever, so a compacted execution could never be reclaimed. One snapshot
   * point-read, only then.
   */
  private async foldForRetention(
    executionId: string,
    events: EventEnvelope[]
  ): Promise<ExecutionState> {
    const last = events[events.length - 1]!;
    if (events.length > 1 && last.sequence === events.length - 1) {
      return new ReplayVM(events).getState();
    }
    const snapshot = await this.snapshotStore.loadLatest(executionId);
    if (snapshot === null) return new ReplayVM(events).getState();
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
      // ADR 0130 D8 - a static-path archive store on the same keys still receives the plaintext
      // `_waitAnswers`: when the source seals, the archive snapshot store must seal the WHOLE state.
      if (
        this.options.allowPlaintextCheckpoints !== true &&
        plaintextCheckpointReason(this.eventStore, archive.snapshotStore) !== undefined
      ) {
        return false;
      }
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
    const headState = await this.foldForRetention(executionId, events);

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
    // ADR 0138 - the compaction segments go with the execution only on the plain-delete path. With a
    // retention archive configured the execution is being KEPT (copied there), and its compacted
    // history is part of it: leave the segments, so `readArchived` still answers. They go FIRST: the
    // log is what makes the execution findable by a retry, so a crash after this line is finished by
    // the next sweep, whereas deleting the log first could leave segments no sweep ever revisits for
    // a reused id to meet (a segment also carries its log's incarnation, so a reused id refuses them).
    // ADR 0139 - the same for the chain's reserved streams (inbox envelopes a trim moved there).
    const chainId = chainIdOf(headState, executionId);
    if (this.options.archive === undefined) {
      await this.options.compactionArchive?.deleteExecution?.(executionId);
      if (headState.status !== "continued" && this.options.compactionArchive !== undefined) {
        const archive = this.options.compactionArchive;
        const streams = await archivedReservedStreams(archive, chainId);
        for (const stream of streams) await archive.deleteExecution?.(stream);
      }
    }
    await deleteExecution.call(this.eventStore, executionId);
    // ADR 0110 D1 — the inbox stream is deleted WITH its chain: this execution is the chain's
    // head (a continued predecessor is never retained past its successor), so nothing can read
    // `__loom_inbox__:<chainId>` any more. Idempotent; a store without the stream is a no-op.
    if (headState.status !== "continued") {
      // A retention archive means the execution is KEPT: the chain's reserved streams MOVE to the
      // compaction archive when there is one. A plain delete is the explicit whole-execution delete
      // (the user asked for it): nothing is archived, and the archived segments went above.
      await deleteInbox(
        this.eventStore,
        chainId,
        false,
        this.options.archive !== undefined && this.options.compactionArchive !== undefined
          ? new ReservedStreamArchive(
              this.options.compactionArchive,
              this.eventStore,
              this.options.tenant
            )
          : "discard"
      );
    }
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
   * ADR 0107 — what the pre-0106 compaction bug left in the blank execution `""`: which of
   * its events are provably whose (a snapshot the same run saved under the real id folds
   * them), which an operator assignment covers, which are already re-homed, and which nobody
   * can attribute. Reads only. See `planBlankStreamRepair` for the proof.
   */
  async blankStreamCensus(
    opts: { assign?: readonly RehomeAssignment[] } = {}
  ): Promise<BlankStreamCensus> {
    return (await planBlankStreamRepair(this.eventStore, this.snapshotStore, opts.assign)).census;
  }

  /**
   * ADR 0107 — re-home the blank stream's provable events (and any `assign`ed range that folds
   * onto its execution) into the execution they belong to, at the sequences they were written
   * at. A DRY RUN unless `apply: true`: without it this is {@link blankStreamCensus}.
   *
   * Per execution, ONE batch (`appendBatchOf`) carries every slot its segments still lack, so a
   * crash never leaves half of an execution re-homed. Each event is re-stamped with that
   * execution's identity, `id` `<executionId>-<sequence>` and `metadata.rehomedFrom` (its
   * blank-stream id). Before writing, the execution's tip is re-read and must equal what the
   * census saw, and its sequence 0 must exist; anything else refuses that execution. A fenced
   * execution (a worker, a fenced `TimerService`, `recoverAbandoned({ fenced })` or `cancel`
   * ever fenced it) refuses an unfenced append: the repair then takes a NEW fence and writes
   * under it, which also fences out any runner still holding the old one. An execution that
   * was never fenced is not given a fence, because every later unfenced write to it would then
   * be refused.
   *
   * Then every re-homed segment gets its `EVENTS_REHOMED` fact on the lifecycle stream,
   * including a segment an earlier run re-homed whose fact never landed. One failing execution
   * is reported in `failed` and does not stop the others. The blank stream itself is left as it
   * is: append-only evidence, and what makes a re-run idempotent.
   *
   * Refuses to apply (nothing written) when the stray events still carry ciphertext: the store
   * is the raw one under an encrypting store, and would copy ciphertext under the wrong key.
   * Run it with the affected executions quiesced and retention/compaction paused.
   */
  async rehomeBlankStream(
    opts: { assign?: readonly RehomeAssignment[]; apply?: boolean; now?: number } = {}
  ): Promise<
    BlankStreamCensus & {
      rehomed: BlankStreamSegment[];
      failed: Array<{ executionId: string; error: string }>;
    }
  > {
    if (opts.apply === true) this.blankVerdict = null; // a repair run changes what the census says
    const plan = await planBlankStreamRepair(this.eventStore, this.snapshotStore, opts.assign);
    const rehomed: BlankStreamSegment[] = [];
    const failed: Array<{ executionId: string; error: string }> = [];
    if (opts.apply !== true) return { ...plan.census, rehomed, failed };
    if (plan.census.shredded) {
      throw new TypeError(
        'rehomeBlankStream: the events in execution "" carry { $shredded: true } placeholders — the key they were encrypted under is gone, so their payloads are unrecoverable. Re-homing would write placeholders into an execution\'s history as if they were its events. Nothing was written.'
      );
    }
    if (plan.census.ciphertext) {
      throw new TypeError(
        'rehomeBlankStream: the events in execution "" still carry ciphertext as this store reads them. It is the raw store under an encrypting one, and re-homing through it would copy ciphertext under the wrong key. Run the repair through the app\'s own stores (`loom repair blank-stream --config <module>`).'
      );
    }
    const now = opts.now ?? Date.now();
    const byExecution = new Map<string, BlankStreamSegment[]>();
    for (const seg of plan.missing.keys()) {
      const list = byExecution.get(seg.executionId);
      if (list === undefined) byExecution.set(seg.executionId, [seg]);
      else list.push(seg);
    }
    for (const [id, segs] of byExecution) {
      try {
        await this.rehomeExecution(id, segs, plan);
        for (const seg of segs) {
          seg.status = "rehomed";
          rehomed.push(seg);
        }
      } catch (err) {
        failed.push({ executionId: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    // The facts, after the events: a segment re-homed now, or by an earlier run whose fact
    // never landed. One read of the lifecycle stream says which exist.
    const journaled = new Set<string>();
    for (const f of await this.eventStore.read(LIFECYCLE_STREAM)) {
      if (f.eventType !== "EVENTS_REHOMED") continue;
      const p = f.payload as { executionId: string; fromSequence: number; throughSequence: number };
      journaled.add(`${p.executionId}\u0000${p.fromSequence}\u0000${p.throughSequence}`);
    }
    for (const seg of plan.census.segments) {
      if (seg.status !== "rehomed") continue;
      const key = `${seg.executionId}\u0000${seg.fromSequence}\u0000${seg.throughSequence}`;
      if (journaled.has(key)) continue;
      try {
        await this.emitLifecycleFact("EVENTS_REHOMED", seg.executionId, now, {
          fromSequence: seg.fromSequence,
          throughSequence: seg.throughSequence,
          proof: seg.proof,
          count: seg.throughSequence - seg.fromSequence + 1,
        });
        journaled.add(key);
      } catch (err) {
        failed.push({
          executionId: seg.executionId,
          error: `re-homed ${seg.fromSequence}..${seg.throughSequence}, but its EVENTS_REHOMED fact did not land (a re-run writes it): ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return { ...plan.census, rehomed, failed };
  }

  /** One execution's missing slots, in one batch, fenced if the execution is. */
  private async rehomeExecution(
    id: string,
    segs: readonly BlankStreamSegment[],
    plan: Awaited<ReturnType<typeof planBlankStreamRepair>>
  ): Promise<void> {
    const planned = plan.tipOf.get(id);
    const tip = await headOf(this.eventStore, id);
    const anchor = await readRangeOf(this.eventStore, id, 0, 0);
    if (anchor.length === 0 || tip !== planned) {
      throw new Error(
        `${id} changed since the census (tip ${planned} then, ${tip ?? "none"} now${anchor.length === 0 ? ", no sequence 0" : ""}) — re-run the census with it quiesced`
      );
    }
    const workflowId = plan.workflowIdOf.get(id)!;
    const sequences = segs.flatMap((seg) => plan.missing.get(seg) ?? []).sort((a, b) => a - b);
    const batch = (fence?: number) =>
      sequences.map((q) => rehomedEnvelope(plan.stray.get(q)!, id, workflowId, fence));
    try {
      await appendBatchOf(this.eventStore, batch());
    } catch (err) {
      const fenced =
        err instanceof StaleFenceError ||
        (err as { name?: unknown } | null)?.name === "StaleFenceError";
      if (!fenced || this.eventStore.acquireFence === undefined) throw err;
      await appendBatchOf(this.eventStore, batch(await this.eventStore.acquireFence(id)));
    }
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
   *    0 names both); `workflowVersion`, which no event records, from the snapshots the
   *    runtime took. A blank identity made every event a resume appended land in execution
   *    `""`.
   *  - **The earlier prefix.** The fold starts from the latest snapshot at or below `c` when
   *    there is one, never from the surviving events alone of a compacted log. A gapped log
   *    with no snapshot at or above its gap throws {@link CompactionCheckpointMissingError},
   *    touching nothing.
   *  - **Pinned kinds (ADR 0055 D1).** Events of `pinnedEventTypes` stay in place
   *    (`truncatePrefixKeeping`). THE TIP RULE: when any kept event would survive, `c` is the
   *    highest non-kept sequence strictly BELOW the tip, so the tip is never removed, `c`'s
   *    own slot always is, and every reader finds the checkpoint as the highest missing
   *    sequence — a gap-free log was never compacted. With nothing kept, `c` is the tip (the
   *    log becomes `[0]`, checkpoint above it), as before. On a store without
   *    `truncatePrefixKeeping`, `c` stops below the FIRST kept event, forever: such a log is
   *    never compacted past its first finding, and `onWarn` says so (once per execution).
   *  - **The `pinned` predicate** is consulted ONLY when `pinnedEventTypes` is empty: then the
   *    kernel cannot tell which of a pinned execution's events carry the pin, so it leaves
   *    that execution uncompacted. With `pinnedEventTypes` declared, the kept kinds ARE the
   *    pin, and a pinned execution compacts around them — the documented sentinel setup pins
   *    by the very kinds it keeps (`pinByEventKinds(FINDING_RECORDED)` beside
   *    `pinnedEventTypes: [FINDING_RECORDED]`), and honouring the predicate there would stop
   *    it compacting after its first finding.
   *  - **`compactionExempt`** is consulted always: an execution it names keeps its whole log
   *    (a legal hold by tag, which no event kind expresses).
   *  - **Reserved control streams** (`__loom_*`) are refused: their writers allocate sequences
   *    from `read().length`, which only holds for a log that is never compacted.
   *
   * Returns the sequence compacted through, or `null` when the store can't truncate (no
   * `truncatePrefix`), there is nothing to compact, or the execution is pinned (as above). Throws
   * {@link UnsafeCompactionError} when the event store encrypts at rest and the snapshot
   * store does not share its KeyStore, and {@link PlaintextCheckpointError} (ADR 0130 D8) when it
   * shares the KeyStore but does not seal the WHOLE state (unless `allowPlaintextCheckpoints`).
   */
  compact(executionId: string): Promise<number | null> {
    // ADR 0134 D6 - serialized with `pruneSnapshots` on the same execution (within this instance).
    return this.withExecution(executionId, () => this.compactOnce(executionId));
  }

  private async compactOnce(executionId: string): Promise<number | null> {
    if (executionId === "") {
      throw new TypeError(
        `refusing to compact "": a blank id names no execution. Its stream holds what the pre-0106 compaction bug misfiled — census and repair it with LogLifecycle.blankStreamCensus / rehomeBlankStream (ADR 0107); compacting it would fold unrelated executions together and delete the evidence.`
      );
    }
    if (isReservedStream(executionId)) {
      throw new TypeError(
        `refusing to compact "${executionId}": a reserved control stream is an append-only audit trail whose writers take their next sequence from read().length — compacting it would make them overwrite its own freed slots.`
      );
    }
    const store = this.eventStore;
    if (store.truncatePrefix === undefined) return null;
    // ADR 0022 Amendment — checked before anything is read, saved or truncated.
    const eventKeys = keysOf(store);
    if (eventKeys !== undefined && keysOf(this.snapshotStore) !== eventKeys) {
      throw new UnsafeCompactionError(executionId);
    }
    // ADR 0130 D8 - the shared KeyStore is necessary but not sufficient: a static-path snapshot
    // store on the same keys still writes the dynamic `_waitAnswers` in the clear. Typed refusal,
    // before anything is read, saved or truncated.
    if (this.options.allowPlaintextCheckpoints !== true) {
      const reason = plaintextCheckpointReason(store, this.snapshotStore);
      if (reason !== undefined) throw new PlaintextCheckpointError(reason, executionId);
    }
    // ADR 0138 — compaction MOVES events, so it needs somewhere to move them, inside the log's
    // erasure boundary. Refused before anything is read, archived, saved or truncated.
    const archive = this.options.compactionArchive;
    if (archive === undefined) throw new CompactionArchiveRequiredError(executionId);
    const archiveReason = plaintextArchiveReason(store, archive);
    if (archiveReason !== undefined) throw new PlaintextArchiveError(archiveReason, executionId);
    // ADR 0138 H3 - a tenant-scoped log needs an archive scoped to the SAME tenant.
    const eventTenant = tenantScopeOf(store);
    const archiveTenant = tenantScopeOf(archive);
    const declaredTenant = this.options.tenant;
    if (
      eventTenant !== archiveTenant ||
      (declaredTenant !== undefined && eventTenant !== declaredTenant)
    ) {
      throw new ArchiveTenantMismatchError(executionId, eventTenant, archiveTenant, declaredTenant);
    }
    const events = await store.read(executionId);
    if (events.length <= 1) return null; // nothing beyond the bootstrap to reclaim
    // The incarnation of THIS log: a digest of the bootstrap event, which every compaction keeps.
    const incarnation = segmentDigest([events[0]!]);
    if (
      this.options.compactionExempt !== undefined &&
      (await this.options.compactionExempt(executionId)) === true
    ) {
      return null;
    }
    const keep = this.keep;
    if (
      keep.size === 0 &&
      this.options.pinned !== undefined &&
      (await this.options.pinned(executionId)) === true
    ) {
      return null;
    }

    // Choose the checkpoint slot `at` (an index into `events`) under the tip rule.
    const tipIndex = events.length - 1;
    let firstKept = -1;
    for (let i = 1; i <= tipIndex; i++) {
      if (keep.has(events[i]!.eventType)) {
        firstKept = i;
        break;
      }
    }
    let at = tipIndex;
    if (firstKept !== -1) {
      at = tipIndex - 1;
      while (at > 0 && keep.has(events[at]!.eventType)) at--;
    }
    // ADR 0116 amendment (Q3) — a terminal execution's terminal event is never compacted away: the
    // checkpoint stops just below it, so retention always finds when the execution ended on the
    // log itself and a late outcome (whose handler moves `updatedAt`) cannot pin a compacted log.
    const terminalAt = lastTerminalIndex(events);
    if (terminalAt !== -1 && at >= terminalAt) {
      at = terminalAt - 1;
      while (at > 0 && keep.has(events[at]!.eventType)) at--;
    }
    let keptBelow = firstKept !== -1 && firstKept < at;
    if (keptBelow && store.truncatePrefixKeeping === undefined) {
      // No atomic keep-in-place: stop below the first kept event. Its predecessor is a
      // non-kept event (removed now) or the bootstrap (nothing to do).
      at = firstKept - 1;
      keptBelow = false;
      this.warnOnce(
        executionId,
        `compact("${executionId}"): the event store has no truncatePrefixKeeping (EventStore SPI 1.5.0), so compaction cannot pass the pinned ${events[firstKept]!.eventType} event at sequence ${events[firstKept]!.sequence} — this log will never be compacted past it and its replay tail grows without bound. Use a store that implements truncatePrefixKeeping.`
      );
    }
    if (at <= 0) return null;
    const through = events[at]!.sequence;

    // Every event above the checkpoint survives and its own slot does not, so a gapped log's
    // checkpoint sits at its gap or above it: at or below the gap, nothing is new.
    const gap = highestMissing(events);
    if (gap >= 0 && through <= gap) return null;

    // The events this compaction removes (truncatePrefixKeeping leaves the kept kinds in the log).
    const removed = events.filter(
      (e) => e.sequence >= 1 && e.sequence <= through && !(keptBelow && keep.has(e.eventType))
    );
    // A store that cannot remove the tip (a hash chain keeps it as the chain's anchor, ADR 0138 H1)
    // leaves `[0, tip]` after a compaction through the tip. Called again with nothing new, the only
    // removable event is that tip, already checkpointed and archived: report nothing to do instead of
    // re-reading the archive and saving an identical checkpoint on every call.
    if (
      gap >= 0 &&
      removed.length === 1 &&
      removed[0]!.sequence === through &&
      through === events[tipIndex]!.sequence &&
      (await this.snapshotStore.loadAt(executionId, through)) !== null
    ) {
      const headers = await archive.headers(executionId);
      // A reused-id leftover is a signal, not a no-op: refuse it here as `archiveRemoved` would.
      const foreign = headers.find((h) => h.incarnation !== incarnation);
      if (foreign !== undefined) {
        throw new ArchiveIncarnationError(executionId, foreign.incarnation, incarnation);
      }
      if (headers.length > 0 && headers[headers.length - 1]!.through >= through) return null;
    }

    // The fold at `through`, on the latest snapshot at or below it when there is one — which
    // a gapped (compacted) log MUST have.
    const base = await this.snapshotStore.loadLatestBefore(executionId, through);
    if (gap >= 0 && (base === null || base.sequence < gap)) {
      throw new CompactionCheckpointMissingError(executionId, gap);
    }
    let workflowVersion = base?.state.workflowVersion ?? "";
    if (workflowVersion === "") {
      // Not an event fact: a pre-0106 checkpoint carries it blank, so ask the latest snapshot
      // (the runtime checkpoints every suspend) before settling for "unrecorded".
      workflowVersion =
        (await this.snapshotStore.loadLatest(executionId))?.state.workflowVersion ?? "";
    }
    const identity = { executionId, workflowId: events[0]!.workflowId, workflowVersion };
    // Fill blanks (a pre-0106 checkpoint), refuse a non-blank mismatch — the same rule the
    // runtime applies when it seeds a fold from a snapshot.
    if (base !== null) assertSnapshotIdentity(base.state, executionId, identity.workflowId);
    const state =
      base !== null
        ? new ReplayVM(
            events.filter((e) => e.sequence > base.sequence && e.sequence <= through),
            { ...normalizeSnapshotState(base.state), ...identity }
          ).getState()
        : new ReplayVM(events.slice(0, at + 1), identity).getState();

    // ADR 0138 — ARCHIVE FIRST. The exact envelopes the truncation will remove are appended to the
    // archive before the checkpoint is saved and before anything is truncated, so a crash anywhere
    // after this line leaves the events in the log AND (at most) a duplicate in the archive, which a
    // re-compaction recognises as already archived and does not re-append. Never a gap.
    await this.archiveRemoved(
      executionId,
      archive,
      incarnation,
      removed,
      through,
      gap >= 0 ? { events, gap, base: base! } : undefined
    );

    const snapshot: Snapshot = {
      // The archiving-compaction mark (ADR 0138): how a later reader tells "its archive was lost"
      // from "compacted before the archive existed" (`archiveCoverage`, the content sweep).
      id: `${COMPACTION_CHECKPOINT_ID_PREFIX}${ulid()}`,
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

  /**
   * ADR 0138 — append the envelopes a compaction is about to remove to the archive, and return
   * nothing. Tolerant of an earlier attempt that archived but crashed before truncating: anything at
   * or below the archive's last `through` must already be there, byte-for-byte (verified, fail
   * closed); only the rest is appended, as ONE segment starting right after the archive's last.
   */
  private async archiveRemoved(
    executionId: string,
    archive: ArchiveStore,
    incarnation: string,
    removed: readonly EventEnvelope[],
    through: number,
    compacted?: { events: readonly EventEnvelope[]; gap: number; base: Snapshot }
  ): Promise<void> {
    if (removed.length === 0) return;
    let headers = await archive.headers(executionId);
    // A run of another incarnation of this id (reused after a delete) is never extended or relied on.
    const foreign = headers.find((h) => h.incarnation !== incarnation);
    if (foreign !== undefined) {
      throw new ArchiveIncarnationError(executionId, foreign.incarnation, incarnation);
    }
    // B2 - a log compacted BEFORE the archive existed: its checkpoint's folded state is the only
    // copy of the settled steps' inputs the earlier compactions removed, and this compaction's next
    // checkpoint is normalized (inputs stripped). Preserve that checkpoint byte-exact as a typed
    // legacy segment FIRST, so the fact stays recoverable without depending on GC or snapshot pruning.
    if (compacted !== undefined) {
      const firstMissing = lowestMissing(compacted.events);
      const first = headers[0];
      if (firstMissing !== -1 && first === undefined) {
        await this.archiveLegacyCheckpoint(
          executionId,
          archive,
          incarnation,
          compacted,
          firstMissing
        );
        headers = await archive.headers(executionId);
      } else if (firstMissing !== -1 && first !== undefined && first.from > firstMissing) {
        // Segments exist but start above the oldest gap: nothing can be appended before them.
        const lost: number[] = [];
        for (let q = firstMissing; q < first.from && lost.length < 50; q++) lost.push(q);
        throw new ArchiveGapError(executionId, lost);
      }
    }
    await appendMoved(archive, executionId, incarnation, headers, removed, through);
  }

  /** B2 - archive the anchor checkpoint of a pre-archive compacted log as a `legacy-checkpoint` segment. */
  private async archiveLegacyCheckpoint(
    executionId: string,
    archive: ArchiveStore,
    incarnation: string,
    c: { events: readonly EventEnvelope[]; gap: number; base: Snapshot },
    firstMissing: number
  ): Promise<void> {
    // The anchor: the lowest snapshot at or above the gap (the checkpoint a pre-archive compaction
    // wrote), found the way `pruneSnapshots` finds it. It folds every event at or below the gap.
    let anchor: Snapshot | null = null;
    let s: Snapshot | null = c.base;
    while (s !== null && s.sequence >= c.gap) {
      anchor = s;
      s =
        s.sequence > c.gap
          ? await this.snapshotStore.loadLatestBefore(executionId, s.sequence - 1)
          : null;
    }
    if (anchor === null) throw new CompactionCheckpointMissingError(executionId, c.gap);
    const envelope: EventEnvelope = {
      id: `${executionId}-legacy-checkpoint-${anchor.sequence}`,
      workflowId: c.events[0]!.workflowId,
      executionId,
      eventType: ARCHIVE_LEGACY_CHECKPOINT_EVENT,
      sequence: anchor.sequence,
      timestamp: 0,
      payload: { snapshot: anchor },
    };
    await archive.append(
      executionId,
      buildSegment([envelope], incarnation, firstMissing, c.gap, "legacy-checkpoint")
    );
  }

  /** ADR 0138 — the compaction archive's segment headers for an execution, ascending (cheap: no bodies). */
  async archiveHeaders(executionId: string): Promise<ArchiveSegmentHeader[]> {
    return (await this.options.compactionArchive?.headers(executionId)) ?? [];
  }

  /**
   * ADR 0138 B2 - what the archive and the surviving log together can and cannot show. `unarchived`
   * lists every range of the ORIGINAL log that neither holds as events: `why: "legacy"` for a range a
   * pre-ADR-0138 compaction removed (its folded checkpoint is preserved, see
   * {@link readLegacyCheckpoints}), `"missing"` for anything else. An empty list is a complete
   * original log. Reads the whole surviving log.
   *
   * `"legacy"` vs `"missing"` (ADR 0138 D21): an uncovered range reads `"missing"` (an archive LOSS: it
   * was wiped, swapped for an empty one, or truncated) when the checkpoint at the log's extent was
   * written by an archiving compaction (its id carries `COMPACTION_CHECKPOINT_ID_PREFIX`), and
   * `"legacy"` (compacted before the archive existed) when it was not. The mark is read back through
   * the snapshot store, which may return a different same-sequence snapshot or none (pruned): then the
   * range reads `"legacy"`. Evidence, not proof. Read through the same decorated event-store stack the
   * compaction used (see {@link readArchived}).
   */
  async archiveCoverage(
    executionId: string
  ): Promise<{ segments: ArchiveSegmentHeader[]; unarchived: UnarchivedRange[] }> {
    const live = await this.eventStore.read(executionId);
    return this.coverageOf(executionId, live);
  }

  private async coverageOf(
    executionId: string,
    live: readonly EventEnvelope[]
  ): Promise<{ segments: ArchiveSegmentHeader[]; unarchived: UnarchivedRange[] }> {
    const segments = await this.archiveHeaders(executionId);
    if (live.length === 0) return { segments, unarchived: [] };
    let extent = highestMissing(live);
    if (live.length === 1) {
      // Compacted through the tip leaves `[0]`: the checkpoint above it names the extent.
      extent = Math.max(extent, (await this.snapshotStore.loadLatest(executionId))?.sequence ?? -1);
    }
    const covered = segments.filter((h) => h.kind !== "legacy-checkpoint");
    // The checkpoint sitting at the extent is the last compaction's own. When an ARCHIVING compaction
    // wrote it (the id mark), the removed range was handed to an archive: a range no segment covers
    // is then a LOSS (`missing`: the archive was wiped, swapped or truncated), not a pre-0138 remnant.
    // Best effort: a checkpoint that was pruned, replaced, or shadowed by a same-sequence snapshot the
    // store prefers cannot testify, and reads as `legacy`.
    // Two snapshots can share the extent's sequence (the runtime's own suspend checkpoint, then the
    // compaction's); which one a read returns on a tie is the store's choice, so both probes are tried.
    let archivedRange = false;
    if (extent >= 1) {
      const below = await this.snapshotStore.loadLatestBefore(executionId, extent);
      const exact = below?.sequence === extent ? below : null;
      archivedRange =
        isArchivingCompactionCheckpointId(exact?.id) ||
        isArchivingCompactionCheckpointId(
          (await this.snapshotStore.loadAt(executionId, extent))?.id
        );
    }
    const legacy = segments.filter((h) => h.kind === "legacy-checkpoint");
    const unarchived: UnarchivedRange[] = [];
    // Runs of sequences in [1..extent] the surviving log does not hold.
    const runs: Array<[number, number]> = [];
    let prev = 0;
    for (const e of live) {
      if (e.sequence === 0) continue;
      if (e.sequence > extent + 1) break;
      if (e.sequence - prev > 1) runs.push([prev + 1, e.sequence - 1]);
      prev = e.sequence;
    }
    if (prev < extent) runs.push([prev + 1, extent]);
    for (const [a, b] of runs) {
      for (const [x, y] of subtractRanges([a, b], covered)) {
        for (const [p, q] of intersectRanges([x, y], legacy)) {
          unarchived.push({ from: p, through: q, why: "legacy" });
        }
        for (const [p, q] of subtractRanges([x, y], legacy)) {
          unarchived.push({ from: p, through: q, why: archivedRange ? "missing" : "legacy" });
        }
      }
    }
    unarchived.sort((l, r) => l.from - r.from);
    return { segments, unarchived };
  }

  /**
   * ADR 0138 B2 - the checkpoints of a log compacted BEFORE the archive existed, preserved byte-exact
   * (the settled steps' inputs of the removed events live only in their folded state). Empty for an
   * execution that was never compacted that way.
   */
  async readLegacyCheckpoints(executionId: string): Promise<Snapshot[]> {
    const archive = this.options.compactionArchive;
    if (archive === undefined) return [];
    const out: Snapshot[] = [];
    for (const seg of await archive.read(executionId)) {
      if (seg.kind !== "legacy-checkpoint") continue;
      assertSegmentDigest(executionId, seg);
      for (const e of seg.envelopes) out.push((e.payload as { snapshot: Snapshot }).snapshot);
    }
    return out;
  }

  /**
   * ADR 0138 — the events compaction MOVED out of the log, byte-exact and in sequence order, each
   * segment verified against its recorded digest ({@link ArchiveDigestError} when one was altered).
   * `range` is inclusive and filters by event sequence. Together with the surviving log
   * (`eventStore.read`) this is the original log; {@link readWithArchive} stitches them. This is the
   * ONLY path that reads the archive: `readRange`, replay, resume and every sweep never touch it.
   * Resolves `[]` when no archive is configured or nothing was archived.
   *
   * Throws {@link ArchiveIncarnationError} when the archive holds a different run of a REUSED id, and
   * {@link ArchiveIncompleteError} when `range` includes events nothing can return (a pre-ADR-0138
   * compaction's range, or an archive that lost its segments; see {@link archiveCoverage}) unless
   * `allowIncomplete: true`.
   *
   * WHICH STORE READS: the archive's `incarnation` is the digest of the log's bootstrap envelope AS THE
   * READING EVENT STORE PRESENTS IT, so construct this lifecycle over the same decorated event-store
   * stack the compaction used (or one presenting the same bootstrap bytes: the sealing store decrypts
   * to the same envelope). A view that rewrites the bootstrap reads as a foreign incarnation and is
   * refused ({@link ArchiveIncarnationError}), never silently mixed (ADR 0138 D22).
   */
  async readArchived(
    executionId: string,
    range: { readonly from?: number; readonly through?: number } = {},
    opts: { readonly allowIncomplete?: boolean } = {}
  ): Promise<EventEnvelope[]> {
    const archive = this.options.compactionArchive;
    if (archive === undefined) return [];
    const live = opts.allowIncomplete === true ? [] : await this.eventStore.read(executionId);
    return this.readArchivedWith(executionId, archive, range, live, opts.allowIncomplete === true);
  }

  private async readArchivedWith(
    executionId: string,
    archive: ArchiveStore,
    range: { readonly from?: number; readonly through?: number },
    live: readonly EventEnvelope[],
    allowIncomplete: boolean
  ): Promise<EventEnvelope[]> {
    const headers = await archive.headers(executionId);
    const head =
      live.length > 0 ? live[0]! : (await readRangeOf(this.eventStore, executionId, 0, 0))[0];
    const incarnation = head === undefined ? undefined : segmentDigest([head]);
    // Verified AFTER the segments open (below): a shredded subject's archive reports the shred, not a
    // misleading "reused id" (the redacted bootstrap digests differently).
    if (!allowIncomplete) {
      const { unarchived } = await this.coverageOf(executionId, live);
      const hit = unarchived.filter(
        (r) =>
          (range.from === undefined || r.through >= range.from) &&
          (range.through === undefined || r.from <= range.through)
      );
      if (hit.length > 0) throw new ArchiveIncompleteError(executionId, hit);
    }
    const out: EventEnvelope[] = [];
    const segments = await archive.read(executionId, range);
    if (incarnation !== undefined) {
      const foreign = headers.find((h) => h.incarnation !== incarnation);
      if (foreign !== undefined) {
        throw new ArchiveIncarnationError(executionId, foreign.incarnation, incarnation);
      }
    }
    for (const seg of segments) {
      assertSegmentDigest(executionId, seg);
      if (seg.kind === "legacy-checkpoint") continue; // a checkpoint, not events: readLegacyCheckpoints
      for (const e of seg.envelopes) {
        if (
          (range.from === undefined || e.sequence >= range.from) &&
          (range.through === undefined || e.sequence <= range.through)
        ) {
          out.push(e);
        }
      }
    }
    return out;
  }

  /**
   * ADR 0138 — the original log: {@link readArchived} merged with the surviving log, ascending, one
   * entry per sequence. A crash between "archive" and "truncate" leaves a duplicate, and the two
   * copies must be byte-identical: a sequence the archive and the log hold DIFFERENTLY throws
   * {@link ArchiveLogMismatchError} (neither is taken as the original). The audit read: a hash chain
   * verifies across a compaction on this, not on `eventStore.read`. Throws
   * {@link ArchiveIncompleteError} like {@link readArchived} unless `allowIncomplete: true`.
   */
  async readWithArchive(
    executionId: string,
    opts: { readonly allowIncomplete?: boolean } = {}
  ): Promise<EventEnvelope[]> {
    const live = await this.eventStore.read(executionId);
    const archived =
      this.options.compactionArchive === undefined
        ? []
        : await this.readArchivedWith(
            executionId,
            this.options.compactionArchive,
            {},
            live,
            opts.allowIncomplete === true
          );
    return stitchArchived(executionId, archived, live);
  }

  /**
   * ADR 0139 - what a RESERVED stream's archive and surviving log together can and cannot show. A
   * reserved stream (an inbox, a topic stream, the quarantine copies) is never checkpointed; a trim
   * MOVES its consumed prefix to the archive, so the removed range is what the stream's sequences skip
   * from its first possible one (`INBOX_TOPIC_SEQ_BASE` for a topic stream, else 1) up to its extent: the
   * surviving stream's tip, or, once the stream is DELETED (nothing live), the archive's own last
   * sequence - a deleted stream whose archive skips a range (a trim before the archive existed, a wiped
   * segment) is just as incomplete. `why` is `"legacy"` when the archive holds nothing for the stream
   * (trimmed before it archived) and `"missing"` when it holds some but not this range. `lateRuns` lists
   * the late runs ({@link reservedLateKey}) split from the stream, with their headers.
   */
  async reservedArchiveCoverage(streamId: string): Promise<{
    segments: ArchiveSegmentHeader[];
    unarchived: UnarchivedRange[];
    lateRuns: Array<{ key: string; n: number; segments: ArchiveSegmentHeader[] }>;
  }> {
    const live = await this.eventStore.read(streamId);
    return this.reservedCoverageOf(streamId, live);
  }

  /** The late runs of `streamId` (`<stream>@1`, `@2`, ...; they are allocated contiguously from 1). */
  private async lateRunsOf(
    streamId: string
  ): Promise<Array<{ key: string; n: number; segments: ArchiveSegmentHeader[] }>> {
    const archive = this.options.compactionArchive;
    if (archive === undefined) return [];
    const out: Array<{ key: string; n: number; segments: ArchiveSegmentHeader[] }> = [];
    for (let n = 1; n <= 64; n++) {
      const key = reservedLateKey(streamId, n);
      const segments = await archive.headers(key);
      if (segments.length === 0) break;
      out.push({ key, n, segments });
    }
    return out;
  }

  private async reservedCoverageOf(
    streamId: string,
    live: readonly EventEnvelope[]
  ): Promise<{
    segments: ArchiveSegmentHeader[];
    unarchived: UnarchivedRange[];
    lateRuns: Array<{ key: string; n: number; segments: ArchiveSegmentHeader[] }>;
  }> {
    const segments = await this.archiveHeaders(streamId);
    const lateRuns = await this.lateRunsOf(streamId);
    const first = isInboxTopicStreamId(streamId) ? INBOX_TOPIC_SEQ_BASE : 1;
    const runs: Array<[number, number]> = [];
    if (live.length === 0) {
      // Deleted (or never written): the extent is whatever the archive moved.
      const archived = segments.length > 0 ? segments[segments.length - 1]!.through : -1;
      if (archived >= first) runs.push([first, archived]);
    } else {
      const extent = live[live.length - 1]!.sequence;
      let prev = first - 1;
      for (const e of live) {
        if (e.sequence < first) continue;
        if (e.sequence - prev > 1) runs.push([prev + 1, e.sequence - 1]);
        prev = e.sequence;
      }
      if (prev < extent) runs.push([prev + 1, extent]);
    }
    const unarchived: UnarchivedRange[] = [];
    for (const [a, b] of runs) {
      for (const [x, y] of subtractRanges([a, b], segments)) {
        unarchived.push({ from: x, through: y, why: segments.length === 0 ? "legacy" : "missing" });
      }
    }
    return { segments, unarchived, lateRuns };
  }

  /**
   * ADR 0139 - the original RESERVED stream: the envelopes a trim or delete MOVED to the archive
   * (digest-verified; an archive of another run of the chain refuses) merged with the surviving stream,
   * ascending, one entry per sequence, duplicates compared byte-exact (`events`), PLUS every late run
   * split from it (`lateRuns`: stragglers a raced send or a node without an archive floor wrote at a
   * sequence the archive already held, kept separately and tagged by their run key). A removed range
   * nothing holds throws {@link ArchiveIncompleteError} unless `allowIncomplete: true`.
   */
  async readReservedWithArchive(
    streamId: string,
    opts: { readonly allowIncomplete?: boolean } = {}
  ): Promise<{
    events: EventEnvelope[];
    lateRuns: Array<{ key: string; n: number; events: EventEnvelope[] }>;
  }> {
    const archive = this.options.compactionArchive;
    const live = await this.eventStore.read(streamId);
    if (archive === undefined) return { events: live, lateRuns: [] };
    if (opts.allowIncomplete !== true) {
      const { unarchived } = await this.reservedCoverageOf(streamId, live);
      if (unarchived.length > 0) throw new ArchiveIncompleteError(streamId, unarchived);
    }
    const archived: EventEnvelope[] = [];
    for (const seg of await archive.read(streamId)) {
      assertReservedSegmentDigest(streamId, seg);
      archived.push(...seg.envelopes);
    }
    // Verified AFTER the segments open: a shredded owner reports the shred, not a "foreign run".
    const incarnation = await reservedIncarnationOf(this.eventStore, streamId);
    const headers = await archive.headers(streamId);
    const foreign = headers.find((h) => h.incarnation !== incarnation);
    if (foreign !== undefined) {
      throw new ArchiveIncarnationError(streamId, foreign.incarnation, incarnation);
    }
    const lateRuns: Array<{ key: string; n: number; events: EventEnvelope[] }> = [];
    for (const run of await this.lateRunsOf(streamId)) {
      lateRuns.push({
        key: run.key,
        n: run.n,
        events: await this.readLateRun(run.key, incarnation),
      });
    }
    return { events: stitchArchived(streamId, archived, live), lateRuns };
  }

  private async readLateRun(key: string, incarnation: string): Promise<EventEnvelope[]> {
    const events: EventEnvelope[] = [];
    for (const seg of (await this.options.compactionArchive?.read(key)) ?? []) {
      assertReservedSegmentDigest(key, seg);
      if (seg.incarnation !== incarnation) {
        throw new ArchiveIncarnationError(key, seg.incarnation, incarnation);
      }
      events.push(...seg.envelopes);
    }
    return events;
  }

  /**
   * ADR 0139 - the reserved streams (inbox, topic streams, registry, quarantine) of the chain the
   * execution is the generation-0 head of, with what the archive recovers of each: the moved envelopes
   * and every range nothing can return; a late run is listed as its own entry (its `streamId` is the late
   * key, no `unarchived`). `[]` for an execution that is not a chain's first (its chain's streams belong
   * to that one) or when no archive is configured. Used by `exportSubject`.
   */
  async readReservedArchive(
    executionId: string
  ): Promise<Array<{ streamId: string; events: EventEnvelope[]; unarchived: UnarchivedRange[] }>> {
    const archive = this.options.compactionArchive;
    if (archive === undefined) return [];
    const bootstrap = (await readRangeOf(this.eventStore, executionId, 0, 0))[0];
    if (bootstrap === undefined || chainIdOfFirst(bootstrap, executionId) !== executionId)
      return [];
    const streams = await archivedReservedStreams(archive, executionId);
    const out: Array<{ streamId: string; events: EventEnvelope[]; unarchived: UnarchivedRange[] }> =
      [];
    const incarnation = await reservedIncarnationOf(
      this.eventStore,
      `${INBOX_STREAM_PREFIX}${executionId}`
    );
    for (const streamId of streams) {
      const isLate = reservedLateOrigin(streamId) !== undefined;
      const unarchived = isLate
        ? []
        : (await this.reservedCoverageOf(streamId, await this.eventStore.read(streamId)))
            .unarchived;
      const events: EventEnvelope[] = [];
      for (const seg of await archive.read(streamId)) {
        assertReservedSegmentDigest(streamId, seg);
        if (seg.incarnation !== incarnation) {
          throw new ArchiveIncarnationError(streamId, seg.incarnation, incarnation);
        }
        events.push(...seg.envelopes);
      }
      out.push({ streamId, events, unarchived });
    }
    return out;
  }

  /**
   * ADR 0134 — prune the snapshots a newer one has superseded. DEFAULT OFF: nothing calls this
   * unless an operator or an app's own schedule does. Snapshots are a cache over the log, so a
   * deleted one costs a longer fold, never the state, with these exceptions, which are never
   * pruned:
   *
   * - **The latest `keepLatest` snapshots** (default 1; the latest is what a resume folds on).
   * - **Everything at or below a compacted log's anchor.** When the log has a gap, its
   *   checkpoint (the lowest snapshot at or above the gap) is the ONLY record of the state
   *   below it, and the snapshots below the gap are the exact fork points ADR 0107 D2 serves.
   *   A log compacted down to `[0]` keeps every snapshot, for the same reason.
   * - **`keepSequences`**, an explicit keep-set from the caller.
   *
   * So only snapshots strictly ABOVE the anchor (or any, for a never-compacted log) and strictly
   * BELOW the `keepLatest`-th newest are deleted. Every fork point the log could serve before is
   * served after, with the same state: a base above the gap folds a contiguous suffix.
   *
   * Resolves with the number deleted; `0` when the store cannot prune, the execution is exempt
   * (`compactionExempt`: a hold also holds its snapshots), there is nothing prunable, or a
   * compaction from another process landed while it was deciding (nothing deleted; retry).
   * Serialized with `compact` per execution WITHIN ONE LogLifecycle INSTANCE (not across instances
   * or processes; a `pinned`/`compactionExempt` callback calling either on the same execution hangs). Two instances or PROCESSES must not run them on
   * one execution at once (ADR 0134 D6). Refuses with {@link BlankStreamUnrepairedError} while
   * the pre-0106 blank stream still has events to re-home, and with a `RangeError` for a
   * `keepSequences` entry that is not a safe integer. Costs two log reads (before and after the
   * snapshot reads), `keepLatest` snapshot point reads, plus a walk of the snapshots above the
   * gap (O(snapshots above the gap)) only for a gapped log with neither a snapshot at its gap
   * nor a fork seed; one `head` read of `""` plus, when a blank stream exists, the blank-stream census (every execution), memoized per instance while `""` is unchanged (`acceptUnattributedBlankStream` accepts unattributed runs only). The delete is one statement.
   */
  pruneSnapshots(executionId: string, options: PruneSnapshotsOptions = {}): Promise<number> {
    // ADR 0134 D6 - serialized with `compact` on the same execution (within this instance).
    return this.withExecution(executionId, () => this.pruneOnce(executionId, options));
  }

  private async pruneOnce(executionId: string, options: PruneSnapshotsOptions): Promise<number> {
    if (executionId === "" || isReservedStream(executionId)) {
      throw new TypeError(
        `refusing to prune the snapshots of "${executionId}": a blank id or a reserved control stream names no execution.`
      );
    }
    const keepLatest = options.keepLatest ?? 1;
    if (!Number.isInteger(keepLatest) || keepLatest < 1) {
      throw new RangeError(
        `pruneSnapshots: keepLatest must be an integer >= 1 (the latest snapshot is never pruned); got ${String(keepLatest)}`
      );
    }
    // The SPI takes safe integers; backends disagree about anything else (Postgres throws on 3.5,
    // SQLite ignores NaN, memory deletes). Refused here, before any read or delete.
    const keepSequences = options.keepSequences ?? [];
    for (const k of keepSequences) {
      if (!Number.isSafeInteger(k)) {
        throw new RangeError(
          `pruneSnapshots: every keepSequences entry must be a safe integer; got ${String(k)}`
        );
      }
    }
    const snapshots = this.snapshotStore;
    if (snapshots.pruneSnapshots === undefined) return 0;
    if (
      this.options.compactionExempt !== undefined &&
      (await this.options.compactionExempt(executionId)) === true
    ) {
      return 0;
    }
    await this.assertBlankStreamRepaired(options.acceptUnattributedBlankStream === true);
    const events = await this.eventStore.read(executionId);
    // Nothing to anchor on, or compacted through the tip (`[0]`): the checkpoint is the latest
    // snapshot and the older ones are the exact fork points below it.
    if (events.length <= 1) return 0;
    const tip = events[events.length - 1]!.sequence;
    const gap = highestMissing(events);

    // `before`: the sequence of the keepLatest-th newest snapshot, which pruning must not reach.
    let newest = await snapshots.loadLatest(executionId);
    if (newest === null) return 0;
    for (let i = 1; i < keepLatest; i++) {
      newest =
        newest.sequence > 0
          ? await snapshots.loadLatestBefore(executionId, newest.sequence - 1)
          : null;
      if (newest === null) return 0; // fewer than keepLatest snapshots: all are kept
    }
    const before = newest.sequence;
    if (!Number.isSafeInteger(before)) {
      throw new RangeError(
        `pruneSnapshots: the snapshot store reported sequence ${String(before)}`
      );
    }

    // `after`: the anchor of a compacted log, or -1 (the whole range) for a gap-free one.
    let after = -1;
    if (gap >= 0) {
      // Same lookup as the content sweep: a compaction's own checkpoint sits exactly at the gap;
      // a branch of a compacted parent has its fork seed (sequence 0 records it); else walk down.
      let anchor = await snapshots.loadLatestBefore(executionId, gap);
      const forkSequence = (events[0]!.metadata as { forkSequence?: unknown } | undefined)
        ?.forkSequence;
      if (
        (anchor === null || anchor.sequence !== gap) &&
        typeof forkSequence === "number" &&
        forkSequence >= gap
      ) {
        const seed =
          snapshots.loadAt !== undefined
            ? await snapshots.loadAt(executionId, forkSequence)
            : await snapshots.loadLatestBefore(executionId, forkSequence);
        anchor = seed !== null && seed.sequence === forkSequence ? seed : anchor;
      }
      if (anchor === null || anchor.sequence < gap) {
        anchor = null;
        let s = await snapshots.loadLatestBefore(executionId, Math.max(tip, before));
        while (s !== null && s.sequence >= gap) {
          anchor = s;
          s =
            s.sequence > gap ? await snapshots.loadLatestBefore(executionId, s.sequence - 1) : null;
        }
      }
      // No checkpoint at or above the gap: `compact` would refuse this log. Prune nothing.
      if (anchor === null) return 0;
      after = anchor.sequence;
      if (!Number.isSafeInteger(after)) {
        throw new RangeError(
          `pruneSnapshots: the snapshot store reported sequence ${String(after)}`
        );
      }
    }
    if (before - after <= 1) return 0;
    // The bounds were derived from a log read BEFORE the snapshot reads above. A compaction in
    // another process may have landed since (this process's own is excluded): a gap that moved
    // means `after` no longer protects the new checkpoint, so delete nothing. Retry later.
    const again = await this.eventStore.read(executionId);
    if (highestMissing(again) !== gap) return 0;
    return snapshots.pruneSnapshots(executionId, { after, before }, [...keepSequences]);
  }

  /**
   * ADR 0134 D6 - refuse while `loom repair blank-stream` still has work. The repair LEAVES the
   * blank stream in place as evidence, so "repaired" is not "empty": one `head` read says whether
   * a blank stream exists at all (the common case: it does not), and only then the census says
   * whether any segment is still re-homable or any run unattributed. The census enumerates every
   * execution, so a verdict with no re-homable segment is remembered (see `blankVerdict`) and
   * trusted while the head of `""` is the one it was taken at.
   */
  private async assertBlankStreamRepaired(acceptUnattributed: boolean): Promise<void> {
    const head = await headOf(this.eventStore, "");
    if (head === null) return;
    const v = this.blankVerdict;
    // A cached verdict that would REFUSE is not trusted: it is re-derived, so a refusal is never stale.
    if (v !== null && v.head === head && (v.unattributed === 0 || acceptUnattributed)) return;
    if (
      this.eventStore.listExecutions === undefined &&
      this.eventStore.listExecutionsPage === undefined
    ) {
      throw new BlankStreamCensusUnavailableError();
    }
    const census = await this.blankStreamCensus();
    const rehomable = census.segments.filter((x) => x.status === "rehomable").length;
    if (rehomable === 0) this.blankVerdict = { head, unattributed: census.unattributed.length };
    if (rehomable > 0 || (census.unattributed.length > 0 && !acceptUnattributed)) {
      throw new BlankStreamUnrepairedError(rehomable, census.unattributed.length);
    }
  }

  /**
   * ADR 0116 migration — restore the terminal event a pre-0116 compaction took off the log.
   *
   * Before ADR 0116, compacting a finished execution truncated THROUGH its tip: the log was left
   * as `[0]` and the checkpoint (at the terminal sequence `T`) held the whole fold. Such an
   * execution can never receive a late outcome — `recordOutcome` refuses it, because the one valid
   * slot (`head + 1`) lies BELOW the checkpoint and would be invisible to every fold — and
   * retention cannot date its end from the log.
   *
   * This writes the missing terminal event at `T + 1`, ABOVE the checkpoint, so the fold stays
   * `snapshot(T) + [event T+1]`: an `EXECUTION_COMPLETED` / `_FAILED` / `_CANCELLED` (by the folded
   * status) with an EMPTY payload, the timestamp the fold already holds (`updatedAt`), and
   * `metadata.kernel` + `metadata.restoredTerminal`. Every terminal handler leaves a terminal state
   * unchanged on an empty payload, so the folded state is byte-identical except `sequence`.
   *
   * - **Idempotent**: once the head reaches the folded sequence there is nothing to restore
   *   (`intact`), so a re-run (or a log that was never compacted) writes nothing.
   * - **Refuses non-terminal executions** (`not-terminal`) and `continued` ones (the successor id
   *   is unrecoverable from nothing; a continued execution takes no late outcome anyway).
   * - **Never supersedes a live holder**: on a fencing store the token is taken by compare-and-set
   *   on the observed `{head, fence}` (`acquireFenceIf`), and a refusal reports `busy` (nothing
   *   written, retry later). A store without the CAS refuses a fenced execution (`busy`) unless
   *   `force: true`.
   * - **Dry by default**: `apply: true` writes. Run it with the execution quiesced: the slot is
   *   written with the ordinary `append` (a conditional append may only take `head + 1`, and the
   *   slot above a checkpoint is by definition not that), under a freshly acquired fence token on a
   *   fencing store, after re-reading the tip; a writer that wins the slot makes the append throw
   *   rather than overwrite.
   */
  async restoreTerminalEvent(
    executionId: string,
    opts: { apply?: boolean; force?: boolean } = {}
  ): Promise<RestoreTerminalResult> {
    if (executionId === "" || isReservedStream(executionId)) {
      return { executionId, status: "not-an-execution" };
    }
    const store = this.eventStore;
    const first = await readRangeOf(store, executionId, 0, 0);
    if (first.length === 0) return { executionId, status: "missing" };
    const head = (await headOf(store, executionId)) ?? 0;
    const snapshot = await this.snapshotStore.loadLatest(executionId);
    if (snapshot === null || snapshot.sequence <= head) return { executionId, status: "intact" };
    assertSnapshotIdentity(snapshot.state, executionId, first[0]!.workflowId);
    const tail = await store.readFrom(executionId, snapshot.sequence + 1);
    const state = new ReplayVM(tail, {
      ...normalizeSnapshotState(snapshot.state),
      executionId,
      workflowId: first[0]!.workflowId,
    }).getState();
    const eventType = RESTORABLE_TERMINAL[state.status];
    if (eventType === undefined) {
      return { executionId, status: "not-terminal", foldedStatus: state.status };
    }
    const sequence = state.sequence + 1;
    if (opts.apply !== true) return { executionId, status: "would-restore", sequence, eventType };
    const envelope = (fence?: number): EventEnvelope => ({
      id: `${executionId}-${sequence}`,
      workflowId: first[0]!.workflowId,
      executionId,
      eventType,
      sequence,
      timestamp: state.updatedAt,
      payload: {},
      metadata: { kernel: true, restoredTerminal: true, ...(fence !== undefined && { fence }) },
    });
    const busy = (reason: string): RestoreTerminalResult => ({
      executionId,
      status: "busy",
      reason,
    });
    const stale = async (): Promise<boolean> => ((await headOf(store, executionId)) ?? 0) !== head;
    if (store.appendIfUnchanged !== undefined && store.acquireFenceIf !== undefined) {
      // A fencing store: never supersede a live holder. Observe {head, fence}, then take the token
      // by compare-and-set on EXACTLY that observation (refused if the token moved or an
      // answering event landed), and re-read the tip once it is ours.
      const seen = await store.appendIfUnchanged(executionId, null);
      if (seen.appended) throw new Error("appendIfUnchanged(null) must be a pure observation");
      if (seen.head === null) return { executionId, status: "missing" };
      if (seen.head !== head)
        return busy("the tip moved while the terminal event was being restored");
      const got = await store.acquireFenceIf(executionId, { fence: seen.fence, parkSeq: head });
      if ("stale" in got) return busy("the fence token moved (a live holder or another writer)");
      if (await stale()) return busy("the tip moved after the fence token was acquired");
      try {
        await store.append(envelope(got.fence));
      } catch (err) {
        if (isStaleFence(err)) return busy("the fence token was superseded");
        throw err;
      }
    } else {
      // Quiesced means the tip has not moved since the fold above; check it again at the write.
      if (await stale()) return busy("the tip moved while the terminal event was being restored");
      try {
        await store.append(envelope());
      } catch (err) {
        // A fence row exists (token > 0): a store that cannot CAS the token can only supersede
        // whoever holds it, so that takes an explicit force.
        if (!isStaleFence(err) || store.acquireFence === undefined) throw err;
        if (opts.force !== true) {
          return busy(
            "the execution carries a fence token and the store cannot compare-and-set it; re-run with force"
          );
        }
        await store.append(envelope(await store.acquireFence(executionId)));
      }
    }
    return { executionId, status: "restored", sequence, eventType };
  }
}
